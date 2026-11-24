import test from 'node:test';
import assert from 'node:assert/strict';
import { unverified, type Profile } from '../lib/ai-config';
import { DEFAULT_XHS_RULES, executionSchema, effectiveRules } from '../lib/xhs-hotspot-rules';
import { changedRuleFields, mergeRuleProposal } from '../lib/xhs-rule-draft';
import { inspectRuleDemand, type RuleDemandIntent } from '../lib/xhs-rule-demand';
import { aiTransport } from '../lib/server/ai/provider';
import { generateXhsRuleDraft } from '../lib/server/xhs-rules-ai';

const profile: Profile = { id:'fixture',revision:'1',name:'fixture',provider:'custom',protocol:'responses',baseUrl:'https://example.com/v1',apiKey:'synthetic-test-key',model:'fixture-model',timeoutSeconds:15,maxOutputTokens:8000,jsonMode:'schema',textTest:unverified(),imageTest:unverified() };
const demand = '找川西和新疆旅游，图片有胶片氛围感，文字文艺情绪，有旅行思考的近期热门主题和笔记';
const intent: RuleDemandIntent = { summary:'川西、新疆的胶片氛围与文艺旅行思考',retrievalMode:'rebuild',requirements:[
  {kind:'region',source:'川西',keyword:'川西'}, {kind:'region',source:'新疆',keyword:'新疆'},
  {kind:'subject',source:'旅游',keyword:'旅游'}, {kind:'expression',source:'胶片氛围感',keyword:'胶片'},
  {kind:'expression',source:'胶片氛围感',keyword:'氛围'}, {kind:'expression',source:'文艺情绪',keyword:'文艺'},
  {kind:'expression',source:'文艺情绪',keyword:'情绪'}, {kind:'expression',source:'旅行思考',keyword:'旅行思考'},
] };
function fixture() {
  const rules=structuredClone(DEFAULT_XHS_RULES);
  rules.categories.travel={...rules.categories.travel,queries:['川西','新疆'],includeTerms:['旅行','旅游','自驾','氛围','胶片','情绪'],topics:[]};
  const original={...rules.categories.travel,requireDestination:true,minThemeInteractions:2000,overlapPercent:80,settings:executionSchema.parse(effectiveRules(rules,'travel')),intent,explanation:['按需求规划旅行检索'],assumptions:[],unchangedReason:''};
  const corrected={...original,queries:['川西胶片旅游','新疆胶片旅游','川西文艺旅行','新疆氛围旅行','川西情绪旅行','新疆旅行思考'],includeTerms:['川西','新疆','旅游','胶片','氛围','文艺','情绪','旅行思考']};
  return {rules,original,corrected};
}
const response=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('region-only rules fail expression coverage; grounded region and expression combinations pass',()=>{
  const {rules,original,corrected}=fixture();
  const missing=inspectRuleDemand(rules,'travel',demand,original,intent,[],'');
  assert.ok(missing.issues.includes('搜索词未覆盖“胶片”'));
  assert.ok(missing.issues.includes('内容相关词未覆盖“文艺”'));
  assert.ok(missing.issues.some(v=>v.includes('缺少所需表达方向')));
  assert.deepEqual(inspectRuleDemand(rules,'travel',demand,corrected,intent,[],'').issues,[]);
  const broad=inspectRuleDemand(rules,'travel',demand,{...corrected,queries:[...corrected.queries,'全国胶片旅行']},intent,[],'');
  assert.ok(broad.issues.some(v=>v.includes('扩大检索范围')));
  const invented={...intent,requirements:[...intent.requirements,{kind:'region' as const,source:'云南',keyword:'云南'}]};
  assert.ok(inspectRuleDemand(rules,'travel',demand,corrected,invented,[],'').issues.some(v=>v.includes('依据无法对应原文')));
});

test('unchanged copies get one correction; repaired rules update both keyword fields without mutating input',async t=>{
  const {rules,original,corrected}=fixture(),before=JSON.stringify(rules),sent:Record<string,unknown>[]=[];
  t.mock.method(aiTransport,'fetch',async(_input:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.model,profile.model);assert.equal(body.store,false);
    sent.push(JSON.parse(body.input[1].content));return response(sent.length===1?original:corrected);
  });
  const result=await generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal);
  assert.equal(sent.length,2);assert.ok(sent[1].repair);assert.equal(result.repaired,true);
  assert.deepEqual(result.categoryRules.queries,corrected.queries);assert.deepEqual(result.categoryRules.includeTerms,corrected.includeTerms);
  assert.ok(result.changedFields.includes('queries'));assert.ok(result.changedFields.includes('includeTerms'));
  assert.equal(result.categoryRules.demand,demand);assert.equal(JSON.stringify(rules),before);
});

test('second unmet proposal fails rather than returning a successful no-op',async t=>{
  const {rules,original}=fixture(),before=JSON.stringify(rules);
  const transport=t.mock.method(aiTransport,'fetch',async()=>response({...original,unchangedReason:'当前已有川西、新疆'}));
  await assert.rejects(generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal),{code:'RULE_DEMAND_NOT_APPLIED'});
  assert.equal(transport.mock.callCount(),2);assert.equal(JSON.stringify(rules),before);
});

test('repair cannot evade coverage by removing previously extracted requirements',async t=>{
  const {rules,original}=fixture();let calls=0;
  t.mock.method(aiTransport,'fetch',async()=>response(++calls===1?original:{...original,intent:{...intent,retrievalMode:'keep',requirements:[]},unchangedReason:'保持原词'}));
  await assert.rejects(generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal),{code:'RULE_DEMAND_NOT_APPLIED'});
  assert.equal(calls,2);
});

test('repair can remove an invented source while retaining grounded demand',async t=>{
  const {rules,corrected}=fixture();let calls=0;
  const invented={...corrected,intent:{...intent,requirements:[...intent.requirements,{kind:'region',source:'云南',keyword:'云南'}]}};
  t.mock.method(aiTransport,'fetch',async()=>response(++calls===1?invented:corrected));
  const result=await generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal);
  assert.equal(result.repaired,true);assert.equal(calls,2);assert.deepEqual(result.categoryRules.queries,corrected.queries);
});

test('locked keywords stay intact and unmet demand is explicitly reported',async t=>{
  const {rules,original}=fixture();
  const transport=t.mock.method(aiTransport,'fetch',async()=>response({...original,unchangedReason:'搜索词和内容相关词均锁定，保留现有值。'}));
  const result=await generateXhsRuleDraft(rules,'travel',demand,['queries','includeTerms'],{owner:'test',profile},new AbortController().signal);
  assert.deepEqual(result.categoryRules.queries,rules.categories.travel.queries);
  assert.deepEqual(result.changedFields,[]);assert.ok(result.warnings.some(w=>w.includes('搜索词已锁定')&&w.includes('胶片')));
  assert.equal(transport.mock.callCount(),1);
});

test('numeric-only demand preserves keyword fields; effective defaults are not fake differences',async t=>{
  const {rules,original}=fixture(),keep={summary:'只把窗口改为14天',retrievalMode:'keep',requirements:[]};
  const proposal={...original,intent:keep,settings:{...original.settings,windowDays:14}};
  t.mock.method(aiTransport,'fetch',async()=>response(proposal));
  const result=await generateXhsRuleDraft(rules,'travel','只把时间窗口改为14天，检索方向保持不变',[],{owner:'test',profile},new AbortController().signal);
  assert.deepEqual(result.changedFields,['settings.windowDays']);assert.deepEqual(result.categoryRules.queries,rules.categories.travel.queries);
  const merged=mergeRuleProposal(rules,'travel',original,[]);
  assert.deepEqual(changedRuleFields(rules,{...rules,categories:{...rules.categories,travel:merged}},'travel'),[]);
});

test('rules that already cover demand can remain unchanged with a concrete reason',async t=>{
  const {rules,corrected}=fixture();rules.categories.travel=corrected;
  t.mock.method(aiTransport,'fetch',async()=>response({...corrected,unchangedReason:'已有川西、新疆组合词，覆盖胶片、氛围、文艺、情绪及旅行思考。'}));
  const result=await generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal);
  assert.deepEqual(result.changedFields,[]);assert.equal(result.repaired,false);assert.match(result.unchangedReason,/组合词/);
});

test('explicit exclusions are checked separately without adding them to positive keywords',()=>{
  const {rules,corrected}=fixture(),exclude={kind:'exclude' as const,source:'旅行社广告',keyword:'旅行社广告'};
  const desired={...intent,requirements:[...intent.requirements,exclude]};
  const missing=inspectRuleDemand(rules,'travel',demand+'，不要旅行社广告',corrected,desired,[],'');
  assert.deepEqual(missing.issues,['排除词未覆盖“旅行社广告”']);
  assert.deepEqual(inspectRuleDemand(rules,'travel',demand+'，不要旅行社广告',{...corrected,settings:{...corrected.settings,excludeTerms:[...corrected.settings.excludeTerms,'旅行社广告']}},desired,[],'').issues,[]);
});

test('caller cancellation before or after first response prevents repair',async t=>{
  const {rules,original}=fixture(),controller=new AbortController(),reason=new DOMException('Synthetic cancel','AbortError');
  const transport=t.mock.method(aiTransport,'fetch',async()=>{controller.abort(reason);return response(original);});
  const cancelled=new AbortController();cancelled.abort(reason);
  await assert.rejects(generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},cancelled.signal),error=>error===reason);
  assert.equal(transport.mock.callCount(),0);
  await assert.rejects(generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},controller.signal));
  assert.equal(transport.mock.callCount(),1);
});

test('provider authentication failures are not retried as demand repairs',async t=>{
  const {rules}=fixture();
  const transport=t.mock.method(aiTransport,'fetch',async()=>Response.json({error:{message:'SYNTHETIC_PRIVATE_PROVIDER_TEXT'}},{status:401}));
  await assert.rejects(generateXhsRuleDraft(rules,'travel',demand,[],{owner:'test',profile},new AbortController().signal),error=>error instanceof Error&&!error.message.includes('SYNTHETIC_PRIVATE'));
  assert.equal(transport.mock.callCount(),1);
});

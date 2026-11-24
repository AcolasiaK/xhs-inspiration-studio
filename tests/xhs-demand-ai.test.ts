import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unverified, type Profile } from '../lib/ai-config';
import { DEFAULT_XHS_RULES, executionSchema, effectiveRules, xhsRulesSchema } from '../lib/xhs-hotspot-rules';
import { aiTransport } from '../lib/server/ai/provider';
import { generateXhsRuleDraft } from '../lib/server/xhs-rules-ai';
import { createTopicEnricher } from '../lib/server/xhs-topic-ai';
import { deleteProfile, saveProfile } from '../lib/server/ai/store';
import { xhsFixtureNote } from './xhs-fixture';
const profile:Profile={id:'fixture',revision:'1',name:'fixture',provider:'custom',protocol:'responses',baseUrl:'https://example.com/v1',apiKey:'synthetic-test-key',model:'fixture-model',timeoutSeconds:15,maxOutputTokens:8000,jsonMode:'schema',textTest:unverified(),imageTest:unverified()};
test('AI 归并可不设额外次数上限，也可保存高于10的用户上限；取消仍有效',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-uncapped-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:0};
 assert(xhsRulesSchema.safeParse(rules).success);
 const high=structuredClone(rules);high.categories.travel.semantic!.maxCalls=5000;assert(xhsRulesSchema.safeParse(high).success);
 let calls=0;
 t.mock.method(aiTransport,'fetch',async(_input:unknown,init?:RequestInit)=>{
  calls++;const request=JSON.parse(String(init?.body)),input=JSON.parse(request.input[1].content);
  return response({notes:input.notes.map((n:{id:string})=>({id:n.id,relevant:true,topics:[]}))});
 });
 const enrich=createTopicEnricher(rules,'travel',dir),signal=new AbortController().signal;
 let last;
 for(let i=0;i<12;i++)last=await enrich([{...xhsFixtureNote,id:(i+201).toString(16).padStart(24,'0'),likes:2000}],signal);
 assert.equal(calls,12);assert.equal(last!.calls,12);assert.deepEqual(last!.warnings,[]);
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(enrich([{...xhsFixtureNote,likes:2000}],cancelled.signal));assert.equal(calls,12);
});
const response=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
test('generated rules use the selected provider and server-enforced locks; invalid output cannot replace rules',async t=>{
 const rules=structuredClone(DEFAULT_XHS_RULES), before=JSON.stringify(rules);let broken=false;
 const transport=t.mock.method(aiTransport,'fetch',async(_input:unknown,init?:RequestInit)=>{
  const sent=JSON.parse(String(init?.body));assert.equal(sent.model,profile.model);assert.equal(sent.store,false);
  return response(broken?{queries:[]}:{...rules.categories.travel,queries:['新疆初雪'],includeTerms:['新疆','初雪','雪景'],intent:{summary:'寻找新疆初雪主题',retrievalMode:'rebuild',requirements:[{kind:'region',source:'新疆',keyword:'新疆'},{kind:'subject',source:'初雪',keyword:'初雪'}]},unchangedReason:'',requireDestination:true,minInteractions:1,minThemeInteractions:2000,overlapPercent:80,settings:{...executionSchema.parse(effectiveRules(rules,'travel')),windowDays:30},explanation:['限定新疆并补全雪景同义词'],assumptions:['未指定的预算保留原值']});
 });
 const got=await generateXhsRuleDraft(rules,'travel','寻找新疆初雪主题',['minInteractions','settings.windowDays'],{owner:'test',profile},new AbortController().signal);
 assert.deepEqual(got.categoryRules.queries,['新疆初雪']);assert.equal(got.categoryRules.minInteractions,rules.categories.travel.minInteractions);assert.equal(got.categoryRules.settings?.windowDays??rules.windowDays,7);assert.equal(JSON.stringify(rules),before);
 broken=true;await assert.rejects(generateXhsRuleDraft(rules,'travel','寻找新疆初雪主题',[],{owner:'test',profile},new AbortController().signal));assert.equal(JSON.stringify(rules),before);assert.equal(transport.mock.callCount(),2);
});
test('semantic grouping is opt-in, capped, cached by content and invalidated by scope',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-labels-'));
 const notes=Array.from({length:41},(_,i)=>({...xhsFixtureNote,id:(i+1).toString(16).padStart(24,'0'),likes:2000}));let calls=0;
 t.mock.method(aiTransport,'fetch',async(_input:unknown,init?:RequestInit)=>{calls++;const body=JSON.parse(String(init?.body));const input=JSON.parse(body.input[1].content);return response({notes:input.notes.map((n:{id:string})=>({id:n.id,relevant:true,topics:[{name:'新疆初雪拍照',kind:'direction',focus:'初雪拍照',place:null,evidence:'测试内容'}]}))});});
 await createTopicEnricher(rules,'travel',dir)(notes,new AbortController().signal);assert.equal(calls,0);
 rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:1};
 const enrich=createTopicEnricher(rules,'travel',dir);const first=await enrich(notes,new AbortController().signal);assert.equal(calls,1);assert.equal(first.notes.filter(n=>n.topicLabels?.length).length,16);assert.match(first.warnings.join(''),/调用上限/);assert.equal(first.notes[0].likes,2000);
 await enrich(notes,new AbortController().signal);assert.equal(calls,1);
 const cached=await createTopicEnricher(rules,'travel',dir)(notes.slice(0,16),new AbortController().signal);assert.equal(cached.calls,0);assert.equal(calls,1);
 rules.categories.travel.demand='只找徒步主题';await createTopicEnricher(rules,'travel',dir)(notes.slice(0,2),new AbortController().signal);assert.equal(calls,2);
});
test('semantic output with duplicate or foreign IDs falls back without assigning labels',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-bad-'));
 rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:2};const note={...xhsFixtureNote,likes:2000};
 t.mock.method(aiTransport,'fetch',async()=>response({notes:[{id:'ffffffffffffffffffffffff',relevant:true,topics:[{name:'伪造主题',kind:'direction',focus:'伪造主题',place:null,evidence:'不存在的证据'}]}]}));
 const result=await createTopicEnricher(rules,'travel',dir)([note],new AbortController().signal);assert.equal(result.calls,1);assert.equal(result.notes[0].topicLabel,undefined);assert.match(result.warnings.join(''),/未完成/);
});
test('semantic grouping keeps one profile snapshot across all collector batches',async t=>{
 const input={name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:'snapshot-original',maxOutputTokens:8000};
 const saved=await saveProfile('local-owner',input),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-snapshot-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:4};
 const models:string[]=[];
 t.mock.method(aiTransport,'fetch',async(_input:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));models.push(body.model);const input=JSON.parse(body.input[1].content);
  return response({notes:input.notes.map((n:{id:string})=>({id:n.id,relevant:true,topics:[{name:'新疆初雪拍照',kind:'direction',focus:'初雪拍照',place:null,evidence:'测试内容'}]}))});
 });
 const notes=Array.from({length:4},(_,i)=>({...xhsFixtureNote,id:(i+101).toString(16).padStart(24,'0'),likes:2000}));
 const enrich=createTopicEnricher(rules,'travel',dir),signal=new AbortController().signal;
 await enrich([notes[0]],signal);
 await saveProfile('local-owner',{...input,model:'snapshot-updated'},saved.id,saved.revision);
 await enrich([notes[1]],signal);
 await createTopicEnricher(rules,'travel',dir)([notes[2]],signal);
 await deleteProfile('local-owner',saved.id);
 const last=await enrich([notes[3]],signal);
 assert.deepEqual(models,['snapshot-original','snapshot-original','snapshot-updated','snapshot-original']);
 assert.equal(last.calls,3);assert.equal(last.notes[0].topicLabels?.[0].name,'新疆初雪拍照');assert.deepEqual(last.warnings,[]);
});
test('semantic grouping preserves caller cancellation before and during a batch',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-cancel-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:2};
 const controller=new AbortController(),reason=new DOMException('Synthetic caller cancellation','AbortError');
 const transport=t.mock.method(aiTransport,'fetch',async()=>{controller.abort(reason);throw reason;});
 const cancelled=new AbortController();cancelled.abort(reason);
 await assert.rejects(createTopicEnricher(rules,'travel',dir)([{...xhsFixtureNote,likes:2000}],cancelled.signal),error=>error===reason);
 assert.equal(transport.mock.callCount(),0);
 await assert.rejects(createTopicEnricher(rules,'travel',dir)([{...xhsFixtureNote,likes:2000}],controller.signal),error=>error===reason);
 assert.equal(transport.mock.callCount(),1);assert.deepEqual(await readdir(dir),[]);
});
test('semantic failures retain safe classifications without upstream text',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-failure-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:2};
 const transport=t.mock.method(aiTransport,'fetch',async()=>Response.json({error:{message:'SYNTHETIC_PRIVATE_UPSTREAM_TEXT'}},{status:401}));
 const enrich=createTopicEnricher(rules,'travel',dir),notes=[{...xhsFixtureNote,likes:2000}],signal=new AbortController().signal;
 const result=await enrich(notes,signal);await enrich(notes,signal);
 assert.equal(transport.mock.callCount(),1);assert.equal(result.notes[0].topicLabel,undefined);
 assert.match(result.warnings.join(''),/INVALID_KEY/);assert.doesNotMatch(result.warnings.join(''),/SYNTHETIC_PRIVATE/);
 await deleteProfile('local-owner',saved.id);
 const deleted=await createTopicEnricher(rules,'travel',dir)(notes,signal);
 assert.equal(deleted.calls,0);assert.match(deleted.warnings.join(''),/NOT_FOUND/);assert.equal(transport.mock.callCount(),1);
});
test('semantic batch deadline is a timeout fallback rather than caller cancellation',async t=>{
 const saved=await saveProfile('local-owner',{name:profile.name,provider:profile.provider,protocol:profile.protocol,baseUrl:profile.baseUrl,apiKey:profile.apiKey,model:profile.model,maxOutputTokens:8000}),rules=structuredClone(DEFAULT_XHS_RULES),dir=await mkdtemp(join(tmpdir(),'xhs-topic-timeout-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));rules.categories.travel.semantic={enabled:true,profileId:saved.id,maxCalls:2};
 const timeout=AbortSignal.timeout.bind(AbortSignal);
 t.mock.method(AbortSignal,'timeout',(delay:number)=>timeout(delay===90_000?1:delay));
 t.mock.method(aiTransport,'fetch',async()=>{await new Promise(resolve=>setTimeout(resolve,10));throw new DOMException('SYNTHETIC_PRIVATE_TIMEOUT','AbortError');});
 const result=await createTopicEnricher(rules,'travel',dir)([{...xhsFixtureNote,likes:2000}],new AbortController().signal);
 assert.equal(result.notes[0].topicLabel,undefined);assert.match(result.warnings.join(''),/TIMEOUT/);assert.doesNotMatch(result.warnings.join(''),/CANCELLED|SYNTHETIC_PRIVATE/);
});

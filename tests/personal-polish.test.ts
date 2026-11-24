import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import source from '../vendor/humanizer-zh/source.json';
import { newPersonalDraft, serializePersonalDraft, personalStoredSchema } from '../lib/personal/drafts';
import { builtinRuleSnapshot, emptyRuleContent } from '../lib/personal/style-rules';
import { buildPolishRequest, capturePolish, applyPolish, undoPolish, canPolish, polishFields } from '../lib/personal/polish';
import { polishHasChanges, validatePolishOutput } from '../lib/personal/polish-validation';
import { polishRequestSchema, type PolishRequest, type PolishResponse } from '../lib/personal/polish-schema';
import { requestPersonalPolish } from '../lib/personal/polish-client';
import { runPersonalPolish, humanizerRules } from '../lib/server/personal-polish';
import { createPersonalStyle, activatePersonalStyle } from '../lib/server/personal-style-store';
import { POST } from '../app/api/personal/polish/route';
import { prepareCompletedNote } from '../lib/personal/completed';
import { unverified, type Profile } from '../lib/ai-config';

function draft(style='daily',images=true){
 const d=newPersonalDraft(),id=randomUUID();
 d.input={...d.input,experience:'合成测试：周五在公园散步，门票 20 元。',bodyLength:'short',ruleSnapshot:builtinRuleSnapshot(style as Parameters<typeof builtinRuleSnapshot>[0]),styles:[style]};
 d.prompt='【核心感受或观点】\n保留散步中的观察。\n【写作安排】\n从树影写到河边，保留当时感受。';
 const image={id,width:1,height:1,file:new File(['synthetic-image'],'fixture.png',{type:'image/png',lastModified:1000}),preview:'blob:synthetic'};
 d.resultImages=images?[image]:[];d.images=[...d.resultImages];
 d.generation={mode:'live',meta:{durationMs:10,completedAt:new Date().toISOString()},imageIds:images?[id]:[],result:{titles:['散步的片刻','树影里的日常','公园里的风','河边慢慢走','留住眼前的光'],body:'周五在公园散步，门票 20 元。树影落在石板上，我停下来看了一会，觉得这样的时刻非常非常安静。\n\n走到河边时，风吹动衣角。我没有着急离开，又沿着岸边走了一段，听见脚下的落叶轻轻作响。',coverCopy:{headline:'公园散步',subline:''},imageCaptions:images?[{imageId:id,headline:'',description:'树影落在脚边，非常非常安静。\n我站了一会儿。'}]:[],hashtags:Array.from({length:10},(_,i)=>`#日常${i}`),warnings:['保留的提示']}};
 d.generatedInput={input:structuredClone(d.input),confirmedPrompt:d.prompt,research:null,imageIds:[...d.generation.imageIds]};
 return d;
}
function response(request:PolishRequest):PolishResponse{return {fields:request.fields.map(f=>({...f,text:f.text.replaceAll('非常非常','很')})),model:'synthetic-model',humanizer:{revision:source.revision,commit:source.commit,sha256:source.sha256}};}
const packet=(value:unknown)=>Response.json({id:'test',object:'response',created_at:1,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}]});
function environment(){const before={...process.env};process.env.APP_MODE='local';process.env.APP_LOCAL_ONLY='1';process.env.OPENAI_API_KEY='synthetic-polish-key';process.env.OPENAI_MODEL='synthetic-model';delete process.env.OPENAI_BASE_URL;return()=>{process.env=before;};}

test('固定 Humanizer 中文版本与许可，实际后端规则包含 31 个检查点',()=>{
 assert.equal(createHash('sha256').update(readFileSync('vendor/humanizer-zh/SKILL.md')).digest('hex'),source.sha256);
 assert.match(readFileSync('vendor/humanizer-zh/LICENSE','utf8'),/MIT License/);
 assert.equal((humanizerRules().match(/^### \d+\./gm)||[]).length,31);assert.match(humanizerRules(),/模式清单是检查线索/);
});
test('三种范围使用当前手改文字，按结果原依据及逐项重写版本取规则，忽略第一步的新选择',()=>{
 const d=draft();d.generation!.result.body+='\n\n手动补充的最新结尾。';d.input.styles=['emotion'];d.input.ruleSnapshot=builtinRuleSnapshot('emotion');
 const all=buildPolishRequest(d,'all');assert.equal(all.fields.length,9);assert.match(all.fields.find(f=>f.key==='body')!.text,/手动补充/);assert.ok(all.bases.every(b=>b.input.styles[0]==='daily'));
 const changed={...d.generatedInput!.input,styles:['travel'],ruleSnapshot:builtinRuleSnapshot('travel')};d.generatedInput!.rewrites=[{target:'title_one',targetIndex:0,at:new Date().toISOString(),input:changed,confirmedPrompt:'标题单独确认的方向'}];
 const req=buildPolishRequest(d,'all');assert.deepEqual(req.bases.find(b=>b.input.styles[0]==='travel')!.keys,['title:0']);
 assert.deepEqual(buildPolishRequest(d,'body').fields.map(f=>f.key),['body']);assert.equal(buildPolishRequest(d,'captions').fields.length,1);
 assert.doesNotMatch(JSON.stringify(req),/blob:|synthetic-image|referenceText|hashtags|warnings/);
});
test('选择范围严格约束字段、空配文不可提交、空内容不补造，旧多风格不静默选第一项',()=>{
 assert.equal(canPolish(newPersonalDraft()),false);assert.equal(canPolish(draft('daily',false),'captions'),false);
 const req=buildPolishRequest(draft(),'body');assert.equal(polishRequestSchema.safeParse({...req,fields:[...req.fields,{key:'cover:headline',text:'越界'}]}).success,false);
 assert.throws(()=>validatePolishOutput(req,{fields:[...req.fields,{key:'hashtags',text:'#改写'}]}));
 const all=buildPolishRequest(draft(),'all');assert.throws(()=>validatePolishOutput(all,{fields:all.fields.map(f=>f.key==='cover:subline'?{...f,text:'补造封面'}:f)}),/不存在/);
 const old=draft();old.generatedInput!.input.styles=['daily','travel'];assert.throws(()=>buildPolishRequest(old,'body'),/多个风格/);
});
test('未采用预览与失败均不改原文；采用仅改变所选范围，撤回保留其他编辑',async()=>{
 for(const scope of ['all','body','captions'] as const){
  const original=draft(),snapshot=JSON.stringify(original),ticket=capturePolish(original,scope),value=response(ticket.request);
  validatePolishOutput(ticket.request,value);assert.equal(JSON.stringify(original),snapshot);
  const latest={...original,generation:{...original.generation!,result:{...original.generation!.result,hashtags:['#用户正在编辑',...original.generation!.result.hashtags.slice(1)]}}};
  const applied=applyPolish(latest,ticket,value);assert.notDeepEqual(polishFields(applied.generation!.result,scope),ticket.request.fields);
  assert.deepEqual(applied.generation!.result.hashtags,latest.generation!.result.hashtags);assert.deepEqual(applied.generation!.result.warnings,original.generation!.result.warnings);
  if(scope==='body')assert.deepEqual(applied.generation!.result.imageCaptions,original.generation!.result.imageCaptions);
  if(scope==='captions')assert.equal(applied.generation!.result.body,original.generation!.result.body);
  const restored=undoPolish(applied);assert.deepEqual(polishFields(restored.generation!.result,scope),ticket.request.fields);assert.deepEqual(restored.generation!.result.hashtags,latest.generation!.result.hashtags);
  const stored=serializePersonalDraft(applied,0);assert.ok(stored.polishUndo);assert.deepEqual(personalStoredSchema.parse(stored).polishUndo!.before,ticket.request.fields);
 }
 const d=draft('daily',false),ticket=capturePolish(d,'body'),applied=applyPolish(d,ticket,response(ticket.request)),note=await prepareCompletedNote(applied);
 assert.equal(note.snapshot.generation!.result.body,applied.generation!.result.body);assert.ok(note.snapshot.polishUndo);assert.equal(note.nextDraft.generation,null);
});
test('请求期间目标编辑、切稿、重新生成、规则或图片关系变化均拒绝过期采用；仅改其他范围可采用',()=>{
 const d=draft(),ticket=capturePolish(d,'body'),value=response(ticket.request);
 for(const mutate of [(v:typeof d)=>{v.generation!.result.body+='新的编辑';},(v:typeof d)=>{v.id=randomUUID();},(v:typeof d)=>{v.generation!.meta.completedAt='2030-01-01T00:00:00.000Z';},(v:typeof d)=>{v.generatedInput!.confirmedPrompt='新方向';},(v:typeof d)=>{v.resultImages=[];}]){const next=structuredClone(d);mutate(next);assert.throws(()=>applyPolish(next,ticket,value));}
 const unrelated={...d,generation:{...d.generation!,result:{...d.generation!.result,titles:['刚编辑的新标题',...d.generation!.result.titles.slice(1)]}}};assert.equal(applyPolish(unrelated,ticket,value).generation!.result.titles[0],'刚编辑的新标题');
 const applied=applyPolish(d,ticket,value),edited={...applied,generation:{...applied.generation!,result:{...applied.generation!.result,body:applied.generation!.result.body+'后续编辑'}}};assert.throws(()=>undoPolish(edited),/覆盖新编辑/);
});
test('无实质修改不要求采用；旧小标题保留，新配文不产生标题',()=>{
 const d=draft(),ticket=capturePolish(d,'all');assert.equal(polishHasChanges(ticket.request.fields,ticket.request.fields),false);assert.equal(applyPolish(d,ticket,{...response(ticket.request),fields:ticket.request.fields}),d);
 d.generation!.result.imageCaptions[0].headline='用户保存的旧标题';const t=capturePolish(d,'captions'),next=applyPolish(d,t,response(t.request));assert.equal(next.generation!.result.imageCaptions[0].headline,'用户保存的旧标题');
 assert.throws(()=>validatePolishOutput(t.request,{fields:[{...t.request.fields[0],text:'**新小标题**\n原有配文'}]}),/小标题/);
});
test('数字、时间、直接引用、来源、确定程度、数量、标题长度和完整性受保护',()=>{
 const d=draft('china');d.generation!.result.body='周五出发，门票 20 元。他说“慢一点”。来源：https://example.com。可能还未验证。';const request=buildPolishRequest(d,'body');
 for(const text of ['周六出发，门票 20 元。他说“慢一点”。来源：https://example.com。可能还未验证。',request.fields[0].text.replace('20','30'),request.fields[0].text.replace('慢一点','快一点'),request.fields[0].text.replace('可能还未验证','已经确认')])assert.throws(()=>validatePolishOutput(request,{fields:[{key:'body',text}]}));
 const long=buildPolishRequest(draft(),'body');assert.throws(()=>validatePolishOutput(long,{fields:[{key:'body',text:'周五门票 20 元。'}]}),/删减/);
 const all=buildPolishRequest(draft('china'),'all');assert.throws(()=>validatePolishOutput(all,{fields:all.fields.map((f,i)=>i===0?{...f,text:'很长的标题'.repeat(6)}:f)}),/标题/);
 const caps=buildPolishRequest(draft(),'captions');assert.throws(()=>validatePolishOutput(caps,{fields:caps.fields.map(f=>({...f,key:`caption:${randomUUID()}`}))}),/顺序/);
 const quantities=buildPolishRequest(draft(),'body');quantities.fields[0].text='下午测到 -5℃，步行 20 米。';
 for(const text of ['下午测到 5℃，步行 20 米。','下午测到 -5℃，步行 20 元。','上午测到 -5℃，步行 20 米。'])assert.throws(()=>validatePolishOutput(quantities,{fields:[{key:'body',text}]}),/受保护/);
 assert.equal(validatePolishOutput(quantities,{fields:[{key:'body',text:'下午测到 -5℃，步行20米。'}]})[0].text,'下午测到 -5℃，步行20米。');
});
test('全部润色的每个风格都校验20字，旧超长标题仍可只润色正文',()=>{
 const d=draft('daily',false);
 d.generation!.result.titles[0]='甲'.repeat(21);
 const all=buildPolishRequest(d,'all');
 assert.throws(()=>validatePolishOutput(all,response(all)),/20 字/);
 const corrected={...response(all),fields:response(all).fields.map(f=>f.key==='title:0'?{...f,text:'甲'.repeat(19)+'🌱'}:f)};
 assert.equal(validatePolishOutput(all,corrected)[0].text,corrected.fields[0].text);
 const body=capturePolish(d,'body');
 const revised=applyPolish(d,body,response(body.request));
 assert.equal(revised.generation!.result.titles[0],d.generation!.result.titles[0]);
 assert.notEqual(revised.generation!.result.body,d.generation!.result.body);
});
test('四种风格与新自定义风格正式使用固定 Humanizer 规则，支持两个协议且不上传图片',async()=>{
 const restore=environment(),calls:{url:string;body:Record<string,unknown>}[]=[];let output:unknown;
 const net=mock.method(globalThis,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));calls.push({url:String(url),body});return body.messages?Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}):packet(output);});
 try{
  for(const style of ['china','travel','emotion','daily']){const d=draft(style),request=buildPolishRequest(d,'all');output={fields:response(request).fields};const result=await runPersonalPolish(request,new AbortController().signal,'relay','local-owner');assert.equal(result.humanizer.sha256,source.sha256);assert.ok(result.fields.some(f=>f.key==='body'));}
  const owner=randomUUID(),custom=await createPersonalStyle(owner,{...emptyRuleContent('合成自定义'),sections:{...emptyRuleContent().sections,overall:'保留测试风格的舒缓节奏'}});await activatePersonalStyle(owner,custom.id,custom.revision,custom.draftVersionId);
  const d=draft();d.generatedInput!.input={...d.generatedInput!.input,styles:[custom.id],ruleSnapshot:custom.versions[0].snapshot};const request=buildPolishRequest(d,'body');output={fields:response(request).fields};
  const profile:Profile={id:randomUUID(),revision:randomUUID(),name:'mock',provider:'custom',protocol:'chat-completions',baseUrl:'https://example.com/v1',apiKey:'synthetic-secret',model:'synthetic-chat',timeoutSeconds:30,maxOutputTokens:8000,jsonMode:'schema',textTest:unverified(),imageTest:unverified()};
  await runPersonalPolish(request,new AbortController().signal,{owner,profile},owner);assert.match(calls.at(-1)!.url,/chat\/completions/);assert.match(JSON.stringify(calls.at(-1)),/舒缓节奏/);
  for(const call of calls){assert.match(JSON.stringify(call.body),/Humanizer-zh|模式清单是检查线索/);assert.doesNotMatch(JSON.stringify(call.body),/input_image|data:image|synthetic-image/);}
  assert.equal(calls.length,5);assert.equal(calls[0].body.store,false);
  await assert.rejects(runPersonalPolish(request,new AbortController().signal,'relay',randomUUID()),/风格/);
 }finally{net.mock.restore();restore();}
});
test('客户端冻结所选 API，只发 JSON 文字；取消、网络及结构错误均不重试',async()=>{
 const req=buildPolishRequest(draft(),'body'),abort=new AbortController();let calls=0,headers:Headers|undefined;
 const output=await requestPersonalPolish(req,abort,{source:'profile-before',request:async(_url,init)=>{calls++;headers=new Headers(init?.headers);assert.equal(typeof init?.body,'string');assert.equal(init?.body instanceof FormData,false);return Response.json(response(req));}});
 assert.equal(headers!.get('X-AI-Profile'),'profile-before');assert.equal(output.model,'synthetic-model');assert.equal(calls,1);
 await assert.rejects(requestPersonalPolish(req,new AbortController(),{request:async()=>{throw new TypeError('secret internal endpoint');}}),/网络/);
 await assert.rejects(requestPersonalPolish(req,new AbortController(),{request:async()=>Response.json({fields:[]})}),/格式/);
 const cancel=new AbortController();await assert.rejects(requestPersonalPolish(req,cancel,{request:async()=>{cancel.abort();return Response.json(response(req));}}),/取消/);
});
test('本机入口拒绝跨站与非回环，错误不输出密钥或原稿',async()=>{
 const restore=environment(),logs:string[]=[];const logger=mock.method(console,'error',(...args:unknown[])=>logs.push(args.join(' ')));
 try{for(const [url,origin] of [['http://127.0.0.1:3000/api/personal/polish','https://untrusted.example'],['http://192.168.1.2:3000/api/personal/polish','http://192.168.1.2:3000']]){const r=await POST(new Request(url,{method:'POST',headers:{host:new URL(url).host,origin,'content-type':'application/json'},body:JSON.stringify(buildPolishRequest(draft(),'body'))}));assert.equal(r.status,403);assert.doesNotMatch(await r.text(),/synthetic-polish-key|门票/);}assert.doesNotMatch(logs.join(' '),/synthetic-polish-key|门票/);}finally{logger.mock.restore();restore();}
});

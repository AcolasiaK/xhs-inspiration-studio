import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { profileInput, unverified, type Profile } from '../lib/ai-config';
import { emptyAiForm } from '../lib/ai-settings-state';
import { AppError } from '../lib/errors';
import { assertImageCapability, createProvider } from '../lib/server/ai/provider';
import { OutputBudgetError } from '../lib/server/ai/output-budget';
import { cloudError } from '../lib/cloud/server/config';
import { safeErrorCode } from '../lib/client-diagnostics';

const profile:Profile={id:'test',revision:'test',name:'test',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'synthetic-test-key',model:'synthetic-model',timeoutSeconds:60,maxOutputTokens:8000,jsonMode:'schema',textTest:unverified(),imageTest:unverified()};
const body={model:profile.model,store:false,max_output_tokens:8000,input:[{role:'user' as const,content:'Return JSON.'}],text:{format:zodTextFormat(z.object({ok:z.boolean()}),'test')}};

test('带图生成在发送前区分未选配置、密钥缺失和图片测试结果', async () => {
 const assertMissing = (error: unknown) => error instanceof AppError && error.code === 'NOT_CONFIGURED';
 for (const selected of [null, {...profile, apiKey:''}]) {
  const source = {owner:'test', profile:selected};
  assert.throws(() => assertImageCapability(source), assertMissing);
  await assert.rejects(createProvider(source), assertMissing);
 }
 const image = {type:'input_image' as const, image_url:'data:image/png;base64,AAAA', detail:'auto' as const};
 const input = [{role:'user' as const, content:[image]}];
 let calls = 0;
 for (const [status, message] of [['unverified',/尚未/],['failed',/上次.*未通过/],['unsupported',/不支持/]] as const) {
  const source = {owner:'test', profile:{...profile, imageTest:{status, at:null, message:profile.apiKey}}};
  const validate = (error: unknown) => {
   assert(error instanceof AppError);
   assert.equal(error.code,'VISION_UNVERIFIED');
   assert.match(error.message,message);
   assert(!error.message.includes(profile.apiKey));
   return true;
  };
  assert.throws(() => assertImageCapability(source), validate);
  const client = await createProvider(source, {transport:async () => { calls++; throw new Error('unexpected network'); }});
  await assert.rejects(client.responses.parse({...body,input}), validate);
 }
 assert.equal(calls,0);
});

for(const protocol of ['responses','chat-completions'] as const){
 test(`${protocol}: token 截断与内容筛选保留明确原因，不采用半成品或自动重试`,async()=>{
  for(const [reason,code] of [['max_output_tokens','INCOMPLETE'],['content_filter','REFUSAL']] as const){
   let calls=0;
   const client=await createProvider({owner:'test',profile:{...profile,protocol}},{transport:async()=>{
    calls++;return Response.json(protocol==='responses'
     ? {status:'incomplete',incomplete_details:{reason},output:[]}
     : {choices:[{finish_reason:reason==='max_output_tokens'?'length':reason,message:{content:'{"ok":'}}]});
   }});
   await assert.rejects(client.responses.parse(body),e=>{
    assert(e instanceof AppError);assert.equal(e.code,code);
    if(code==='INCOMPLETE')assert.match(e.message,/token.*截断/u);
    assert(!e.message.includes(profile.apiKey));return true;
   });assert.equal(calls,1);
  }
 });
 test(`${protocol}: 总预算到期返回 TIMEOUT，主动取消返回 CANCELLED，两者均不出网`,async()=>{
  let calls=0;
  const client=await createProvider({owner:'test',profile:{...profile,protocol}},{transport:async()=>{calls++;throw new Error('unexpected network');}});
  for(const [name,code,status] of [['TimeoutError','TIMEOUT',504],['AbortError','CANCELLED',499]] as const){
   const signal=AbortSignal.abort(new DOMException('untrusted raw detail',name));
   for(const operation of [()=>client.responses.parse(body,{signal}),()=>client.models(signal)]){
    await assert.rejects(operation(),e=>{assert(e instanceof AppError);assert.equal(e.code,code);assert.equal(e.status,status);assert(!e.message.includes('untrusted'));return true;});
   }
  }assert.equal(calls,0);
 });
}
test('前端诊断保留共享传输层的安全分类，未知上游字段不记录',()=>{
 for(const code of ['VISION_UNVERIFIED','VISION_UNSUPPORTED','STRUCTURED_UNSUPPORTED','UNSAFE_ADDRESS','NETWORK_CONFIG','AI_PROXY_UNAVAILABLE','DNS_RESOLUTION_FAILED','DNS_LOOKUP_FAILED','INVALID_KEY_FORMAT'])assert.equal(safeErrorCode(code),code);
 assert.equal(safeErrorCode(profile.apiKey),'UNKNOWN');
});
test('请求时限支持完整方案，保留既有配置且受总预算上限约束',()=>{
 const input={name:'test',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',model:'synthetic-model'};
 assert.equal(profileInput.parse(input).timeoutSeconds,120);
 assert.equal(emptyAiForm().timeoutSeconds,120);
 for(const seconds of [10,60,150,180])assert.equal(profileInput.parse({...input,timeoutSeconds:seconds}).timeoutSeconds,seconds);
 for(const seconds of [9,181])assert.equal(profileInput.safeParse({...input,timeoutSeconds:seconds}).success,false);
});

test('输出额度不再有 16384 应用上限，仍拒绝无效数字',()=>{
 const input={name:'test',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',model:'synthetic-model'};
 for(const maxOutputTokens of [32768,65536,131072,262144])assert.equal(profileInput.parse({...input,maxOutputTokens}).maxOutputTokens,maxOutputTokens);
 for(const maxOutputTokens of [255,NaN,Infinity,8000.5,Number.MAX_SAFE_INTEGER+1])assert.equal(profileInput.safeParse({...input,maxOutputTokens}).success,false);
});


for (const protocol of ['responses','chat-completions'] as const) for (const jsonMode of ['schema','object'] as const) {
 test(`${protocol}/${jsonMode}: 本次更高输出额度真正到达服务，截断保留安全片段但不自动重试`, async()=>{
  const snapshot={owner:'test',profile:{...profile,protocol,jsonMode}},sent:number[]=[];
  const visible='{"summary":"已返回的风格概述","portrait":';
  const client=await createProvider(snapshot,{maxOutputTokens:32768,transport:async(_url,init)=>{
   const request=JSON.parse(String(init?.body));sent.push(request.max_output_tokens??request.max_completion_tokens);
   return Response.json(protocol==='responses'?{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:visible}]}]}:{choices:[{finish_reason:'length',message:{content:visible}}]});
  }});
  await assert.rejects(client.responses.parse({...body,max_output_tokens:32768}),error=>{
   assert(error instanceof OutputBudgetError);assert.equal(error.limit,32768);assert.equal(error.reason,'exhausted');assert.equal(error.visibleText(),visible);
   assert(!JSON.stringify(error).includes('已返回的风格概述'));return true;
  });
  assert.deepEqual(sent,[32768]);assert.equal(snapshot.profile.maxOutputTokens,8000);
  const regular=await createProvider(snapshot,{transport:async(_url,init)=>{const request=JSON.parse(String(init?.body));sent.push(request.max_output_tokens??request.max_completion_tokens);return Response.json(protocol==='responses'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]}:{choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});}});
  await regular.responses.parse({...body,max_output_tokens:65536});assert.deepEqual(sent,[32768,8000]);
 });
 test(`${protocol}/${jsonMode}: 截断片段中的原始及转义密钥均不回显`,async()=>{
  for(const key of [profile.apiKey,Array.from(profile.apiKey,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')]){
   const client=await createProvider({owner:'test',profile:{...profile,protocol,jsonMode}},{transport:async()=>Response.json(protocol==='responses'?{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'{"summary":"'+key+'","portrait":'}]}]}:{choices:[{finish_reason:'length',message:{content:'{"summary":"'+key+'","portrait":'}}]})});
   await assert.rejects(client.responses.parse(body),error=>{assert(error instanceof AppError);assert.equal(error.code,'INVALID_RESULT');assert(!(error instanceof OutputBudgetError));assert(!String(error).includes(profile.apiKey));return true;});
  }
 });
}

test('服务拒绝过大预算保留可调整状态，其他接口错误不冒充预算限制',async()=>{
 const client=await createProvider({owner:'test',profile},{maxOutputTokens:65536,transport:async()=>Response.json({error:{message:'max_output_tokens must be less than or equal to 32768. Private detail',code:'invalid_parameter'}},{status:400})});
 await assert.rejects(client.responses.parse({...body,max_output_tokens:65536}),error=>{assert(error instanceof OutputBudgetError);assert.equal(error.reason,'unsupported');assert.equal(error.limit,65536);assert.equal(error.visibleText(),'');assert(!error.message.includes('Private'));return true;});
 const other=await createProvider({owner:'test',profile},{transport:async()=>Response.json({error:{message:'unsupported max_output_tokens parameter',code:'unsupported_parameter'}},{status:400})});
 await assert.rejects(other.responses.parse(body),error=>{assert(error instanceof AppError);assert.equal(error.code,'PROVIDER_INCOMPATIBLE');return true;});
 const safe=await cloudError(new OutputBudgetError(8000,'exhausted','PRIVATE_OUTPUT')).text();assert(!safe.includes('PRIVATE_OUTPUT'));
});

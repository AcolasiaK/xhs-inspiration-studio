import {afterEach,mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {zodTextFormat} from 'openai/helpers/zod';
import {unverified,type Profile} from '../lib/ai-config';
import {aiTransport,createProvider,listProviderModels} from '../lib/server/ai/provider';

const environment={...process.env};
afterEach(()=>{mock.restoreAll();process.env=environment;});

test('模型列表、文字、图片的 Responses、Chat 和旧环境配置统一走 aiTransport，不走默认 fetch',async()=>{
 const key='synthetic-transport-key';
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
 const profile:Profile={id:'transport-profile',revision:'transport-revision',name:'transport',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:key,model:'synthetic-model',timeoutSeconds:15,maxOutputTokens:500,jsonMode:'schema',textTest:unverified(),imageTest:{status:'passed',at:null,message:'synthetic capability fixture'}};
 process.env={...environment,OPENAI_API_KEY:key,OPENAI_MODEL:profile.model,OPENAI_BASE_URL:profile.baseUrl};
 let defaultCalls=0;mock.method(globalThis,'fetch',async()=>{defaultCalls++;throw new Error('Must not bypass aiTransport');});
 const urls:string[]=[],imageProtocols:string[]=[];
 const transport=mock.method(aiTransport,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const url=String(input);urls.push(url);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+key);
  if(url.endsWith('/models'))return Response.json({data:[{id:'synthetic-model'}]});
  const sent=JSON.parse(String(init?.body));assert.equal(sent.model,profile.model);
  if(url.endsWith('/chat/completions')){
   if(Array.isArray(sent.messages[0].content)){assert.deepEqual(sent.messages[0].content[1],{type:'image_url',image_url:{url:image,detail:'auto'}});imageProtocols.push('chat-completions');}
   return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});
  }
  assert(url.endsWith('/responses'));
  if(Array.isArray(sent.input[0].content)){assert.deepEqual(sent.input[0].content[1],{type:'input_image',image_url:image,detail:'auto'});imageProtocols.push('responses');}
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]});
 });
 const body={model:profile.model,store:false,max_output_tokens:256,input:[{role:'user' as const,content:'Return JSON.'}],text:{format:zodTextFormat(z.object({ok:z.boolean()}),'transport_test')}};
 const imageBody={...body,input:[{role:'user' as const,content:[{type:'input_text' as const,text:'Inspect the synthetic image and return JSON.'},{type:'input_image' as const,image_url:image,detail:'auto' as const}]}]};
 assert.deepEqual(await listProviderModels(profile),[profile.model]);
 const responses=await createProvider({owner:'test-owner',profile});assert.equal((await responses.responses.parse(body)).output_parsed.ok,true);
 const chat=await createProvider({owner:'test-owner',profile:{...profile,protocol:'chat-completions'}});assert.equal((await chat.responses.parse(body)).output_parsed.ok,true);
 assert.equal((await responses.responses.parse(imageBody)).output_parsed.ok,true);
 assert.equal((await chat.responses.parse(imageBody)).output_parsed.ok,true);
 const legacy=await createProvider('relay');assert.equal((await legacy.responses.parse(body)).output_parsed.ok,true);assert.deepEqual(await legacy.models(),[profile.model]);assert.equal((await legacy.responses.parse(imageBody)).output_parsed.ok,true);
 assert.equal(defaultCalls,0);assert.equal(transport.mock.callCount(),8);
 assert.deepEqual(imageProtocols,['responses','chat-completions','responses']);
 assert.deepEqual(urls.map(url=>new URL(url).pathname),['/v1/models','/v1/responses','/v1/chat/completions','/v1/responses','/v1/chat/completions','/v1/responses','/v1/models','/v1/responses']);
});

test('测试专用传输桥接拒绝未模拟的模型网络请求',async()=>{
 // The global native fetch is unchanged, so the setup bridge must stop before network.
 await assert.rejects(aiTransport.fetch('https://api.openai.com/v1/models'),/Test model transport must be mocked/);
});

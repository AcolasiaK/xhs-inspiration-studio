import {afterEach,beforeEach,mock,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {POST} from '../app/api/ai/profiles/route';
import {modelListInput,profileInput} from '../lib/ai-config';
import {aiTransport} from '../lib/server/ai/provider';
import {queryProfileModels} from '../lib/server/ai/models';
import {readStateFor,recordProbe,saveProfile,setDefault} from '../lib/server/ai/store';
import {AppError} from '../lib/errors';

const original={...process.env};let directory:string;
const key='synthetic-new-form-api-key';
const connection={provider:'custom',baseUrl:'https://new.example.com/v1',apiKey:key};
const stored={...connection,name:'原有配置',model:'original-model',protocol:'responses',jsonMode:'schema'};
const request=(body:unknown)=>new Request('http://localhost/api/ai/profiles',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(body)});
const success=()=>Response.json({object:'list',data:[{id:'model-z'},{id:'model-a'},{id:'model-a'}]});
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'xhs-model-query-'));process.env={...original,APP_MODE:'local',APP_LOCAL_ONLY:'1',AI_CONFIG_DIR:directory,AI_CONFIG_SECRET:'',OPENAI_API_KEY:'synthetic-legacy-not-to-be-used',OPENAI_MODEL:'legacy-model'};});
afterEach(async()=>{mock.restoreAll();process.env=original;await rm(directory,{recursive:true,force:true});});

test('未保存且模型为空时可以查询，查询不创建或迁移任何配置',async()=>{
 assert.equal(modelListInput.safeParse(connection).success,true);
 assert.equal(profileInput.safeParse({...stored,model:''}).success,false);
 let calls=0;mock.method(aiTransport,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;assert.equal(String(url),'https://new.example.com/v1/models');assert(!String(url).includes(key));assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+key);assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);return success();});
 const response=await POST(request({action:'models',profile:connection}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{models:['model-a','model-z']});assert.equal(calls,1);
 assert.deepEqual(await readdir(directory),[]);
 const emptySave=await POST(request({action:'save',profile:{...stored,model:''}}));assert.equal(emptySave.status,400);
 const saved=await POST(request({action:'save',profile:{...stored,model:'model-a'}}));assert.equal(saved.status,200);assert.equal((await saved.json()).profile.model,'model-a');
});

test('查询当前新增表单而非默认配置；新密钥不写入已有配置，能力状态不变',async()=>{
 const profile=await saveProfile('local-owner',{...stored,baseUrl:'https://old.example.com/v1',apiKey:'synthetic-old-key'});await setDefault('local-owner',profile.id);
 const before=await readStateFor('local-owner');await recordProbe('local-owner',before.profiles[0],'text',{status:'passed',at:new Date().toISOString(),message:'prior verified text'});
 const state=await readStateFor('local-owner'),files=await readdir(directory),bytes=await Promise.all(files.map(f=>readFile(join(directory,f))));
 mock.method(aiTransport,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{assert.equal(String(url),'https://new.example.com/v1/models');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+key);return success();});
 assert.equal((await POST(request({action:'models',profile:connection}))).status,200);
 assert.deepEqual(await readStateFor('local-owner'),state);
 assert.deepEqual(await Promise.all(files.map(f=>readFile(join(directory,f)))),bytes);
});

test('编辑留空只使用本账号对应配置密钥，新填写密钥优先，均不保存',async()=>{
 const profile=await saveProfile('local-owner',stored);const before=await readStateFor('local-owner');let auth='';
 mock.method(aiTransport,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{assert.equal(String(url),'https://new.example.com/v1/models');auth=new Headers(init?.headers).get('authorization')||'';return success();});
 const query=(apiKey:string)=>POST(request({action:'models',id:profile.id,revision:profile.revision,profile:{...connection,apiKey}}));
 assert.equal((await query('')).status,200);assert.equal(auth,'Bearer '+key);
 assert.equal((await query('synthetic-replacement-key')).status,200);assert.equal(auth,'Bearer synthetic-replacement-key');
 assert.equal((await POST(request({action:'models',id:profile.id}))).status,200);assert.equal(auth,'Bearer '+key);
 assert.deepEqual(await readStateFor('local-owner'),before);
});

test('切换地址或服务类型必须重新填写密钥，清空密钥及跨账号 ID 不会发请求',async()=>{
 const profile=await saveProfile('local-owner',{...stored,provider:'openai',baseUrl:'https://api.openai.com/v1'});
 let calls=0;mock.method(aiTransport,'fetch',async()=>{calls++;return success();});
 const query=(fields:unknown)=>POST(request({action:'models',id:profile.id,revision:profile.revision,profile:fields}));
 for(const fields of [{...connection,apiKey:''},{...connection,baseUrl:'https://api.openai.com/v1',apiKey:''},{...connection,apiKey:key,clearApiKey:true}]){
  const response=await query(fields);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'KEY_REQUIRED');
 }
 await assert.rejects(queryProfileModels('different-owner',connection,profile.id),/不存在或不属于/);
 const unknown=await POST(request({action:'models',id:randomUUID(),profile:connection}));assert.equal(unknown.status,404);
 await assert.rejects(saveProfile('local-owner',{...stored,provider:'custom',baseUrl:'https://api.openai.com/v1',apiKey:''},profile.id,profile.revision),/更换地址或服务类型/);
 assert.equal(calls,0);
 // An explicit new key can accompany a changed provider/address without modifying the saved one.
 assert.equal((await query(connection)).status,200);assert.equal(calls,1);
 assert.equal((await readStateFor('local-owner')).profiles[0].baseUrl,'https://api.openai.com/v1');
});

test('过期配置修订拒绝查询；非法地址不会进入传输层',async()=>{
 const profile=await saveProfile('local-owner',stored);await saveProfile('local-owner',{...stored,name:'另页修改'},profile.id,profile.revision);
 let calls=0;mock.method(aiTransport,'fetch',async()=>{calls++;return success();});
 assert.equal((await POST(request({action:'models',id:profile.id,revision:profile.revision,profile:connection}))).status,409);
 for(const baseUrl of ['http://127.0.0.1:3000','https://user:pass@example.com','https://example.com/v1/models'])assert.equal((await POST(request({action:'models',profile:{...connection,baseUrl}}))).status,400);
 assert.equal(calls,0);
});

test('返回列表过滤密钥与非法 ID，空列表和格式错误分别处理',async()=>{
 const transport=mock.method(aiTransport,'fetch',async()=>Response.json({data:[{id:key},{id:'unsafe model id'},{id:'valid-model'},{id:'valid-model'}]}));
 assert.deepEqual(await queryProfileModels('local-owner',connection),['valid-model']);
 transport.mock.mockImplementation(async()=>Response.json({data:[]}));assert.deepEqual(await queryProfileModels('local-owner',connection),[]);
 transport.mock.mockImplementation(async()=>Response.json({unexpected:key}));const invalid=await POST(request({action:'models',profile:connection}));assert.equal(invalid.status,502);const body=await invalid.text();assert.match(body,/MODELS_INVALID_RESPONSE/);assert(!body.includes(key));
});

test('只有实际 JSON 或列表结构错误才报格式问题，其他本机异常不能伪称服务响应格式错误',async()=>{
 const transport=mock.method(aiTransport,'fetch',async()=>new Response('<html>'+key+'</html>',{headers:{'content-type':'text/html'}}));
 const query=()=>POST(request({action:'models',profile:connection}));
 const malformed=await query(),invalid=await malformed.json();
 assert.equal(invalid.error.code,'MODELS_INVALID_RESPONSE');assert.match(invalid.error.message,/不是有效的 JSON/);assert(!JSON.stringify(invalid).includes(key));
 transport.mock.mockImplementation(async()=>{
  const response=success();response.json=async()=>{throw new TypeError('PRIVATE_LOCAL_DETAIL '+key);};return response;
 });
 const failed=await query(),body=await failed.json();
 assert.equal(body.error.code,'MODELS_QUERY_FAILED');assert.doesNotMatch(body.error.message,/模型列表格式|手动填写|PRIVATE_LOCAL_DETAIL/);assert(!JSON.stringify(body).includes(key));
});

test('模型列表错误分类且密钥不进入日志、响应或请求 URL，不自动重试',async()=>{
 const logs:unknown[]=[];mock.method(console,'error',(...v:unknown[])=>logs.push(v));mock.method(console,'warn',(...v:unknown[])=>logs.push(v));mock.method(console,'log',(...v:unknown[])=>logs.push(v));
 let status=401,calls=0;mock.method(aiTransport,'fetch',async(url:Parameters<typeof fetch>[0])=>{calls++;assert(!String(url).includes(key));return Response.json({error:{message:'PRIVATE_DETAIL '+key}},{status});});
 const expected=new Map([[401,'INVALID_KEY'],[403,'MODELS_FORBIDDEN'],[404,'MODELS_UNSUPPORTED'],[405,'MODELS_UNSUPPORTED'],[400,'MODELS_INCOMPATIBLE'],[429,'PROVIDER_LIMIT'],[500,'PROVIDER_UNAVAILABLE']]);
 for(const [s,code] of expected){status=s;const response=await POST(request({action:'models',profile:connection}));const body=await response.json();assert.equal(body.error.code,code);if(['MODELS_FORBIDDEN','MODELS_UNSUPPORTED','MODELS_INCOMPATIBLE'].includes(code))assert.match(body.error.message,/手动填写/);else assert.doesNotMatch(body.error.message,/手动填写/);assert(!JSON.stringify(body).includes(key));assert(!JSON.stringify(body).includes('PRIVATE_DETAIL'));}
 assert.equal(calls,expected.size);assert.deepEqual(logs,[]);
});

test('网络失败与取消不误报密钥错误',async()=>{
 const transport=mock.method(aiTransport,'fetch',async()=>{throw new TypeError('synthetic network failure');});
 let response=await POST(request({action:'models',profile:connection}));const error=(await response.json()).error;assert.equal(error.code,'MODELS_NETWORK');assert.doesNotMatch(error.message,/手动填写|synthetic network failure/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(queryProfileModels('local-owner',connection,undefined,undefined,controller.signal),/已取消/);
 assert.equal(transport.mock.callCount(),1);
 transport.mock.mockImplementation(async()=>Response.json({data:[]}));
 response=await POST(request({action:'models',profile:{...connection,apiKey:''}}));assert.equal((await response.json()).error.code,'KEY_REQUIRED');assert.equal(transport.mock.callCount(),1);
});

test('SDK 包装后的安全 DNS 和网络校验原因完整保留；TLS 细节不回显',async()=>{
 const transport=mock.method(aiTransport,'fetch',async()=>success());
 const logs:unknown[]=[];mock.method(console,'error',(...v:unknown[])=>logs.push(v));mock.method(console,'warn',(...v:unknown[])=>logs.push(v));mock.method(console,'log',(...v:unknown[])=>logs.push(v));
 for(const code of ['UNSAFE_ADDRESS','NETWORK_CONFIG','DNS_RESOLUTION_FAILED','DNS_LOOKUP_FAILED']){
  const safe=new AppError(code,'请求在地址解析或网络校验阶段受阻，尚未验证密钥。',502);
  transport.mock.mockImplementation(async()=>{throw new TypeError('PRIVATE_DETAIL '+key,{cause:safe});});
  const response=await POST(request({action:'models',profile:connection})),body=await response.json();
  assert.equal(body.error.code,code);assert.equal(body.error.message,safe.message);assert.doesNotMatch(body.error.message,/手动填写|PRIVATE_DETAIL/);assert(!JSON.stringify(body).includes(key));
 }
 transport.mock.mockImplementation(async()=>{throw Object.assign(new Error('PRIVATE_TLS_DETAIL '+key),{code:'CERT_HAS_EXPIRED'});});
 const response=await POST(request({action:'models',profile:connection})),body=await response.json();
 assert.equal(body.error.code,'MODELS_NETWORK');assert.match(body.error.message,/网络连接阶段/);assert.doesNotMatch(body.error.message,/手动填写|PRIVATE_TLS_DETAIL/);assert(!JSON.stringify(body).includes(key));assert.deepEqual(logs,[]);
});

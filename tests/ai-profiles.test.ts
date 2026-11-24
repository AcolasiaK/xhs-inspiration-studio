import {test,beforeEach,afterEach,mock} from 'node:test';
import OpenAI from 'openai';
import {providerError} from '../lib/server/provider-errors';
import {AppError} from '../lib/errors';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {z} from 'zod';
import {zodTextFormat} from 'openai/helpers/zod';
import {normalizeBaseUrl,publicIP} from '../lib/server/ai/address';
import {seal,unseal,saveProfile,stateFor,setDefault,deleteProfile,migrateLegacy,recordProbe} from '../lib/server/ai/store';
import {selectProfile,ownerFor} from '../lib/server/ai/selection';
import {aiTransport,createProvider,toMessages} from '../lib/server/ai/provider';
import {probeProfile} from '../lib/server/ai/probe';
import { needsAiRetest, sameAiForm } from '../lib/ai-settings-state';
import { profileForm } from '../lib/ai-profile-client';
import {GET,POST} from '../app/api/ai/profiles/route';
const env={...process.env};let dir:string;
const input={name:'测试配置',provider:'custom',protocol:'responses',baseUrl:'https://example.com/v1',apiKey:'synthetic-private-key',model:'test-model',jsonMode:'schema'};
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'xhs-ai-'));process.env={...env,APP_MODE:'local',APP_LOCAL_ONLY:'1',AI_CONFIG_DIR:dir,AI_CONFIG_SECRET:'',OPENAI_API_KEY:'',OPENAI_MODEL:''};});
afterEach(async()=>{mock.restoreAll();process.env=env;await rm(dir,{recursive:true,force:true});});
test('地址校验、公开 IP 与官方服务密钥目的地约束',()=>{assert.equal(normalizeBaseUrl('https://example.com/v1///'),'https://example.com/v1');for(const url of ['file:///tmp/a','http://127.1','http://169.254.169.254','https://localhost','http://[::1]','https://user:key@example.com','https://example.com?x=1','https://example.com/#x','https://example.com/v1/responses','https://example.com/chat/completions','https://example.com/v1/v1'])assert.throws(()=>normalizeBaseUrl(url));assert.throws(()=>normalizeBaseUrl('https://example.com','openai'));assert.equal(publicIP('::ffff:127.0.0.1'),false);assert.equal(publicIP('198.18.0.1'),false);assert.equal(publicIP('8.8.8.8'),true);});
test('加密保存、密钥不回显、空值保留、换目的地要求新密钥、账号隔离',async()=>{const p=await saveProfile('alice',input);assert(!JSON.stringify(p).includes(input.apiKey));assert.equal(p.maskedApiKey,'••••••••-key');const disk=await readdir(dir);for(const f of disk.filter(f=>f.endsWith('.enc')))assert(!(await readFile(join(dir,f),'utf8')).includes(input.apiKey));assert.equal((await stateFor('bob')).profiles.length,0);await assert.rejects(setDefault('bob',p.id));await assert.rejects(deleteProfile('bob',p.id));const saved=await saveProfile('alice',{...input,apiKey:''},p.id,p.revision);assert.equal((await stateFor('alice')).profiles[0].apiKey,input.apiKey);await assert.rejects(saveProfile('alice',{...input,apiKey:'',baseUrl:'https://other.example.com'},p.id,saved.revision));const sealed=await seal({secret:input.apiKey},'alice');assert.equal((await unseal<{secret:string}>(sealed,'alice')).secret,input.apiKey);await assert.rejects(unseal(sealed,'bob'));await assert.rejects(saveProfile('alice',{...input,model:''}));});
test('默认选择、删除不自动换源、快照不受编辑影响、测试失效与旧结果保护',async()=>{const p=await saveProfile('local-owner',input);await setDefault('local-owner',p.id);const snapshot=await selectProfile('local-owner');await recordProbe('local-owner',snapshot.profile!,'image',{status:'passed',at:new Date().toISOString(),message:'ok'});const updated=await saveProfile('local-owner',{...input,model:'other'},p.id,p.revision);assert.equal(updated.imageTest.status,'unverified');assert.equal(snapshot.profile?.model,'test-model');await assert.rejects(recordProbe('local-owner',snapshot.profile!,'image',{status:'passed',at:null,message:'old'}));await deleteProfile('local-owner',p.id);assert.equal((await stateFor('local-owner')).defaultId,null);await assert.rejects(selectProfile('local-owner',p.id));});
test('环境变量只迁移本机一次，不覆盖页面配置、删除后不复活',async()=>{process.env.OPENAI_API_KEY=input.apiKey;process.env.OPENAI_MODEL='env-model';process.env.OPENAI_BASE_URL=input.baseUrl;await migrateLegacy('local-owner');await migrateLegacy('local-owner');const s=await stateFor('local-owner');assert.equal(s.profiles.length,1);assert.equal(s.profiles[0].model,'env-model');await deleteProfile('local-owner',s.profiles[0].id);await migrateLegacy('local-owner');assert.equal((await stateFor('local-owner')).profiles.length,0);await migrateLegacy('someone-else');assert.equal((await stateFor('someone-else')).profiles.length,0);});
for(const protocol of ['responses','chat-completions'] as const)test(protocol+' 真实适配格式、JSON 校验、图片映射与能力门禁（模拟 HTTP）',async()=>{const saved=await saveProfile('local-owner',{...input,protocol});const selected=await selectProfile('local-owner',saved.id);let calls=0;const transport:typeof fetch=async(_url,init)=>{calls++;const b=JSON.parse(String(init?.body));assert.equal(b.model,'test-model');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+input.apiKey);if(protocol==='responses'){assert.equal(b.store,false);assert.equal(b.input[0].content[1].type,'input_image');return Response.json({id:'mock',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"ok":true}',annotations:[]}]}]});}assert.equal(b.messages[0].content[1].type,'image_url');return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]});};
const client=await createProvider(selected,{transport});const body={model:'ignored',store:false,max_output_tokens:400,input:[{role:'user' as const,content:[{type:'input_text' as const,text:'test'},{type:'input_image' as const,image_url:'data:image/png;base64,AAAA',detail:'auto' as const}]}],text:{format:zodTextFormat(z.object({ok:z.boolean()}),'test')}};await assert.rejects(client.responses.parse(body),/图片理解/);assert.equal(calls,0);const probe=await createProvider(selected,{testImage:true,transport});assert.equal((await probe.responses.parse(body)).output_parsed.ok,true);assert.equal(calls,1);
const broken=await createProvider(selected,{testImage:true,transport:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'{"wrong":1}'}}],status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"wrong":1}'}]}]})});await assert.rejects(broken.responses.parse(body));});
test('失败不重试、不切换、不泄露密钥或第三方错误，取消保留结果',async()=>{const p=await saveProfile('local-owner',input),s=await selectProfile('local-owner',p.id);let calls=0;const client=await createProvider(s,{transport:async()=>{calls++;return Response.json({error:{code:'invalid_api_key',message:input.apiKey}},{status:401});}});const body={model:'',store:false,max_output_tokens:256,input:[{role:'user' as const,content:'hello'}],text:{format:zodTextFormat(z.object({ok:z.boolean()}),'test')}};await assert.rejects(client.responses.parse(body),e=>{assert(!String(e).includes(input.apiKey));return true;});assert.equal(calls,1);const c=new AbortController();c.abort();await assert.rejects(client.responses.parse(body,{signal:c.signal}));assert.equal(calls,1);});
test('模型列表失败不影响手填保存；文字和图片测试独立',async()=>{const p=await saveProfile('local-owner',input),s=await selectProfile('local-owner',p.id);const c=await createProvider(s,{transport:async()=>Response.json({}, {status:404})});await assert.rejects(c.models());assert.equal(s.profile!.model,'test-model');const result=await probeProfile(s.profile!,'image',undefined,async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"color":"not-a-color"}'}]}]}));assert.equal(result.status,'failed');assert.equal(s.profile!.textTest.status,'unverified');assert.equal(toMessages([{role:'user',content:'text'}])[0].content,'text');});
test('本机接口仅限回环同源，云端依赖真实登录，接口永不返回密钥',async()=>{const req=(origin='http://localhost')=>new Request('http://localhost/api/ai/profiles',{headers:{host:'localhost',origin}});await assert.rejects(ownerFor(req('https://evil.example')));process.env.APP_LOCAL_ONLY='0';await assert.rejects(ownerFor(req()));process.env.APP_LOCAL_ONLY='1';const r=await POST(new Request('http://localhost/api/ai/profiles',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({action:'save',profile:input})}));assert.equal(r.status,200);assert(!(await r.text()).includes(input.apiKey));assert(!(await (await GET(req())).text()).includes(input.apiKey));process.env.APP_MODE='cloud';const cloud=await GET(req());assert.notEqual(cloud.status,200);});

test('能力错误区分明确不支持与未知兼容问题，DNS 拦截保留安全提示且日志无密钥',async()=>{
 const wrapped=new OpenAI.APIConnectionError({cause:new AppError('UNSAFE_ADDRESS','服务地址解析到了非公开网络，已停止请求。',400)});
 assert.equal(providerError(wrapped,'AI 服务').code,'UNSAFE_ADDRESS');
 const logs:string[]=[];mock.method(console,'error',(...v:unknown[])=>logs.push(JSON.stringify(v)));mock.method(console,'warn',(...v:unknown[])=>logs.push(JSON.stringify(v)));mock.method(console,'log',(...v:unknown[])=>logs.push(JSON.stringify(v)));
 const saved=await saveProfile('local-owner',input),selected=await selectProfile('local-owner',saved.id);
 for(const [code,expected] of [['unsupported_image','unsupported'],['unsupported_parameter','failed']] as const){const result=await probeProfile(selected.profile!,'image',undefined,async()=>Response.json({error:{code,message:input.apiKey}},{status:400}));assert.equal(result.status,expected);assert(!JSON.stringify(result).includes(input.apiKey));}
 assert.equal(logs.length,0);
});

test('文字和图片生成保留 SDK 包装的安全网络原因，不泄露底层错误',async()=>{
 const saved=await saveProfile('local-owner',input),selected=await selectProfile('local-owner',saved.id);
 const format=zodTextFormat(z.object({ok:z.boolean()}),'test');
 for(const code of ['UNSAFE_ADDRESS','NETWORK_CONFIG','DNS_RESOLUTION_FAILED','DNS_LOOKUP_FAILED']){
  const safe=new AppError(code,'请求在地址解析或网络校验阶段受阻，尚未验证密钥。',502);
  const client=await createProvider(selected,{testImage:true,transport:async()=>{throw new TypeError('PRIVATE_DETAIL '+input.apiKey,{cause:safe});}});
  for(const image of [false,true]){
   const content=[{type:'input_text' as const,text:'test'},...(image?[{type:'input_image' as const,image_url:'data:image/png;base64,AAAA',detail:'auto' as const}]:[])];
   await assert.rejects(client.responses.parse({model:'',store:false,max_output_tokens:256,input:[{role:'user',content}],text:{format}}),error=>{
    assert(error instanceof AppError);assert.equal(error.code,code);assert.equal(error.message,safe.message);assert(!String(error).includes(input.apiKey));return true;
   });
  }
 }
 const unknown=new OpenAI.APIConnectionError({cause:new AppError('UNTRUSTED_DETAIL',input.apiKey,502)});
 assert.equal(providerError(unknown,'AI 服务').code,'PROVIDER_NETWORK');assert(!providerError(unknown,'AI 服务').message.includes(input.apiKey));
 assert.equal(providerError(new OpenAI.APIConnectionTimeoutError(),'AI 服务').code,'TIMEOUT');
});

test('上游将密钥转为 JSON Unicode 转义也不能回显',async()=>{
 const p=await saveProfile('local-owner',input),selected=await selectProfile('local-owner',p.id);
 const escaped=Array.from(input.apiKey,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const client=await createProvider(selected,{transport:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"value":"'+escaped+'"}'}]}]})});
 await assert.rejects(client.responses.parse({model:'',store:false,max_output_tokens:256,input:[{role:'user',content:'test'}],text:{format:zodTextFormat(z.object({value:z.string()}),'safe')}}),e=>{assert(!String(e).includes(input.apiKey));return true;});
});


test('提高输出额度不丢失图片验证，仍标记表单为待保存并保留原密钥',async()=>{
 const saved=await saveProfile('local-owner',input),snapshot=await selectProfile('local-owner',saved.id);
 await recordProbe('local-owner',snapshot.profile!,'image',{status:'passed',at:null,message:'synthetic image capability'});
 await recordProbe('local-owner',snapshot.profile!,'text',{status:'passed',at:null,message:'synthetic text capability'});
 const updated=await saveProfile('local-owner',{...input,apiKey:'',maxOutputTokens:65536},saved.id,saved.revision);
 assert.equal(updated.maxOutputTokens,65536);assert.equal(updated.imageTest.status,'passed');assert.equal(updated.textTest.status,'passed');
 assert.equal((await selectProfile('local-owner',saved.id)).profile!.apiKey,input.apiKey);
 const changed={...profileForm(updated),maxOutputTokens:131072};assert.equal(needsAiRetest(changed,updated),false);assert.equal(sameAiForm(changed,profileForm(updated)),false);
 assert.equal(needsAiRetest({...changed,model:'different'},updated),true);
});

test('只修改请求等待时长时，已验证能力和表单的保存提示各自保留', async () => {
 const saved = await saveProfile('local-owner', input);
 const { profile } = await selectProfile('local-owner', saved.id);
 const previous = { status: 'passed' as const, at: '2026-01-01T00:00:00Z', message: 'verified' };
 await recordProbe('local-owner', profile!, 'image', previous);
 await recordProbe('local-owner', profile!, 'text', previous);
 const next = { ...profileForm(saved), timeoutSeconds: 150 };
 const changed = await saveProfile('local-owner', next, saved.id, saved.revision);
 assert.deepEqual(changed.imageTest, previous);
 assert.deepEqual(changed.textTest, previous);
 assert.equal(sameAiForm(next, profileForm(saved)), false);
 assert.equal(needsAiRetest(next, saved), false);
});

test('能力测试沿用用户设置的输出额度，允许模型在简短答复前完成推理', async () => {
 const saved = await saveProfile('local-owner', { ...input, maxOutputTokens: 1200 });
 const { profile } = await selectProfile('local-owner', saved.id);
 const result = await probeProfile(profile!, 'text', undefined, async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  if (request.max_output_tokens < 1024) {
   return Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
  }
  assert.equal(request.max_output_tokens, 1200);
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"OK"}' }] }] });
 });
 assert.equal(result.status, 'passed');
});

const testRequest = (id: string, revision: string) => new Request('http://localhost/api/ai/profiles', {
 method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
 body: JSON.stringify({ action: 'test', id, revision, kind: 'image' }),
});

test('上游限流导致重测无法完成时，返回限流原因并保留已成功识图的记录', async () => {
 const saved = await saveProfile('local-owner', input);
 const { profile } = await selectProfile('local-owner', saved.id);
 const passed = { status: 'passed' as const, at: '2026-01-01T00:00:00Z', message: 'verified' };
 await recordProbe('local-owner', profile!, 'image', passed);
 mock.method(aiTransport, 'fetch', async () => Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 }));
 const response = await POST(testRequest(saved.id, saved.revision));
 assert.equal(response.status, 429);
 assert.equal((await response.json()).error.code, 'PROVIDER_LIMIT');
 assert.deepEqual((await selectProfile('local-owner', saved.id)).profile!.imageTest, passed);
});

test('能力测试确认后的配置已被编辑时，调用模型前返回冲突', async () => {
 const saved = await saveProfile('local-owner', input);
 await saveProfile('local-owner', { ...input, model: 'other-model' }, saved.id, saved.revision);
 const transport = mock.method(aiTransport, 'fetch', async () => Response.json({}, { status: 502 }));
 const response = await POST(testRequest(saved.id, saved.revision));
 assert.equal(response.status, 409);
 assert.equal(transport.mock.callCount(), 0);
});

const listRequest = () => new Request('http://localhost/api/ai/profiles', {
 headers: { host: 'localhost', origin: 'http://localhost' },
});

test('有设置正在保存时，读列表和选择模型可以读取上一次完整配置并且不改写密文', async () => {
 const saved = await saveProfile('local-owner', input);
 await migrateLegacy('local-owner');
 await setDefault('local-owner', saved.id);
 const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.enc'))!);
 const before = await readFile(file);
 const lock = file + '.lock';
 await mkdir(lock);
 await writeFile(join(lock, `owner-${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`), '');
 const [listed, selected] = await Promise.all([GET(listRequest()), selectProfile('local-owner')]);
 assert.equal(listed.status, 200);
 assert.equal((await listed.json()).defaultId, saved.id);
 assert.equal(selected.profile?.id, saved.id);
 assert.deepEqual(await readFile(file), before);
});

test('配置库存在但主密钥缺失，读取报错且不生成替代密钥或改写配置', async () => {
 await saveProfile('local-owner', input);
 const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.enc'))!);
 const before = await readFile(file);
 const master = join(dir, 'master.key');
 await rename(master, master + '.backup');
 const response = await GET(listRequest());
 assert.equal(response.status, 503);
 assert.equal((await response.json()).error.code, 'AI_STORAGE');
 assert.deepEqual(await readFile(file), before);
 assert.ok(!(await readdir(dir)).includes('master.key'));
});

test('改名称和请求预算保留验证，更换模型、接口、地址、密钥或 JSON 模式必须重新验证', async () => {
 const cases = [
  { change: { name: '新名称' }, keep: true },
  { change: { maxOutputTokens: 3200 }, keep: true },
  { change: { timeoutSeconds: 90 }, keep: true },
  { change: { model: 'new-model' }, keep: false },
  { change: { protocol: 'chat-completions' }, keep: false },
  { change: { baseUrl: 'https://another.example/v1', apiKey: 'new-destination-key' }, keep: false },
  { change: { apiKey: 'replaced-secret' }, keep: false },
  { change: { jsonMode: 'object' }, keep: false },
 ] as const;
 for (const { change, keep } of cases) {
  const saved = await saveProfile('local-owner', input);
  const { profile } = await selectProfile('local-owner', saved.id);
  const verified = { status: 'passed' as const, at: '2026-01-01T00:00:00Z', message: 'verified' };
  await recordProbe('local-owner', profile!, 'image', verified);
  await recordProbe('local-owner', profile!, 'text', verified);
  const next = { ...profileForm(saved), ...change };
  assert.equal(needsAiRetest(next, saved), !keep);
  const edited = await saveProfile('local-owner', next, saved.id, saved.revision);
  assert.equal(edited.imageTest.status, keep ? 'passed' : 'unverified');
  assert.equal(edited.textTest.status, keep ? 'passed' : 'unverified');
 }
});

test('更换配置时晚到的测试不能写入，新测试按新地址、模型、协议和密钥重新识图', async () => {
 const old = await saveProfile('local-owner', input);
 let next = old;
 const key = 'synthetic-replacement-key';
 const transport = mock.method(aiTransport, 'fetch', async () => {
  next = await saveProfile('local-owner', {
   ...input, model: 'second-model', baseUrl: 'https://next.example/v1',
   protocol: 'chat-completions', jsonMode: 'object', apiKey: key,
  }, old.id, old.revision);
  return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"value":"wrong"}' }] }] });
 });
 const first = await POST(testRequest(old.id, old.revision));
 assert.equal(first.status, 409);
 assert.equal((await selectProfile('local-owner', next.id)).profile!.imageTest.status, 'unverified');

 transport.mock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(String(url), 'https://next.example/v1/chat/completions');
  assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + key);
  const request = JSON.parse(String(init?.body));
  assert.equal(request.model, 'second-model');
  assert.equal(request.response_format.type, 'json_object');
  const pixels = request.messages.at(-1).content.find((part: { type: string }) => part.type === 'image_url').image_url.url;
  const { info, data } = await sharp(Buffer.from(pixels.split(',')[1], 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const palette: Record<string,string> = { '255,0,0':'red','0,128,0':'green','0,0,255':'blue','255,255,0':'yellow','255,0,255':'magenta','0,255,255':'cyan' };
  const colors = Array.from({ length: 6 }, (_, i) => {
   const x = Math.floor((i % 3 + 0.5) * info.width / 3);
   const y = Math.floor((Math.floor(i / 3) + 0.5) * info.height / 2);
   const offset = (y * info.width + x) * info.channels;
   return palette[data.subarray(offset, offset + 3).join(',')];
  });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ value: colors.join(',') }) } }] });
 });
 const tested = await POST(testRequest(next.id, next.revision));
 assert.equal(tested.status, 200);
 assert.equal((await tested.json()).probe.status, 'passed');
 const refreshed = (await selectProfile('local-owner', next.id)).profile!;
 assert.equal(refreshed.model, 'second-model');
 assert.equal(refreshed.imageTest.status, 'passed');
 assert.equal(refreshed.textTest.status, 'unverified');
});

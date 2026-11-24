import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST } from '../app/api/personal/polish/route';
import { hashSecret } from '../lib/cloud/server/auth';
import { getRepository } from '../lib/cloud/server/repository';
import { saveProfile } from '../lib/server/ai/store';
import { aiTransport } from '../lib/server/ai/provider';
import { emptyPersonalInput } from '../lib/personal/schema';
import { polishInputSchema, type PolishRequest } from '../lib/personal/polish-schema';
import { builtinRuleSnapshot } from '../lib/personal/style-rules';

const original={...process.env},origin='http://127.0.0.1:3299';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const alice={id:randomUUID(),token:randomBytes(32).toString('base64url'),name:'polish_alice'};
const bob={id:randomUUID(),token:randomBytes(32).toString('base64url'),name:'polish_bob'};
const gate=randomBytes(32).toString('base64url'),secret='synthetic-polish-owner-secret';
let directory='';
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'xhs-polish-accounts-'));
 process.env={...process.env,NODE_ENV:'test',APP_MODE:'cloud',APP_ORIGIN:origin,CLOUD_LOCAL_TEST:'1',CLOUD_BACKEND:'sqlite',CLOUD_SQLITE_PATH:join(directory,'test.sqlite'),AI_CONFIG_SECRET:'synthetic-test-master-key-longer-than-32-characters'};
 delete process.env.VERCEL;
 process.env.SITE_ACCESS_HASH=await hashSecret('synthetic-gate-password');
 const repo=await getRepository();await repo.put('system','admin_bootstrapped',{done:true});
 await repo.put('gate_sessions',hash(gate),{expiresAt:Date.now()+60000,version:hash(process.env.SITE_ACCESS_HASH)});
 for(const u of [alice,bob]){
  await repo.put('users',u.id,{id:u.id,username:u.name,normalized:u.name,role:'user',mustChange:false,passwordHash:process.env.SITE_ACCESS_HASH,version:1,createdAt:new Date().toISOString()},u.id);
  await repo.put('user_sessions',hash(u.token),{expiresAt:Date.now()+60000,userId:u.id,version:1},u.id);
 }
});
after(async()=>{process.env=original;await rm(directory,{recursive:true,force:true});});
const payload:PolishRequest={scope:'body',fields:[{key:'body',text:'树影落在石板上，我停下来看了一会儿。'}],bases:[{input:polishInputSchema.strip().parse({...emptyPersonalInput,experience:'合成素材：公园散步',ruleSnapshot:builtinRuleSnapshot('daily')}),confirmedPrompt:'写眼前的树影，保留散步时的观察。',keys:['body']}]};
function request(user:typeof alice,profileId:string,identity=user.id){return new Request(origin+'/api/personal/polish',{method:'POST',headers:{origin,'content-type':'application/json','x-workspace-user':identity,'X-AI-Profile':profileId,cookie:`xhs-dev-gate=${gate}; xhs-dev-user=${user.token}`},body:JSON.stringify(payload)});}

test('润色接口核对账号和配置归属，任务中途改模型不改变已启动请求，失败不换服务且不泄密',async()=>{
 const fields={name:'合成个人配置',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:secret,model:'synthetic-before'};
 const profile=await saveProfile(alice.id,fields);
 const calls:{url:string;model:string}[]=[],logs:string[]=[];
 let started!:()=>void,release!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 const logger=mock.method(console,'error',(...args:unknown[])=>logs.push(args.join(' ')));
 const transport=mock.method(aiTransport,'fetch',async(url:RequestInfo|URL,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));calls.push({url:String(url),model:body.model});
  assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${secret}`);
  started();await hold;
  return Response.json({id:'test',object:'response',created_at:1,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({fields:payload.fields}),annotations:[]}]}]});
 });
 try{
  assert.equal((await POST(request(bob,profile.id))).status,404);
  assert.equal((await POST(request(alice,profile.id,bob.id))).status,409);
  assert.notEqual((await POST(new Request(origin+'/api/personal/polish',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(payload)}))).status,200);
  assert.equal(calls.length,0);
  const pending=POST(request(alice,profile.id));await began;
  await saveProfile(alice.id,{...fields,apiKey:'',model:'synthetic-after'},profile.id,profile.revision);
  release();const result=await pending;assert.equal(result.status,200);
  const text=await result.text();assert.equal(JSON.parse(text).model,'synthetic-before');assert.doesNotMatch(text,/synthetic-polish-owner-secret/);
  assert.deepEqual(calls,[{url:'https://api.openai.com/v1/responses',model:'synthetic-before'}]);
  transport.mock.restore();let failures=0;
  const failing=mock.method(aiTransport,'fetch',async()=>{failures++;return Response.json({error:{message:`private-upstream ${secret}`}}, {status:401});});
  try{const response=await POST(request(alice,profile.id));assert.equal(response.status,503);const failure=await response.text();assert.equal(JSON.parse(failure).error.code,'INVALID_KEY');assert.doesNotMatch(failure,/private-upstream|synthetic-polish-owner-secret/);assert.equal(failures,1);}finally{failing.mock.restore();}
  assert.doesNotMatch(logs.join('\n'),/private-upstream|synthetic-polish-owner-secret|树影/);
 }finally{release();transport.mock.restore();logger.mock.restore();}
});

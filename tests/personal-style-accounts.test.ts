import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../app/api/personal/styles/route';
import { POST as trialPost } from '../app/api/personal/styles/test/route';
import { hashSecret } from '../lib/cloud/server/auth';
import { getRepository } from '../lib/cloud/server/repository';
import { emptyPersonalInput } from '../lib/personal/schema';
import { builtinRuleSnapshot } from '../lib/personal/style-rules';

const original={...process.env},origin='http://127.0.0.1:3298',hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const alice={id:randomUUID(),token:randomBytes(32).toString('base64url'),name:'style_alice'},bob={id:randomUUID(),token:randomBytes(32).toString('base64url'),name:'style_bob'},gate=randomBytes(32).toString('base64url');let directory='';
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'xhs-style-accounts-'));process.env={...process.env,NODE_ENV:'test',APP_MODE:'cloud',APP_ORIGIN:origin,CLOUD_LOCAL_TEST:'1',CLOUD_BACKEND:'sqlite',CLOUD_SQLITE_PATH:join(directory,'records.sqlite')};delete process.env.VERCEL;
 process.env.SITE_ACCESS_HASH=await hashSecret('synthetic-gate-password');const repo=await getRepository();await repo.put('system','admin_bootstrapped',{done:true});await repo.put('gate_sessions',hash(gate),{expiresAt:Date.now()+60000,version:hash(process.env.SITE_ACCESS_HASH)});
 for(const u of [alice,bob]){await repo.put('users',u.id,{id:u.id,username:u.name,normalized:u.name,role:'user',mustChange:false,passwordHash:process.env.SITE_ACCESS_HASH,version:1,createdAt:new Date().toISOString()},u.id);await repo.put('user_sessions',hash(u.token),{expiresAt:Date.now()+60000,userId:u.id,version:1},u.id);}
});
after(async()=>{process.env=original;await rm(directory,{recursive:true,force:true});});
const headers=(u:typeof alice)=>({origin,'x-workspace-user':u.id,cookie:`xhs-dev-gate=${gate}; xhs-dev-user=${u.token}`});
const req=(u:typeof alice,body?:unknown)=>new Request(origin+'/api/personal/styles',{method:body===undefined?'GET':'POST',headers:{...headers(u),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('两个真实认证测试账号分别初始化和保存，读取/修改/复制/启用/试生成均检查归属',async()=>{
 const a=await (await GET(req(alice))).json(),b=await (await GET(req(bob))).json();assert.equal(a.styles.length,4);assert.deepEqual(a,b);
 const created=await (await POST(req(alice,{action:'create'}))).json(),style=created.style;
 assert.equal((await GET(req(bob))).status,200);assert.equal((await (await GET(req(bob))).json()).styles.length,4);
 for(const action of ['save','copy','activate','deactivate','delete','restore']){const r=await POST(req(bob,{action,id:style.id,revision:style.revision,versionId:style.draftVersionId,content:builtinRuleSnapshot('daily').content}));assert.equal(r.status,404,action);}
 const form=new FormData();form.set('payload',JSON.stringify({id:style.id,versionId:style.draftVersionId,kind:'body',input:{...emptyPersonalInput,experience:'合成测试素材'},imageIds:[]}));assert.equal((await trialPost(new Request(origin+'/api/personal/styles/test',{method:'POST',headers:headers(bob),body:form}))).status,404);
 const wrong=new Request(origin+'/api/personal/styles',{headers:{...headers(alice),'x-workspace-user':bob.id}});assert.equal((await GET(wrong)).status,409);
 assert.notEqual((await GET(new Request(origin+'/api/personal/styles'))).status,200);
 const saved=await POST(req(alice,{action:'save',id:'daily',revision:1,content:{...builtinRuleSnapshot('daily').content,name:'Alice 的日常'}}));assert.equal(saved.status,200);const currentA=await (await GET(req(alice))).json(),currentB=await (await GET(req(bob))).json();assert.equal(currentA.styles.find((s:{id:string})=>s.id==='daily').versions.length,2);assert.equal(currentB.styles.find((s:{id:string})=>s.id==='daily').versions.length,1);
});

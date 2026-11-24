import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRepository } from '../lib/cloud/server/repository';
import { createDataService, type PhotoWire } from '../lib/cloud/server/data';
import { MAX_CLOUD_DATA_BYTES,readJson } from '../lib/cloud/server/config';
import { newVideoDraft,videoDraftSchema } from '../lib/video/drafts';
import { emptyBrief } from '../lib/schema';
import type { BlobStorage } from '../lib/cloud/server/blobs';

// Synthetic maximum-size content only; no user data or network access.
function largeVideo(char:string){
 const t=(n:number)=>char.repeat(n), draft=newVideoDraft();
 draft.name=t(80);
 const brief={...draft.brief,topic:t(100),details:t(2000),location:t(200),customStyle:t(1000),audience:t(200),mustInclude:t(500),forbidden:t(500)};
 const footage={...draft.footage,materials:t(5000),durations:t(1000),keep:t(1000),exclude:t(1000),focus:t(1000),requirements:t(2000)};
 const shot={shotId:t(80),start:0,end:1,visual:t(1000),method:t(600),voice:t(2000),subtitle:t(600),editing:t(800),materialIds:Array.from({length:60},()=>t(80))};
 const plan={coreIdea:t(2000),opening:t(1000),titles:Array.from({length:5},()=>t(150)),cover:{headline:t(100),subline:t(200),visualIdea:t(1000)},shots:Array.from({length:24},()=>shot),preparation:t(3000),notes:t(3000),editingAdvice:{transitions:t(1000),rhythm:t(1000),originalAudio:t(1000),music:t(1000)},body:t(8000),hashtags:Array.from({length:30},()=>t(2000)),warnings:Array.from({length:12},()=>t(500))};
 const now=new Date().toISOString();
 const generation={result:plan,input:{phase:'after' as const,brief,footage,shootingReference:plan},edited:true,mode:'live' as const,meta:{durationMs:1,completedAt:now}};
 return videoDraftSchema.parse({...draft,brief,footage,before:generation,after:generation});
}

test('极限视频草稿可通过 8 MiB 请求上限，超限拒绝，列表仅查询轻量摘要',async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),'xhs-cloud-limit-'));
 process.env={...prior,APP_MODE:'cloud',APP_ORIGIN:'http://127.0.0.1:3022',CLOUD_LOCAL_TEST:'1',CLOUD_BACKEND:'sqlite',CLOUD_SQLITE_PATH:join(dir,'records.sqlite')};
 const blobs:BlobStorage={async put(k){return k;},async get(){return Buffer.from('x');},async remove(){}};
 try{
  const db=await createRepository();
  const guarded={...db,async scanSafe<T>(bucket:Parameters<typeof db.scanSafe>[0],owner:string){assert.notEqual(bucket,'photos');assert.notEqual(bucket,'videos');return db.scanSafe<T>(bucket,owner);}};
  const service=createDataService(guarded,blobs),owner=randomUUID();
  for(const char of ['中','\u0000']){
   const draft=largeVideo(char),payload={action:'video-write',draft,expected:null,active:true},json=JSON.stringify(payload);
   assert.ok(Buffer.byteLength(json)<MAX_CLOUD_DATA_BYTES);
   assert.ok(Buffer.byteLength(JSON.stringify({bucket:'videos',id:`${owner}:${draft.id}`,owner,json:JSON.stringify(draft)}))<16*1024*1024);
   const request=new Request('http://127.0.0.1:3022/api/cloud/data',{method:'POST',headers:{'content-type':'application/json'},body:json});
   const received=await readJson(request,MAX_CLOUD_DATA_BYTES) as typeof payload;
   const saved=await service.saveVideo(owner,received.draft,null);assert.equal(saved.revision,1);
   assert.equal((await service.video(owner,draft.id)).after?.result.body,draft.after?.result.body);
   await assert.rejects(service.saveVideo(owner,draft,null),/其他设备/);
  }
  const now=new Date().toISOString();const photo:PhotoWire={version:2,revision:0,id:randomUUID(),name:'摘要测试',createdAt:now,updatedAt:now,brief:{...emptyBrief},mode:'demo',imageIds:[],resultImageIds:[],assets:[],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false};
  await service.savePhoto(owner,photo,null);
  const longTime=`2026-01-01T00:00:00.${'1'.repeat(100)}Z`;
  await assert.rejects(service.savePhoto(owner,{...photo,id:randomUUID(),updatedAt:longTime},null),/时间/);
  const template={version:1,id:randomUUID(),name:'测试',updatedAt:longTime,preferences:{tone:'自然分享',audience:'',length:'medium',emoji:false,styleNotes:'',forbidden:''}};
  await assert.rejects(service.saveTemplate(owner,template),/模板内容/);
  const videos=await service.videos(owner),photos=await service.photoWorkspace(owner);
  assert.equal(videos.summaries.length,2);assert.ok(Buffer.byteLength(JSON.stringify(videos))<2048);assert.equal(photos.drafts.length,1);
  const tooLarge=new Request('http://127.0.0.1:3022/api/cloud/data',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(MAX_CLOUD_DATA_BYTES+1)});
  await assert.rejects(readJson(tooLarge,MAX_CLOUD_DATA_BYTES),(e:unknown)=>e instanceof Error&&'status' in e&&e.status===413);
  const invalid=newVideoDraft();invalid.createdAt='x'.repeat(1000);await assert.rejects(service.saveVideo(owner,invalid,null),/时间格式/);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test('真实云数据路由接收超 512 KiB 中文方案并拒绝超过上限的请求',async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),'xhs-cloud-route-limit-')),origin='http://127.0.0.1:3022';
 const {hashSecret,gateCookieName,userCookieName}=await import('../lib/cloud/server/auth');
 process.env={...prior,NODE_ENV:'test',APP_MODE:'cloud',APP_ORIGIN:origin,CLOUD_LOCAL_TEST:'1',CLOUD_BACKEND:'sqlite',CLOUD_SQLITE_PATH:join(dir,'records.sqlite'),SITE_ACCESS_HASH:await hashSecret('synthetic gate secret'),ADMIN_BOOTSTRAP_HASH:await hashSecret('synthetic bootstrap secret')};
 try{
  const auth=await import('../app/api/cloud/auth/[action]/route'),data=await import('../app/api/cloud/data/route');
  const ctx=(action:string)=>({params:Promise.resolve({action})});
  const call=(action:string,body:unknown,cookie='')=>auth.POST(new Request(`${origin}/api/cloud/auth/${action}`,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(body)}),ctx(action));
  const cookie=(r:Response,name:string)=>{const found=(r.headers.get('set-cookie')||'').match(new RegExp(`(?:^|,\\s*)(${name}=[^;]+)`));assert.ok(found);return found[1];};
  const gate=cookie(await call('gate',{secret:'synthetic gate secret'}),gateCookieName());
  const setup=await call('setup',{bootstrapSecret:'synthetic bootstrap secret',username:'admin_test',password:'synthetic-password-123'},gate);assert.equal(setup.status,200);
  const both=`${gate}; ${cookie(setup,userCookieName())}`;
  const status=await auth.GET(new Request(`${origin}/api/cloud/auth/status`,{headers:{cookie:both}}),ctx('status'));const user=(await status.json()).user;
  const headers={origin,cookie:both,'x-workspace-user':user.id,'content-type':'application/json'};
  const draft=largeVideo('中'),json=JSON.stringify({action:'video-write',draft,expected:null,active:true});assert.ok(Buffer.byteLength(json)>512*1024);
  const response=await data.POST(new Request(`${origin}/api/cloud/data`,{method:'POST',headers,body:json}));assert.equal(response.status,200);assert.equal((await response.json()).revision,1);
  const oversized=await data.POST(new Request(`${origin}/api/cloud/data`,{method:'POST',headers,body:' '.repeat(MAX_CLOUD_DATA_BYTES+1)}));assert.equal(oversized.status,413);
  const result=await data.GET(new Request(`${origin}/api/cloud/data?kind=video&id=${draft.id}`,{headers:{cookie:both,'x-workspace-user':user.id}}));assert.equal(result.status,200);assert.equal((await result.json()).revision,1);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

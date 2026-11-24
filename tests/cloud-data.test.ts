import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createRepository } from "../lib/cloud/server/repository";
import { createDataService, type PhotoWire } from "../lib/cloud/server/data";
import { emptyBrief } from "../lib/schema";
import { createDemoResult } from "../lib/demo";
import { newVideoDraft } from "../lib/video/drafts";
import type { BlobStorage } from "../lib/cloud/server/blobs";

// Synthetic users, images and file storage only. The test never reads .env.local or contacts the network.
test("云图文、图片、视频和模板按用户隔离；复制与延迟清理保护共享图片",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-store-test-"));
 process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};
 const saved=new Map<string,Buffer>();let failRemove=false;
 const blobs:BlobStorage={async put(k,b){saved.set(k,Buffer.from(b));return k;},async get(k){const b=saved.get(k);if(!b)throw new Error("missing");return b;},async remove(k){if(failRemove)throw new Error("injected failure");saved.delete(k);}};
 try{
  const repo=await createRepository(),service=createDataService(repo,blobs),a=randomUUID(),b=randomUUID(),imageId=randomUUID(),id=randomUUID();
  const bytes=await sharp({create:{width:12,height:10,channels:3,background:"#aabbcc"}}).png().toBuffer();
  const png=new File([new Uint8Array(bytes)],"synthetic.png",{type:"image/png"});
  await service.upload(a,imageId,png);
  await assert.rejects(service.upload(a,imageId,new File(["wrong"],"fake.png",{type:"image/png"})),/不完整/);
  await assert.rejects(service.image(b,imageId),/没有找到/);
  assert.deepEqual((await service.image(a,imageId)).bytes,bytes);
  const time=new Date().toISOString();
  const draft:PhotoWire={version:2,revision:0,id,name:"测试草稿",createdAt:time,updatedAt:time,brief:{...emptyBrief,topic:"测试主题"},mode:"demo",imageIds:[imageId],resultImageIds:[],assets:[{id:imageId,name:"synthetic.png",lastModified:0,width:12,height:10,type:"image/png"}],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false};
  await assert.rejects(service.savePhoto(b,draft,null),/图片尚未保存/);
  const first=await service.savePhoto(a,{...draft,apiKey:"NEVER_STORE",accessToken:"NEVER_STORE"},null);assert.equal(first.revision,1);
  assert.ok(!JSON.stringify(await repo.get("photos",`${a}:${id}`)).includes("NEVER_STORE"));
  assert.ok(!/"(?:ref|refs)"\s*:/u.test(JSON.stringify(await service.photo(a,id))));
  await assert.rejects(service.photo(b,id),/没有找到/);await assert.rejects(service.deletePhoto(b,id),/没有找到/);
  assert.equal((await service.photoWorkspace(a)).drafts.length,1);assert.equal((await service.photoWorkspace(b)).drafts.length,0);
  const copiedId=randomUUID();await service.savePhoto(a,{...first,id:copiedId,name:"副本"},null);
  await assert.rejects(service.savePhoto(a,first,0),/其他设备/);
  await service.deletePhoto(a,id);assert.equal((await service.photo(a,copiedId)).name,"副本");
  let gc=await service.cleanup(Date.now()+48*60*60_000);assert.equal(gc.removed,0);assert.deepEqual((await service.image(a,imageId)).bytes,bytes);
  await service.deletePhoto(a,copiedId);failRemove=true;const later=Date.now()+48*60*60_000;gc=await service.cleanup(later);assert.deepEqual(gc,{removed:0,failed:1});
  await assert.rejects(service.image(a,imageId),/没有找到/);failRemove=false;
  gc=await service.cleanup(later+61_000);assert.deepEqual(gc,{removed:1,failed:0});assert.equal(saved.size,0);
  await assert.rejects(service.savePhoto(a,draft,null),/图片尚未保存/);
  const vid=newVideoDraft();vid.name="独立视频测试";const video=await service.saveVideo(a,vid,null);
  assert.equal((await service.videos(a)).summaries[0]?.name,video.name);assert.equal((await service.videos(b)).summaries.length,0);await assert.rejects(service.deleteVideo(b,vid.id),/没有找到/);
  const template={version:1 as const,id:randomUUID(),name:"测试风格",updatedAt:time,preferences:{tone:"自然分享" as const,audience:"",length:"medium" as const,emoji:false,styleNotes:"",forbidden:""}};
  await service.saveTemplate(a,template);assert.equal((await service.templates(a)).length,1);assert.equal((await service.templates(b)).length,0);await assert.rejects(service.deleteTemplate(b,template.id),/没有找到/);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("云端旧草稿升级后禁止低版本覆盖，图片和用户隔离不变",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-version-test-"));
 process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};
 const saved=new Map<string,Buffer>();
 const blobs:BlobStorage={async put(k,b){saved.set(k,Buffer.from(b));return k;},async get(k){const b=saved.get(k);if(!b)throw new Error("missing");return b;},async remove(k){saved.delete(k);}};
 try {
  const repo=await createRepository(),service=createDataService(repo,blobs),owner=randomUUID(),other=randomUUID(),imageId=randomUUID(),id=randomUUID(),time=new Date().toISOString();
  const bytes=await sharp({create:{width:10,height:10,channels:3,background:"#bbccdd"}}).png().toBuffer();
  await service.upload(owner,imageId,new File([new Uint8Array(bytes)],"synthetic.png",{type:"image/png"}));
  const brief={...emptyBrief,topic:"旧主题"};
  const v2:PhotoWire={version:2,revision:0,id,name:"旧草稿",createdAt:time,updatedAt:time,brief,mode:"demo",imageIds:[imageId],resultImageIds:[imageId],assets:[{id:imageId,name:"synthetic.png",lastModified:0,width:10,height:10,type:"image/png"}],generation:{mode:"demo",result:createDemoResult([imageId]),imageIds:[imageId],meta:{durationMs:1,completedAt:time}},generatedInput:{brief,mode:"demo",imageIds:[imageId]},selectedTitleIndex:0,hasUserEdits:false};
  const old=await service.savePhoto(owner,v2,null);
  const research={status:"success" as const,retrievedAt:time,notice:"测试资料",sources:[{title:"公开信息",url:"https://www.gov.cn/test",source:"政府网站",snippet:"合成摘要"}]};
  const upgraded=await service.savePhoto(owner,{...old,version:3,brief:{...old.brief,creationTypes:["travel"],primaryType:"travel",referenceText:"合成参考"},generation:{...old.generation!,research}},old.revision);
  assert.equal(upgraded.version,3);assert.equal(upgraded.brief.referenceText,"合成参考");
  await assert.rejects(service.savePhoto(owner,{...old,revision:upgraded.revision},upgraded.revision),/较新版本/);
  await assert.rejects(service.savePhoto(owner,{...old,revision:old.revision},old.revision),/其他设备/);
  const restored=await service.photo(owner,id);
  assert.equal(restored.brief.referenceText,"合成参考");assert.deepEqual(restored.generation!.research,research);
  assert.deepEqual(restored.generation!.result.imageCaptions.map(c=>c.imageId),[imageId]);
  await assert.rejects(service.photo(other,id),/没有找到/);await assert.rejects(service.image(other,imageId),/没有找到/);
  assert.deepEqual((await service.image(owner,imageId)).bytes,bytes);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("图片上传响应丢失或事务失败时不删除已提交图片，遗留对象可安全重试清理",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-asset-test-"));
 process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};
 const objects=new Map<string,Buffer>();let deleteFailures=0;
 const blobs:BlobStorage={async put(k,b){objects.set(k,Buffer.from(b));return k;},async get(k){const v=objects.get(k);if(!v)throw Error("missing");return v;},async remove(k){if(deleteFailures-->0)throw Error("simulated failure");objects.delete(k);}};
 try{
  const db=await createRepository();const bytes=await sharp({create:{width:12,height:10,channels:3,background:"#abcdef"}}).png().toBuffer();const file=new File([new Uint8Array(bytes)],"synthetic.png",{type:"image/png"});const owner=randomUUID();
  let loseAck=true;const ackRepo={...db,async transaction<T>(fn:Parameters<typeof db.transaction<T>>[0]){const r=await db.transaction(fn);if(loseAck){loseAck=false;throw Error("simulated lost commit response");}return r;}};
  const committed=createDataService(ackRepo,blobs),id=randomUUID();await committed.upload(owner,id,file);assert.deepEqual((await committed.image(owner,id)).bytes,bytes);assert.equal(objects.size,1);
  const time=new Date().toISOString(),draft:PhotoWire={version:2,revision:0,id:randomUUID(),name:"已引用的草稿",createdAt:time,updatedAt:time,brief:{...emptyBrief,topic:"测试"},mode:"demo",imageIds:[id],resultImageIds:[],assets:[{id,name:"synthetic.png",lastModified:0,width:12,height:10,type:"image/png"}],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false};await committed.savePhoto(owner,draft,null);
  let fail=true;const failRepo={...db,async transaction<T>(fn:Parameters<typeof db.transaction<T>>[0]){if(fail){fail=false;throw Error("simulated transaction failure");}return db.transaction(fn);}};
  const transient=createDataService(failRepo,blobs),id2=randomUUID();await assert.rejects(transient.upload(owner,id2,file),/simulated/);assert.equal((await db.scan("asset_uploads",owner)).length,1);assert.equal(objects.size,2);
  deleteFailures=1;const future=Date.now()+48*60*60_000;let result=await transient.cleanup(future,10);assert.ok(result.failed>=1);result=await transient.cleanup(future+61_000,10);assert.ok(result.removed>=1);assert.deepEqual((await committed.image(owner,id)).bytes,bytes);assert.equal(objects.size,1);
  const duplicate=randomUUID(),parallel=createDataService(db,blobs);await Promise.all([parallel.upload(owner,duplicate,file),parallel.upload(owner,duplicate,file)]);assert.equal((await db.scan("assets",owner)).filter(x=>(x.value as {id:string}).id===duplicate).length,1);assert.equal((await db.scan("asset_uploads",owner)).length,0);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("云草稿保留生成时的图片快照：换图后复制和删除原稿不影响旧配文",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-snapshot-test-"));process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};
 const files=new Map<string,Buffer>();const blobs:BlobStorage={async put(k,v){files.set(k,v);return k;},async get(k){const v=files.get(k);if(!v)throw Error("missing");return v;},async remove(k){files.delete(k);}};
 try{
  const service=createDataService(await createRepository(),blobs),owner=randomUUID(),oldId=randomUUID(),newId=randomUUID(),now=new Date().toISOString();
  const bytes=await sharp({create:{width:12,height:10,channels:3,background:"#d6aa8b"}}).png().toBuffer(),file=new File([new Uint8Array(bytes)],"synthetic.png",{type:"image/png"});
  await service.upload(owner,oldId,file);await service.upload(owner,newId,file);
  const asset=(id:string)=>({id,name:"synthetic.png",lastModified:0,width:12,height:10,type:"image/png"});
  const brief={...emptyBrief,topic:"快照测试"};
  const draft:PhotoWire={version:2,revision:0,id:randomUUID(),name:"原稿",createdAt:now,updatedAt:now,brief,mode:"demo",imageIds:[oldId],resultImageIds:[oldId],assets:[asset(oldId)],generation:{result:createDemoResult([oldId]),mode:"demo",imageIds:[oldId],meta:{durationMs:1,completedAt:now}},generatedInput:{brief,mode:"demo",imageIds:[oldId]},selectedTitleIndex:0,hasUserEdits:true};
  const first=await service.savePhoto(owner,draft,null),changed=await service.savePhoto(owner,{...first,imageIds:[newId],assets:[asset(newId),asset(oldId)]},first.revision);
  assert.deepEqual(changed.imageIds,[newId]);assert.deepEqual(changed.generation?.result.imageCaptions.map(c=>c.imageId),[oldId]);assert.deepEqual(changed.generatedInput?.imageIds,[oldId]);
  const copy=await service.savePhoto(owner,{...changed,id:randomUUID(),name:"副本"},null);await service.deletePhoto(owner,changed.id);
  assert.deepEqual((await service.photo(owner,copy.id)).resultImageIds,[oldId]);assert.deepEqual((await service.image(owner,oldId)).bytes,bytes);assert.deepEqual((await service.image(owner,newId)).bytes,bytes);
  assert.equal((await service.cleanup(Date.now()+48*60*60_000)).removed,0);await service.deletePhoto(owner,copy.id);assert.equal((await service.cleanup(Date.now()+48*60*60_000)).removed,2);assert.equal(files.size,0);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("单条损坏的云记录不会让其他草稿、视频和模板消失",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-corrupt-test-")),path=join(dir,"records.sqlite");process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:path};
 const blobs:BlobStorage={async put(k){return k;},async get(){return Buffer.from("x");},async remove(){}};
 try{
  const repo=await createRepository(),service=createDataService(repo,blobs),owner=randomUUID(),now=new Date().toISOString();
  const make=():PhotoWire=>({version:2,revision:0,id:randomUUID(),name:"测试草稿",createdAt:now,updatedAt:now,brief:{...emptyBrief},mode:"demo",imageIds:[],resultImageIds:[],assets:[],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false});
  const good=make(),bad=make();await service.savePhoto(owner,good,null);await service.savePhoto(owner,bad,null);
  const video=newVideoDraft();await service.saveVideo(owner,video,null);const badVideo=newVideoDraft();await service.saveVideo(owner,badVideo,null);
  const {DatabaseSync}=await import("node:sqlite");const sql=new DatabaseSync(path);sql.prepare("UPDATE records SET value=? WHERE bucket=? AND id=?").run("broken-json","photos",`${owner}:${bad.id}`);sql.prepare("UPDATE records SET value=? WHERE bucket=? AND id=?").run("broken-json","videos",`${owner}:${badVideo.id}`);sql.close();
  const rows=await service.photoWorkspace(owner);assert.equal(rows.drafts.length,2);assert.equal(rows.drafts.find(r=>r.id===bad.id)?.damaged,false);assert.equal(rows.drafts.find(r=>r.id===good.id)?.damaged,false);
  assert.equal((await service.photo(owner,good.id)).id,good.id);await assert.rejects(service.photo(owner,bad.id),(e:unknown)=>e instanceof Error&&"code" in e&&e.code==="CORRUPT_RECORD");
  const videos=await service.videos(owner);assert.equal(videos.summaries.length,2);assert.ok(videos.summaries.some(v=>v.id===video.id));assert.ok(videos.summaries.some(v=>v.id===badVideo.id));await assert.rejects(service.video(owner,badVideo.id),(e:unknown)=>e instanceof Error&&"code" in e&&e.code==="CORRUPT_RECORD");
  await assert.rejects(repo.scan("photos",owner)); // Security-sensitive/general scans remain fail closed.
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("图片清理使用索引限量读取，并在事务内复核被并发引用的图片",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-gc-test-"));process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};
 const files=new Map<string,Buffer>(),blobs:BlobStorage={async put(k,v){files.set(k,v);return k;},async get(k){const v=files.get(k);if(!v)throw Error("missing");return v;},async remove(k){files.delete(k);}};
 try{
  const db=await createRepository(),user=randomUUID(),id=randomUUID(),bytes=await sharp({create:{width:12,height:10,channels:3,background:"#abcded"}}).png().toBuffer(),file=new File([new Uint8Array(bytes)],"test.png",{type:"image/png"});
  const base=createDataService(db,blobs);await base.upload(user,id,file);const time=new Date().toISOString();const draft:PhotoWire={version:2,revision:0,id:randomUUID(),name:"并发引用",createdAt:time,updatedAt:time,brief:{...emptyBrief},mode:"demo",imageIds:[id],resultImageIds:[],assets:[{id,name:"test.png",lastModified:0,width:12,height:10,type:"image/png"}],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false};
  let linked=false,scans=0;const guarded={...db,async scan():Promise<never>{throw Error("cleanup must not perform a full scan");},async scanExpired<T>(bucket:string,now:number,limit:number){scans++;assert.ok(limit<=2);const rows=await db.scanExpired<T>(bucket,now,limit);if(bucket==="assets"&&!linked&&rows.length){linked=true;await base.savePhoto(user,draft,null);}return rows;}};
  const result=await createDataService(guarded,blobs).cleanup(Date.now()+48*60*60_000,2);assert.equal(result.removed,0);assert.ok(scans>0);assert.deepEqual((await base.image(user,id)).bytes,bytes);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("图片确实丢失与临时云存储错误分别处理，不能把网络故障误判成坏草稿",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-image-errors-"));process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};let mode:"ok"|"missing"|"network"="ok";const files=new Map<string,Buffer>();
 const blobs:BlobStorage={async put(k,v){files.set(k,v);return k;},async get(k){if(mode==="missing")throw Object.assign(new Error("safe"),{code:"BLOB_NOT_FOUND"});if(mode==="network")throw new Error("DOWNLOAD_FAILED");return files.get(k)!;},async remove(k){files.delete(k);}};
 try{const service=createDataService(await createRepository(),blobs),user=randomUUID(),id=randomUUID();const data=await sharp({create:{width:12,height:10,channels:3,background:"#abcdef"}}).png().toBuffer();await service.upload(user,id,new File([new Uint8Array(data)],"fixture.png",{type:"image/png"}));
  mode="missing";await assert.rejects(service.image(user,id),(e:unknown)=>e instanceof Error&&"code" in e&&e.code==="INVALID_IMAGE");
  mode="network";await assert.rejects(service.image(user,id),/DOWNLOAD_FAILED/);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test('更换全部输入和快照图片时，单事务数据库操作数不超过 CloudBase 上限',async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),'xhs-cloud-transaction-limit-'));process.env={...prior,APP_MODE:'cloud',APP_ORIGIN:'http://127.0.0.1:3022',CLOUD_LOCAL_TEST:'1',CLOUD_BACKEND:'sqlite',CLOUD_SQLITE_PATH:join(dir,'records.sqlite')};
 const blobs:BlobStorage={async put(k){return k;},async get(){return Buffer.from('x');},async remove(){}};
 try{
  const db=await createRepository(),owner=randomUUID(),now=new Date().toISOString(),oldIds=Array.from({length:18},()=>randomUUID()),newIds=Array.from({length:18},()=>randomUUID());
  // Seed isolated synthetic assets; no actual cloud files or user images are touched.
  for(const id of [...oldIds,...newIds])await db.put('assets',`${owner}:${id}`,{id,owner,ref:'synthetic',digest:'synthetic',type:'image/png',size:1,refs:0,unlinkedAt:null,status:'ready'},owner);
  const brief={...emptyBrief,topic:'事务边界测试'};
  const make=(ids:string[]):PhotoWire=>{const images=ids.slice(0,9),snapshots=ids.slice(9);return {version:2,revision:0,id:randomUUID(),name:'事务边界测试',createdAt:now,updatedAt:now,brief,mode:'demo',imageIds:images,resultImageIds:snapshots,assets:ids.map(id=>({id,name:'synthetic.png',lastModified:0,width:1,height:1,type:'image/png'})),generation:{result:createDemoResult(snapshots),mode:'demo',imageIds:snapshots,meta:{durationMs:1,completedAt:now}},generatedInput:{brief,mode:'demo',imageIds:snapshots},selectedTitleIndex:0,hasUserEdits:false};};
  let operations=0;const counted={...db,async transaction<T>(fn:Parameters<typeof db.transaction<T>>[0]){return db.transaction(async tx=>fn({async get(bucket,id){operations++;return tx.get(bucket,id);},async put(bucket,id,value,ownerId){operations++;return tx.put(bucket,id,value,ownerId);},async remove(bucket,id){operations++;return tx.remove(bucket,id);}}));}};
  const service=createDataService(counted,blobs),first=await service.savePhoto(owner,make(oldIds),null);operations=0;
  const next=make(newIds),saved=await service.savePhoto(owner,{...next,id:first.id},first.revision);
  assert.equal(operations,94);assert.ok(operations<=100,'single transaction must remain within CloudBase’s 100-operation limit');
  assert.deepEqual(saved.imageIds,newIds.slice(0,9));assert.deepEqual(saved.resultImageIds,newIds.slice(9));
  for(const id of oldIds)assert.equal((await db.get<{refs:number}>('assets',`${owner}:${id}`))?.refs,0);
  for(const id of newIds)assert.equal((await db.get<{refs:number}>('assets',`${owner}:${id}`))?.refs,1);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {IDBFactory} from "fake-indexeddb";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import sharp from "sharp";
import {newPersonalDraft,serializePersonalDraft,copyPersonalDraft,personalStoredSchema} from "../lib/personal/drafts";
import {personalLocalStore} from "../lib/personal/store";

test("旧个人草稿没有长度字段时可恢复，保留原有输入和生成内容",()=>{
 const draft=newPersonalDraft();draft.input.experience="合成的旧经历";draft.promptInput={...draft.input};draft.prompt="原有提示词";
 const stored=serializePersonalDraft(draft,0);
 const withoutLength=(input:typeof stored.input)=>{const {bodyLength: _length,customLength: _custom,...old}=input;void _length;void _custom;return old;};
 const restored=personalStoredSchema.parse({...stored,input:withoutLength(stored.input),promptInput:withoutLength(stored.promptInput!)});
 assert.equal(restored.input.bodyLength,"auto");assert.equal(restored.promptInput?.bodyLength,"auto");assert.equal(restored.input.experience,"合成的旧经历");assert.equal(restored.prompt,"原有提示词");
});
import {createRepository} from "../lib/cloud/server/repository";
import {createDataService} from "../lib/cloud/server/data";
import type {BlobStorage} from "../lib/cloud/server/blobs";
import {createDemoResult} from "../lib/demo";
import {formatPersonalBodyAndTags} from "../lib/personal/note-format";

test("历史标题选择仅兼容保存，未完成话题逐项原样恢复且复制正文不拼标题",async()=>{
 globalThis.indexedDB=new IDBFactory();const d=newPersonalDraft();d.input.experience="隔离测试";d.selectedTitleIndex=4;d.prompt="完整确认稿";d.promptInput={...d.input};
 d.generation={mode:"live",imageIds:[],result:createDemoResult([]),meta:{durationMs:1,completedAt:new Date().toISOString()}};
 d.generatedInput={input:{...d.input},confirmedPrompt:d.prompt,research:null,imageIds:[]};
 const raw=['##未完成','', '#', '##重复','#重复',' #标点! '];d.generation.result.hashtags=raw;
 await personalLocalStore.writeDraft(serializePersonalDraft(d,0),null);
 const saved=await personalLocalStore.getDraft(d.id);assert.deepEqual(saved.generation?.result.hashtags,raw);assert.equal(saved.selectedTitleIndex,4);assert.equal(saved.prompt,d.prompt);
 const result={...saved.generation!.result,hashtags:createDemoResult([]).hashtags};
 const copied=formatPersonalBodyAndTags(result);assert.ok(copied.startsWith(result.body+'\n\n'));for(const title of result.titles)assert.ok(!copied.includes(title));
});

test("个人草稿独立保存无图内容、已编辑提示词及结果，并保留旧图文库",async()=>{
 globalThis.indexedDB=new IDBFactory();const d=newPersonalDraft();d.input.experience="测试经历";d.prompt="我确认修改的提示词";d.promptInput={...d.input};d.generation={mode:"live",imageIds:[],result:{...createDemoResult([]),imageCaptions:[]},meta:{durationMs:1,completedAt:new Date().toISOString()}};d.generatedInput={input:{...d.input},confirmedPrompt:d.prompt,research:null,imageIds:[]};d.generation.result.body="用户修改的正文";
 const stored=await personalLocalStore.writeDraft(serializePersonalDraft(d,0),null);assert.equal(stored.revision,1);const restored=await personalLocalStore.getDraft(d.id);assert.equal(restored.generatedInput?.confirmedPrompt,d.prompt);assert.equal(restored.generation?.result.body,"用户修改的正文");assert.deepEqual(restored.assets,[]);assert.equal((await personalLocalStore.readWorkspace()).activeId,d.id);await assert.rejects(personalLocalStore.writeDraft(stored,0),/其他页面/);
});

test("个人草稿换序或删除输入图片后，旧结果仍保存生成时的图片及提示词快照",async()=>{
 globalThis.indexedDB=new IDBFactory();const d=newPersonalDraft(),files=["a","b"].map(name=>({id:randomUUID(),file:new File([name],`${name}.png`,{type:"image/png"}),preview:`blob:${name}`,width:8,height:8}));d.input.experience="原来的经历";d.images=[...files];d.resultImages=[...files];const ids=files.map(x=>x.id);d.prompt="确认的提示词";d.promptInput={...d.input};d.promptImageIds=[...ids];d.generatedInput={input:{...d.input},confirmedPrompt:d.prompt,research:null,imageIds:ids};d.generation={mode:"live",imageIds:ids,result:createDemoResult(ids),meta:{durationMs:1,completedAt:new Date().toISOString()}};d.input.experience="新的输入";d.images=[files[1]];const s=await personalLocalStore.writeDraft(serializePersonalDraft(d,0),null),restored=await personalLocalStore.getDraft(s.id);assert.deepEqual(restored.imageIds,[ids[1]]);assert.deepEqual(restored.resultImageIds,ids);assert.deepEqual(restored.generation?.result.imageCaptions.map(x=>x.imageId),ids);assert.equal(restored.assets.length,2);assert.equal(restored.generatedInput?.input.experience,"原来的经历");assert.equal(restored.generatedInput?.confirmedPrompt,"确认的提示词");assert.ok(!JSON.stringify(restored).includes("blob:a"));
});

test("云个人草稿、图片按账户隔离，复制和删除共享引用不会丢图",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-personal-test-"));process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};const files=new Map<string,Buffer>();const blobs:BlobStorage={async put(k,b){files.set(k,Buffer.from(b));return k;},async get(k){const b=files.get(k);if(!b)throw Error("missing");return b;},async remove(k){files.delete(k);}};
 try{const repo=await createRepository(),service=createDataService(repo,blobs),a=randomUUID(),b=randomUUID(),imageId=randomUUID();const bytes=await sharp({create:{width:8,height:8,channels:3,background:"#ff7777"}}).png().toBuffer();const file=new File([new Uint8Array(bytes)],"synthetic.png",{type:"image/png"});await service.upload(a,imageId,file);const d=newPersonalDraft();d.input.experience="合成测试";d.images=[{id:imageId,file,preview:"blob:test",width:8,height:8}];const stored=serializePersonalDraft(d,0),wire={...stored,assets:stored.assets.map(({blob,...asset})=>({...asset,type:blob.type}))};await assert.rejects(service.savePersonal(b,wire,null),/图片尚未保存/);const saved=await service.savePersonal(a,{...wire,apiKey:"SHOULD_NOT_PERSIST"},null);assert.ok(!JSON.stringify(saved).includes("SHOULD_NOT_PERSIST"));await assert.rejects(service.personal(b,d.id),/没有找到/);await assert.rejects(service.image(b,imageId),/没有找到/);assert.equal((await service.personalWorkspace(a)).summaries.length,1);assert.equal((await service.personalWorkspace(b)).summaries.length,0);const copied=copyPersonalDraft(stored);await service.savePersonal(a,{...wire,id:copied.id},null);await service.deletePersonal(a,d.id);assert.deepEqual((await service.image(a,imageId)).bytes,bytes);assert.equal((await service.personal(a,copied.id)).id,copied.id);assert.equal((await service.cleanup(Date.now()+48*3600_000)).removed,0);await service.deletePersonal(a,copied.id);assert.equal((await service.cleanup(Date.now()+48*3600_000)).removed,1);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

test("个人草稿替换 18 张输入和快照图片时，云端事务不超过操作上限",async()=>{
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-personal-limit-"));process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"records.sqlite")};const blobs:BlobStorage={async put(k){return k;},async get(){return Buffer.from("x");},async remove(){}};
 try{const db=await createRepository(),owner=randomUUID(),before=Array.from({length:18},()=>randomUUID()),after=Array.from({length:18},()=>randomUUID());for(const id of [...before,...after])await db.put("assets",`${owner}:${id}`,{id,owner,ref:"synthetic",digest:"synthetic",type:"image/png",size:1,refs:0,unlinkedAt:null,status:"ready"},owner);let operations=0;const counted={...db,async transaction<T>(fn:Parameters<typeof db.transaction<T>>[0]){return db.transaction(async tx=>fn({async get(bucket,id){operations++;return tx.get(bucket,id);},async put(bucket,id,value,user){operations++;return tx.put(bucket,id,value,user);},async remove(bucket,id){operations++;return tx.remove(bucket,id);}}));}};const service=createDataService(counted,blobs);function make(ids:string[]){const d=newPersonalDraft(),now=new Date().toISOString(),images=ids.slice(0,9),snapshots=ids.slice(9);d.input.experience="测试";d.images=images.map(id=>({id,file:new File(["x"],"x.png",{type:"image/png"}),preview:"blob:x",width:1,height:1}));d.resultImages=snapshots.map(id=>({id,file:new File(["x"],"x.png",{type:"image/png"}),preview:"blob:x",width:1,height:1}));d.generation={mode:"live",imageIds:snapshots,result:createDemoResult(snapshots),meta:{durationMs:1,completedAt:now}};d.generatedInput={input:{...d.input},confirmedPrompt:"测试",research:null,imageIds:snapshots};const stored=serializePersonalDraft(d,0);return {...stored,assets:stored.assets.map(({blob,...a})=>({...a,type:blob.type}))};}const first=await service.savePersonal(owner,make(before),null);operations=0;const next=make(after);await service.savePersonal(owner,{...next,id:first.id},first.revision);assert.equal(operations,94);assert.ok(operations<=100);
 }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonalHotspotStarter, personalDraftFromHotspot } from "../lib/personal/hotspot-transfer";
import { hotspotReferenceLink } from "../lib/personal/hotspot-reference";
import { newPersonalDraft, personalStoredSchema, serializePersonalDraft } from "../lib/personal/drafts";
import { personalLocalStore as store } from "../lib/personal/store";
import { personalRequestSchema } from "../lib/personal/schema";
import { isPersonalPromptStale } from "../lib/personal/flow";
import { createDemoResult } from "../lib/demo";
import { prepareCompletedNote } from "../lib/personal/completed";
import { createRepository } from "../lib/cloud/server/repository";
import { createDataService } from "../lib/cloud/server/data";
import type { BlobStorage } from "../lib/cloud/server/blobs";

const hotspot = { id:"synthetic-hotspot", title:"合成测试：城市公园秋日活动", description:"测试用公共摘要，不是真实新闻或用户经历。", source:"合成公开来源", url:"https://example.com/public-topic", publishedAt:null, collectedAt:"2026-11-02T00:00:00.000Z", rank:3 };
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

test("热点仅进入公共参考；个人经历、感受、提示词和结果均为空，仍需主动填写", () => {
  const a=personalDraftFromHotspot(hotspot),b=personalDraftFromHotspot(hotspot);
  assert.notEqual(a.id,b.id);
  assert.equal(a.input.hotspotReference?.title,hotspot.title);
  assert.equal(a.input.hotspotReference?.summary,hotspot.description);
  assert.equal(a.input.hotspotReference?.source,hotspot.source);
  assert.equal(a.input.hotspotReference?.url,hotspot.url);
  assert.equal(a.input.hotspotReference?.collectedAt,hotspot.collectedAt);
  assert.equal(a.input.hotspotReference?.publishedAt,null);
  for(const v of [a.input.experience,a.input.coreIntent,a.input.topic,a.input.requirements,a.input.referenceText,a.prompt])assert.equal(v,"");
  assert.equal(a.generation,null);assert.deepEqual(a.assets,[]);
  assert.equal(personalRequestSchema.safeParse({action:"prompt",input:a.input,imageIds:[]}).success,false);
  assert.throws(()=>personalDraftFromHotspot({...hotspot,url:"javascript:alert(1)"}),/来源链接/);
  assert.equal(hotspotReferenceLink("https://user:secret@example.com"),undefined);
  assert.equal(personalDraftFromHotspot({...hotspot,collectedAt:"unknown"}).input.hotspotReference?.collectedAt,null);
});

test("创建热点草稿不覆盖旧个人草稿、图片、已完成笔记；激活新的独立 ID",async()=>{
  const old=newPersonalDraft();old.input.experience="旧的手动编辑经历";
  old.images=[{id:crypto.randomUUID(),file:new File(["synthetic"],"test.png",{type:"image/png"}),width:2,height:2,preview:"blob:test"}];
  const previous=await store.writeDraft(serializePersonalDraft(old,0),null);
  const complete=newPersonalDraft();complete.input.experience="已完成测试";complete.prompt="确认稿";
  complete.generation={mode:"live",imageIds:[],result:createDemoResult([]),meta:{durationMs:1,completedAt:new Date().toISOString()}};
  complete.generatedInput={input:structuredClone(complete.input),confirmedPrompt:complete.prompt,imageIds:[],research:null};
  const note=await store.saveCompleted(await prepareCompletedNote(complete));
  const saved=await createPersonalHotspotStarter().start(store,"local",hotspot);
  assert.notEqual(saved.id,old.id);assert.deepEqual(await store.getDraft(old.id),previous);
  assert.deepEqual(await store.getCompleted(note.id),note);
  assert.equal((await store.readWorkspace()).activeId,saved.id);
  assert.deepEqual((await store.getDraft(saved.id)).input.hotspotReference,saved.input.hotspotReference);
});

test("快速重复点击只执行一次保存；响应丢失后重试不重复创建、不覆盖已编辑内容",async()=>{
  const starter=createPersonalHotspotStarter();let calls=0;
  const slow={async ensureDraft(v:ReturnType<typeof personalDraftFromHotspot>){calls++;await new Promise(r=>setTimeout(r,15));return store.ensureDraft(v);}};
  const [a,b]=await Promise.all([starter.start(slow,"local",hotspot),starter.start(slow,"local",hotspot)]);
  assert.equal(calls,1);assert.equal(a.id,b.id);
  const next=await store.writeDraft({...a,input:{...a.input,experience:"后来填写的真实经历"}},a.revision);
  await starter.start(store,"local",hotspot);
  assert.deepEqual(await store.getDraft(a.id),next);assert.equal((await store.readWorkspace()).summaries.length,1);
  const ambiguous=createPersonalHotspotStarter();
  await assert.rejects(ambiguous.start({async ensureDraft(v){await store.ensureDraft(v);throw Error("模拟响应丢失");}},"local",hotspot),/响应丢失/);
  const count=(await store.readWorkspace()).summaries.length;
  await ambiguous.start(store,"local",hotspot);assert.equal((await store.readWorkspace()).summaries.length,count);
});

test("存储失败不切换当前草稿；重试保持同一 ID，身份作用域不同不会复用",async()=>{
  const old=await store.writeDraft(serializePersonalDraft(newPersonalDraft(),0),null),starter=createPersonalHotspotStarter();let attempted="";
  await assert.rejects(starter.start({async ensureDraft(v){attempted=v.id;throw Error("模拟存储失败");}},"local",hotspot),/存储失败/);
  assert.equal((await store.readWorkspace()).activeId,old.id);assert.equal((await store.readWorkspace()).summaries.length,1);
  const retry=await starter.start(store,"local",hotspot);assert.equal(retry.id,attempted);
  const other=await starter.start(store,"cloud:another-user",hotspot);assert.notEqual(other.id,retry.id);
});

test("参考可编辑、删除、刷新恢复并触发提示词过期；旧草稿兼容空参考",async()=>{
  let d=await store.ensureDraft(personalDraftFromHotspot(hotspot));
  d=await store.writeDraft({...d,input:{...d.input,hotspotReference:{...d.input.hotspotReference!,title:"用户改后的标题",summary:"用户修改摘要",url:"https://未填写完"}}},d.revision);
  assert.equal((await store.getDraft(d.id)).input.hotspotReference?.summary,"用户修改摘要");
  const working=newPersonalDraft();working.input=d.input;working.promptInput=structuredClone(d.input);working.input={...d.input,hotspotReference:null};
  assert.equal(isPersonalPromptStale(working),true);
  d=await store.writeDraft({...d,input:working.input},d.revision);assert.equal((await store.getDraft(d.id)).input.hotspotReference,null);
  const {hotspotReference: _unused,...legacy}=d.input;void _unused;
  assert.equal(personalStoredSchema.parse({...d,input:legacy}).input.hotspotReference,null);
});

test("云端按账号保存热点参考，重试幂等且其他用户无法读取或修改",async()=>{
  const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-hotspot-personal-"));
  process.env={...prior,APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3022",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(dir,"test.sqlite")};
  const blobs:BlobStorage={async put(k){return k;},async get(){throw Error("No images expected");},async remove(){}};
  try {
    const service=createDataService(await createRepository(),blobs),owner=crypto.randomUUID(),other=crypto.randomUUID(),draft=personalDraftFromHotspot(hotspot);
    const saved=await service.ensurePersonal(owner,draft);await service.ensurePersonal(owner,draft);
    assert.deepEqual(saved.input.hotspotReference,draft.input.hotspotReference);
    assert.equal((await service.personalWorkspace(owner)).summaries.length,1);
    await assert.rejects(service.personal(other,draft.id),/没有找到/);
    await assert.rejects(service.savePersonal(other,{...draft,input:{...draft.input,experience:"越权修改"}},saved.revision));
    assert.equal((await service.personalWorkspace(other)).summaries.length,0);
    assert.equal((await service.personal(owner,draft.id)).input.experience,"");
  }finally{process.env=prior;await rm(dir,{recursive:true,force:true});}
});

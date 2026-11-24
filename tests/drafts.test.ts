import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { copyStoredDraft, formatDraftExport, inputSnapshot, isDraftStale, newDraft, serializeDraft, storedDraftSchema } from "../lib/drafts";
import { DATABASE_NAME, DATABASE_VERSION, localStore, storageMessage } from "../lib/local-store";
import { applyStyle, customStyleSchema, preferencesFromBrief, PRESET_STYLES } from "../lib/styles";
import { briefSchema, emptyBrief } from "../lib/schema";
import { createDemoResult } from "../lib/demo";
import { formatAll, textFilename } from "../lib/format";
import type { StudioImage } from "../lib/types";

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
function image(name: string): StudioImage {
  return { id: crypto.randomUUID(), file: new File([name], `${name}.png`, { type: "image/png", lastModified: 123 }), preview: `blob:temporary-${name}`, width: 100, height: 80 };
}
function populatedDraft() {
  const draft = newDraft();
  draft.name = "周末笔记"; draft.brief = { ...emptyBrief, topic: "咖啡随记", details: "  第一段\n\n第二段  " };
  draft.images = [image("sage"), image("coral")]; draft.resultImages = [...draft.images];
  const ids = draft.images.map((item) => item.id);
  draft.generation = { result: createDemoResult(ids), mode: "demo", imageIds: ids, meta: { durationMs: 12, completedAt: new Date().toISOString() } };
  draft.generatedInput = inputSnapshot(draft);
  return draft;
}

test("草稿保存独立图片快照：换序、删输入图后仍保留原配文的稳定 ID 与 Blob", () => {
  const draft = populatedDraft();
  assert.equal(isDraftStale(draft), false);
  const original = draft.images.map((item) => item.id);
  draft.images.reverse();
  assert.equal(isDraftStale(draft), true);
  const reordered = serializeDraft(draft, 3);
  assert.deepEqual(reordered.imageIds, [...original].reverse());
  assert.deepEqual(reordered.resultImageIds, original);
  draft.images.pop();
  const stored = serializeDraft(draft, 3);
  assert.equal(stored.imageIds.length, 1); assert.equal(stored.assets.length, 2);
  assert.deepEqual(stored.generation!.result.imageCaptions.map((item) => item.imageId), original);
  assert.deepEqual(stored.generatedInput!.imageIds, original);
  assert(stored.assets.every((item) => item.blob instanceof Blob));
});

test("草稿允许空白编辑并原样保留段落，不持久化临时 URL、口令或连接状态", () => {
  const draft = populatedDraft(); draft.generation!.result.titles[0] = ""; draft.generation!.result.body = "\n修改后的正文\n\n";
  Object.assign(draft, { accessToken: "DO_NOT_SAVE", liveCheck: "success", apiKey: "DO_NOT_SAVE" });
  Object.assign(draft.brief, { accessToken: "DO_NOT_SAVE" });
  const stored = serializeDraft(draft, 0);
  assert.equal(stored.brief.details, draft.brief.details);
  assert.equal(stored.generation!.result.titles[0], "");
  assert.equal(stored.generation!.result.body, "\n修改后的正文\n\n");
  assert(!JSON.stringify(stored).includes("DO_NOT_SAVE"));
  assert(!JSON.stringify(stored).includes("blob:temporary"));
  assert(!("liveCheck" in stored));
});

test("损坏版本、重复配文与缺少图片资产会被隔离，不能静默恢复错图", () => {
  const stored = serializeDraft(populatedDraft(), 0);
  assert.equal(storedDraftSchema.safeParse({ ...stored, version: 99 }).success, false);
  assert.equal(storedDraftSchema.safeParse({ ...stored, assets: stored.assets.slice(1) }).success, false);
  const bad = structuredClone(stored);
  bad.generation!.result.imageCaptions[1].imageId = bad.generation!.result.imageCaptions[0].imageId;
  const result = storedDraftSchema.safeParse(bad);
  assert.equal(result.success, false);
  if (!result.success) assert.match(storageMessage(result.error), /损坏/);
});

test("IndexedDB 提交后恢复完整 Blob、输入、编辑结果及当前草稿", async () => {
  const draft = populatedDraft(); draft.generation!.result.body = "已编辑第一段\n\n第二段";
  const saved = await localStore.writeDraft(serializeDraft(draft, 0), null);
  assert.equal(saved.revision, 1);
  const data = await localStore.readWorkspace();
  assert.equal(data.activeId, draft.id); assert.equal(data.drafts.length, 1);
  const restored = await localStore.getDraft(draft.id);
  assert.equal(restored.generation!.result.body, draft.generation!.result.body);
  assert.equal(restored.brief.details, draft.brief.details);
  assert.equal(await restored.assets[0].blob.text(), "sage");
  assert.equal(restored.assets[0].name, "sage.png");
});

test("本地 v2 草稿保存时升级到 v3，图片和结果快照保留并拒绝未来版本覆盖", async () => {
  const original = populatedDraft();
  const v2 = {...serializeDraft(original, 4), version: 2 as const};
  await localStore.readWorkspace();
  const db = await new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open(DATABASE_NAME,DATABASE_VERSION);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  try {
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction("drafts","readwrite");tx.objectStore("drafts").put(v2);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
    const read = await localStore.getDraft(original.id);
    assert.equal(read.version,2);assert.deepEqual(read.imageIds,v2.imageIds);assert.deepEqual(read.resultImageIds,v2.resultImageIds);
    const research={status:"success" as const,retrievedAt:"2026-10-30T00:00:00.000Z",notice:"测试资料",sources:[{title:"公开信息",url:"https://www.gov.cn/test",source:"政府网站",snippet:"合成摘要"}]};
    const changed={...read,brief:{...read.brief,creationTypes:["travel"] as "travel"[],primaryType:"travel" as const,referenceText:"新参考文字"},generation:{...read.generation!,research}};
    const upgraded=await localStore.writeDraft(changed,read.revision);
    assert.equal(upgraded.version,3);assert.equal(upgraded.brief.referenceText,"新参考文字");assert.deepEqual(upgraded.generation!.research,research);
    assert.deepEqual(upgraded.imageIds,v2.imageIds);assert.deepEqual(upgraded.resultImageIds,v2.resultImageIds);
    assert.deepEqual(upgraded.generation!.result.imageCaptions.map(c=>c.imageId),v2.resultImageIds);
    assert.equal(upgraded.assets.length,v2.assets.length);
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction("drafts","readwrite");tx.objectStore("drafts").put({...upgraded,version:4});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
    await assert.rejects(localStore.writeDraft(upgraded,upgraded.revision),/未覆盖/);
    const raw=await new Promise<unknown>((resolve,reject)=>{const tx=db.transaction("drafts","readonly"),q=tx.objectStore("drafts").get(original.id);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    assert.equal((raw as {version:number}).version,4);
  } finally { db.close(); }
});

test("复制草稿后编辑、删除原稿不影响副本图片和文案", async () => {
  const original = await localStore.writeDraft(serializeDraft(populatedDraft(), 0), null);
  const copy = copyStoredDraft(original);
  assert.notEqual(copy.id, original.id);
  copy.generation!.result.titles[0] = "副本独有标题";
  await localStore.writeDraft(copy, null);
  assert.notEqual((await localStore.getDraft(original.id)).generation!.result.titles[0], "副本独有标题");
  await localStore.deleteDraft(original.id);
  const remaining = await localStore.getDraft(copy.id);
  assert.equal(remaining.generation!.result.titles[0], "副本独有标题");
  assert.equal(await remaining.assets[0].blob.text(), "sage");
  assert.equal((await localStore.readWorkspace()).activeId, copy.id);
});

test("新建草稿与既有草稿独立；删除当前草稿同时清理活动指针", async () => {
  const original = await localStore.writeDraft(serializeDraft(populatedDraft(), 0), null);
  const blank = newDraft();
  await localStore.writeDraft(serializeDraft(blank, 0), null);
  assert.equal((await localStore.getDraft(blank.id)).assets.length, 0);
  assert.equal((await localStore.getDraft(original.id)).assets.length, 2);
  await localStore.deleteDraft(blank.id);
  assert.equal((await localStore.readWorkspace()).activeId, undefined);
});

test("多标签页过期写入被拒绝，已删除草稿不会被旧页面自动复活", async () => {
  const first = await localStore.writeDraft(serializeDraft(populatedDraft(), 0), null);
  const fresh = await localStore.writeDraft({ ...first, name: "另一页已更新" }, first.revision);
  await assert.rejects(() => localStore.writeDraft({ ...first, name: "过期页面" }, first.revision), /其他标签页/);
  assert.equal((await localStore.getDraft(first.id)).name, "另一页已更新");
  await localStore.deleteDraft(first.id);
  await assert.rejects(() => localStore.writeDraft(fresh, fresh.revision), /其他标签页/);
});

test("保留副本基于当前页的已保存快照，不会误复制其他标签页随后写入的内容", async () => {
  const page = populatedDraft();
  page.generation!.result.body = "当前页面的正文";
  page.generation!.result.imageCaptions[0].headline = "当前页图片文字";
  page.selectedTitleIndex = 2; page.hasUserEdits = true;
  const saved = await localStore.writeDraft(serializeDraft(page, 0), null);
  const localSnapshot = serializeDraft(page, saved.revision);
  const fromOtherTab = structuredClone(saved);
  fromOtherTab.generation!.result.body = "另一标签页的新正文";
  await localStore.writeDraft(fromOtherTab, saved.revision);
  const preserved = await localStore.preserveSnapshot(localSnapshot);
  assert.notEqual(preserved.id, saved.id);
  assert.match(preserved.name, /重新生成前/);
  assert.equal(preserved.generation!.result.body, "当前页面的正文");
  assert.equal(preserved.generation!.result.imageCaptions[0].headline, "当前页图片文字");
  assert.equal(preserved.selectedTitleIndex, 2);
  assert.deepEqual(preserved.resultImageIds, saved.resultImageIds);
  assert.equal((await localStore.getDraft(saved.id)).generation!.result.body, "另一标签页的新正文");
  assert.equal((await localStore.readWorkspace()).activeId, saved.id);
});

test("保留副本写入失败不影响当前草稿、指针或图片，并可稍后重试", async () => {
  const page = populatedDraft(); page.generation!.result.body = "必须保留的编辑";
  const saved = await localStore.writeDraft(serializeDraft(page, 0), null);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "drafts") throw new DOMException("simulated quota", "QuotaExceededError");
    return put.apply(this, args);
  };
  try { await assert.rejects(() => localStore.preserveSnapshot(saved), { name: "QuotaExceededError" }); }
  finally { IDBObjectStore.prototype.put = put; }
  const workspace = await localStore.readWorkspace();
  assert.equal(workspace.activeId, saved.id); assert.equal(workspace.drafts.length, 1);
  const original = await localStore.getDraft(saved.id);
  assert.equal(original.generation!.result.body, "必须保留的编辑");
  assert.equal(await original.assets[0].blob.text(), "sage");
  const copy = await localStore.preserveSnapshot(saved);
  assert.equal(copy.generation!.result.body, "必须保留的编辑");
  assert.equal((await localStore.readWorkspace()).drafts.length, 2);
});

test("保存事务发生空间不足时整体回滚，旧数据与当前指针保持一致", async () => {
  const initial = await localStore.writeDraft(serializeDraft(populatedDraft(), 0), null);
  const next = serializeDraft(newDraft(), 0);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    if (this.name === "settings") throw new DOMException("simulated quota", "QuotaExceededError");
    return put.apply(this, args);
  };
  try { await assert.rejects(() => localStore.writeDraft(next, null), { name: "QuotaExceededError" }); }
  finally { IDBObjectStore.prototype.put = put; }
  const workspace = await localStore.readWorkspace();
  assert.equal(workspace.activeId, initial.id); assert.equal(workspace.drafts.length, 1);
  assert.match(storageMessage(new DOMException("", "QuotaExceededError")), /当前内容仍在/);
  await localStore.writeDraft(next, null);
  assert.equal((await localStore.readWorkspace()).drafts.length, 2);
});

test("应用四种预设只更新六项偏好；反复应用不会拼接重复要求", () => {
  const brief = { ...emptyBrief, topic: "不能覆盖的主题", details: "仅本次要求", mustInclude: "保留必提内容", purpose: "探店推荐" as const };
  for (const template of PRESET_STYLES) {
    const next = applyStyle(brief, template.preferences);
    assert.equal(next.topic, brief.topic); assert.equal(next.details, brief.details);
    assert.equal(next.mustInclude, brief.mustInclude); assert.equal(next.purpose, brief.purpose);
    assert.deepEqual(preferencesFromBrief(next), template.preferences);
    assert.deepEqual(applyStyle(next, template.preferences), next);
  }
});

test("自定义模板保存、修改、重读、删除成功，白名单不包含主题和私人字段", async () => {
  const template = customStyleSchema.parse({ version: 1, id: crypto.randomUUID(), name: "我的风格", updatedAt: new Date().toISOString(), preferences: { ...emptyBrief, topic: "私有主题", accessToken: "DO_NOT_SAVE" } });
  await localStore.saveTemplate(template);
  assert.equal((await localStore.readWorkspace()).templates.length, 1);
  await localStore.saveTemplate({ ...template, name: "修改后的模板" });
  const data = await localStore.readWorkspace();
  assert.equal(data.templates.length, 1);
  assert.equal(customStyleSchema.parse(data.templates[0]).name, "修改后的模板");
  assert(!JSON.stringify(data.templates).includes("私有主题")); assert(!JSON.stringify(data.templates).includes("DO_NOT_SAVE"));
  await localStore.deleteTemplate(template.id);
  assert.equal((await localStore.readWorkspace()).templates.length, 0);
});

test("旧接口不带风格要求仍兼容；风格要求作为独立字段校验", () => {
  const { styleNotes: _, ...legacy } = { ...emptyBrief, topic: "兼容旧版" };
  void _;
  assert.equal(briefSchema.parse(legacy).styleNotes, "");
  assert.equal(briefSchema.safeParse({ ...legacy, styleNotes: "字".repeat(1001) }).success, false);
});

test("导出使用最新编辑、完整分段和统一话题；文件名过滤路径及保留名", () => {
  const result = populatedDraft().generation!.result;
  result.titles[0] = "最新标题"; result.body = "最新正文\n\n第二段";
  result.imageCaptions[0].headline = "最新配文"; result.hashtags = ["##周末 ＃周末 #咖啡"];
  const output = formatAll(result);
  for (const text of ["最新标题", "最新正文\n\n第二段", "最新配文", "【封面文案】", "#周末 #咖啡"]) assert(output.includes(text));
  assert.equal(textFilename("../周末:草稿?"), "_周末_草稿_.txt");
  assert.equal(textFilename("..."), "未命名草稿.txt");
  assert.equal(textFilename("CON"), "草稿_CON.txt");
});

test("草稿保存选中标题与编辑标记，复制草稿后可独立修改", async () => {
  const draft = populatedDraft();
  draft.selectedTitleIndex = 3; draft.hasUserEdits = true;
  const saved = await localStore.writeDraft(serializeDraft(draft, 0), null);
  const restored = await localStore.getDraft(draft.id);
  assert.equal(restored.selectedTitleIndex, 3);
  assert.equal(restored.hasUserEdits, true);
  const copy = copyStoredDraft(restored);
  copy.selectedTitleIndex = 1; copy.hasUserEdits = false;
  const writtenCopy = await localStore.writeDraft(copy, null, false);
  assert.equal(writtenCopy.selectedTitleIndex, 1);
  assert.equal(writtenCopy.hasUserEdits, false);
  assert.equal((await localStore.getDraft(draft.id)).selectedTitleIndex, 3);
  assert.equal((await localStore.readWorkspace()).activeId, draft.id);
  assert.equal(saved.version, 3);
});

test("旧版草稿无损读取，保存时迁移默认首标题并保守视为已编辑，旧标签不补造", async () => {
  const draft = populatedDraft();
  draft.generation!.result.hashtags = ["旧话题一", "#旧话题二", "旧话题三"];
  const initial = await localStore.writeDraft(serializeDraft(draft, 0), null);
  const { selectedTitleIndex: previousSelection, hasUserEdits: previousEditStatus, ...originalFields } = initial;
  void previousSelection; void previousEditStatus;
  const legacy = { ...originalFields, version: 1 as const };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put(legacy);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
  const before = await localStore.getDraft(draft.id);
  assert.equal(before.version, 1); assert.equal(before.selectedTitleIndex, undefined);
  assert.equal(before.hasUserEdits, undefined);
  assert.deepEqual(before.generation!.result.hashtags, ["旧话题一", "#旧话题二", "旧话题三"]);
  const migrated = await localStore.writeDraft(before, before.revision);
  assert.equal(migrated.version, 3); assert.equal(migrated.selectedTitleIndex, 0); assert.equal(migrated.hasUserEdits, true);
  assert.deepEqual(migrated.generation!.result.hashtags, before.generation!.result.hashtags);
  assert.deepEqual(migrated.resultImageIds, before.resultImageIds);
  await assert.rejects(() => localStore.writeDraft(before, before.revision), /其他标签页/);
});

test("不完整旧标签导出必须明确选择备份，并保留原始用户输入", () => {
  const draft = populatedDraft();
  draft.selectedTitleIndex = 2;
  draft.generation!.result.hashtags = ["##原标签 ＃原标签 #另一个"];
  assert.throws(() => formatDraftExport(draft), /10 个/);
  const backup = formatDraftExport(draft, true);
  assert.match(backup, /话题尚未达到 10 个/);
  assert.match(backup, /【选中的标题】/);
  assert(backup.includes(draft.generation!.result.titles[2]));
  assert(backup.includes("#原标签 #另一个"));
  assert(backup.includes("##原标签 ＃原标签 #另一个"));
});

test("完整 TXT 包含选择后的标题、最新正文、逐图配文和单行十个标签", () => {
  const draft = populatedDraft();
  draft.selectedTitleIndex = 4;
  draft.generation!.result.body = "最新正文\n\n保留分段";
  draft.generation!.result.imageCaptions[0].description = "最新逐图说明";
  draft.generation!.result.hashtags = Array.from({ length: 10 }, (_, i) => `#新话题${i + 1}`);
  const text = formatDraftExport(draft);
  assert(text.startsWith(`【选中的标题】\n${draft.generation!.result.titles[4]}`));
  assert(text.includes("最新正文\n\n保留分段"));
  assert(text.includes("最新逐图说明"));
  assert(text.includes(Array.from({ length: 10 }, (_, i) => `#新话题${i + 1}`).join(" ")));
  assert(!text.includes("【导出提醒】"));
});

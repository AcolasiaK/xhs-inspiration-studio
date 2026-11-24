import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { hotspotBrief, hotspotTransferSchema } from "../lib/hotspot-transfer";
import { newDraft, serializeDraft } from "../lib/drafts";
import { localStore } from "../lib/local-store";

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
const sample = { version: 1 as const, topic: "春日整理的观察", angle: "从日常习惯切入", headline: "从一个小角落开始", hotspotTitle: "整理趋势", source: "公开来源", url: "https://example.com/article" };

test("选题带入主题、角度、参考标题和来源，不能使用不安全的链接", () => {
  const brief = hotspotBrief(sample);
  assert.equal(brief.topic, sample.topic);
  for (const value of [sample.angle, sample.headline, sample.hotspotTitle, sample.source, sample.url]) assert(brief.details.includes(value));
  assert.equal(hotspotTransferSchema.safeParse({ ...sample, url: "javascript:alert(1)" }).success, false);
  assert.equal(hotspotBrief({ ...sample, topic: "题".repeat(150) }).topic.length, 100);
});

test("为热点创建新草稿后，原草稿的内容和图片不受影响", async () => {
  const original = newDraft();
  original.name = "原草稿"; original.brief.topic = "用户已有内容";
  original.images = [{ id: crypto.randomUUID(), file: new File(["synthetic"], "synthetic.png", { type: "image/png" }), preview: "blob:temporary", width: 2, height: 2 }];
  const saved = await localStore.writeDraft(serializeDraft(original, 0), null);
  const next = newDraft(); next.brief = hotspotBrief(sample); next.name = next.brief.topic.slice(0, 80);
  await localStore.writeDraft(serializeDraft(next, 0), null);
  const restored = await localStore.getDraft(saved.id);
  assert.equal(restored.brief.topic, "用户已有内容");
  assert.equal(await restored.assets[0].blob.text(), "synthetic");
  assert.equal((await localStore.getDraft(next.id)).brief.topic, sample.topic);
  assert.equal((await localStore.readWorkspace()).activeId, next.id);
});

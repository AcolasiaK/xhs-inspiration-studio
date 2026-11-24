import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createDemoResult } from "../lib/demo";
import { inputSnapshot, newDraft, serializeDraft } from "../lib/drafts";
import { localStore } from "../lib/local-store";
import { applyRewriteIfCurrent, submitRewrite } from "../lib/rewrite-request";
import type { StudioImage } from "../lib/types";

function setup() {
  const draft = newDraft();
  const image: StudioImage = { id: crypto.randomUUID(), file: new File(["image"], "synthetic.jpg", { type: "image/jpeg" }), preview: "blob:test", width: 10, height: 10 };
  draft.images = [image]; draft.resultImages = [image]; draft.brief.topic = "原主题"; draft.mode = "live";
  draft.generatedInput = inputSnapshot(draft);
  draft.generation = { mode: "live", imageIds: [image.id], result: createDemoResult([image.id]), meta: { durationMs: 2, completedAt: new Date().toISOString() } };
  draft.generation.result.body = "编辑后的原文";
  draft.brief.topic = "更新后的主题";
  const compress = async () => [new Blob(["image"], { type: "image/jpeg" })];
  const options = { brief: draft.generatedInput.brief, body: draft.generation.result.body, direction: "natural" as const, instruction: "", images: draft.resultImages,
    accessToken: "fake-test-token", controller: new AbortController(), compress, onProgress: () => undefined, onRequestStarted: () => undefined, timeoutMs: 1000 };
  const success = () => Response.json({ body: "新的正文\n\n第二段", meta: { durationMs: 10, completedAt: new Date().toISOString() } });
  return { draft, options, success };
}

test("重写成功前不修改草稿，确认后仅替换正文；发送生成时的要求和图片", async () => {
  const { draft, options, success } = setup();
  let count = 0;
  const original = structuredClone(draft.generation!.result);
  const rewritten = await submitRewrite({ ...options, request: async (url, init) => {
    count++; assert.equal(url, "/api/rewrite");
    const payload = JSON.parse(String((init!.body as FormData).get("payload")));
    assert.equal(payload.brief.topic, "原主题"); assert.equal(payload.body, "编辑后的原文");
    assert.deepEqual(payload.imageIds, draft.resultImages.map((image) => image.id)); assert.equal(payload.mode, "live");
    return success();
  } });
  assert.equal(count, 1); assert.deepEqual(draft.generation!.result, original);
  const applied = applyRewriteIfCurrent(draft, draft.id, original.body, draft.generation!.meta.completedAt, rewritten);
  assert.equal(applied.generation!.result.body, "新的正文\n\n第二段");
  assert.deepEqual({ ...applied.generation!.result, body: original.body }, original);
  assert.equal(applied.hasUserEdits, true);
});

test("正文重写的所选配置随请求发送，失败不会回退", async () => {
  const { options } = setup(); let count = 0;
  await assert.rejects(submitRewrite({ ...options, aiSource: "test-profile", request: async (_url, init) => {
    count++; assert.equal(new Headers(init!.headers).get("X-AI-Profile"), "test-profile");
    return Response.json({ error: { message: "测试失败" } }, { status: 502 });
  } }), /测试失败/);
  assert.equal(count, 1);
});

test("取消或旧请求不覆盖更新后的正文、另一份草稿或新的生成版本", () => {
  const { draft } = setup();
  const version = draft.generation!.meta.completedAt;
  assert.equal(applyRewriteIfCurrent(draft, crypto.randomUUID(), draft.generation!.result.body, version, "新文"), draft);
  assert.equal(applyRewriteIfCurrent(draft, draft.id, "已过期的原文", version, "新文"), draft);
  assert.equal(applyRewriteIfCurrent(draft, draft.id, draft.generation!.result.body, "旧版本", "新文"), draft);
  assert.equal(draft.generation!.result.body, "编辑后的原文");
});

test("模拟 502、超时和取消均保留原正文，且不会重试", async () => {
  for (const failure of ["502", "timeout", "cancel"] as const) {
    const { draft, options } = setup(); let count = 0;
    const initial = structuredClone(draft.generation!.result);
    const operation = submitRewrite({ ...options, timeoutMs: 10, request: async (_url, init) => {
      count++;
      if (failure === "502") return Response.json({ error: { message: "AI 服务返回异常（HTTP 502），原正文仍保留。" } }, { status: 502 });
      return new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        if (failure === "cancel") queueMicrotask(() => options.controller.abort());
      });
    } });
    await assert.rejects(operation, failure === "502" ? /502/ : failure === "timeout" ? /超时/ : /取消/);
    assert.equal(count, 1); assert.deepEqual(draft.generation!.result, initial);
  }
});

test("即使模拟网络忽略取消并延迟返回，也不会交付新正文", async () => {
  const { options, success } = setup();
  await assert.rejects(submitRewrite({ ...options, request: async () => { options.controller.abort(); return success(); } }), /取消/);
});

test("应用的新正文与其他内容可被本地草稿保存恢复", async () => {
  globalThis.indexedDB = new IDBFactory();
  const { draft } = setup();
  const applied = applyRewriteIfCurrent(draft, draft.id, draft.generation!.result.body, draft.generation!.meta.completedAt, "已确认的正文\n\n下一段");
  await localStore.writeDraft(serializeDraft(applied, 0), null);
  const restored = await localStore.getDraft(draft.id);
  assert.equal(restored.generation!.result.body, "已确认的正文\n\n下一段");
  assert.deepEqual(restored.generation!.result.hashtags, draft.generation!.result.hashtags);
  assert.deepEqual(restored.generation!.result.titles, draft.generation!.result.titles);
  assert.deepEqual(restored.generation!.result.imageCaptions, draft.generation!.result.imageCaptions);
});

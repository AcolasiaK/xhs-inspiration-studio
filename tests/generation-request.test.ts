import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createDemoResult } from "../lib/demo";
import { inputSnapshot, newDraft } from "../lib/drafts";
import { applyValidatedGeneration, GENERATION_CLIENT_TIMEOUT_MS, GenerationRequestError, generationErrorMessage, runRegenerationChoice, submitGeneration } from "../lib/generation-request";
import type { StudioImage } from "../lib/types";
import { isRequestId, measurePreservation, recordClientDiagnostic, safeServerStage } from "../lib/client-diagnostics";

function image(name: string): StudioImage {
  return { id: crypto.randomUUID(), file: new File([name], name, { type: "image/jpeg" }), preview: `blob:${name}`, width: 20, height: 20 };
}
function makeHarness() {
  const draft = newDraft();
  draft.brief = { ...draft.brief, topic: "测试主题", audience: "目标读者" };
  draft.images = [image("second.jpg"), image("first.jpg")]; draft.mode = "live";
  const ids = draft.images.map((item) => item.id);
  const previous = createDemoResult(ids); previous.body = "用户修改后的旧正文";
  draft.generation = { result: previous, mode: "live", imageIds: ids, meta: { durationMs: 2, completedAt: new Date().toISOString() } };
  draft.resultImages = [...draft.images]; draft.generatedInput = inputSnapshot(draft); draft.hasUserEdits = true;
  let current = draft, copies = 0, requests = 0, starts = 0;
  const savedCopies: typeof draft[] = [];
  const lock = { current: false };
  const controller = new AbortController();
  const compress = async (items: StudioImage[], progress: (done: number, total: number) => void) => {
    progress(items.length, items.length); return items.map((item) => new Blob([item.file.name], { type: "image/jpeg" }));
  };
  const success = () => {
    const result = createDemoResult(ids); result.body = "新生成的正文"; result.imageCaptions.reverse();
    return Response.json({ result, mode: "live", meta: { durationMs: 10, completedAt: new Date().toISOString() } });
  };
  function choice(preserve: boolean, response: (signal: AbortSignal) => Promise<Response>, timeoutMs = 1000) {
    return runRegenerationChoice(lock, preserve, async () => { copies++; savedCopies.push(structuredClone(current)); return true; }, async () => {
      const submitted = inputSnapshot(current);
      const startDraftId = current.id;
      const uploaded = [...current.images];
      const output = await submitGeneration({
        brief: current.brief, mode: current.mode, images: uploaded, accessToken: "test-private-token", controller,
        compress, timeoutMs, onProgress: () => undefined, onRequestStarted: () => { starts++; },
        request: async (_url, init) => {
          requests++;
          assert.equal(init?.method, "POST");
          assert.equal(new Headers(init?.headers).get("x-access-token"), "test-private-token");
          const form = init?.body as FormData;
          const payload = JSON.parse(String(form.get("payload")));
          assert.equal(payload.brief.topic, "测试主题"); assert.equal(payload.brief.audience, "目标读者");
          assert(!JSON.stringify(payload).includes("用户修改后的旧正文"));
          assert.equal(payload.mode, "live"); assert.deepEqual(payload.imageIds, ids);
          assert.deepEqual(form.getAll("images").map((item) => (item as File).name), ids.map((id) => `${id}.jpg`));
          return response(init?.signal as AbortSignal);
        },
      });
      current = applyValidatedGeneration(current, startDraftId, output, "live", uploaded, submitted);
    });
  }
  return { draft, ids, controller, lock, savedCopies, success, choice, get current() { return current; }, get copies() { return copies; }, get requests() { return requests; }, get starts() { return starts; } };
}

for (const preserve of [false, true]) {
  const path = preserve ? "保留副本" : "不保留副本";
  test(`${path}：成功只提交一次，校验后才替换，并保留图片顺序和十个话题`, async () => {
    const h = makeHarness();
    assert.equal(await h.choice(preserve, async () => h.success()), true);
    assert.equal(h.requests, 1); assert.equal(h.starts, 1); assert.equal(h.copies, Number(preserve));
    assert.equal(h.current.generation!.result.body, "新生成的正文");
    assert.deepEqual(h.current.generation!.result.imageCaptions.map((item) => item.imageId), h.ids);
    assert.equal(h.current.generation!.result.hashtags.length, 10);
    assert(h.current.generation!.result.hashtags.every((tag) => /^#[^#\s]+$/u.test(tag)));
    if (preserve) assert.equal(h.savedCopies[0].generation!.result.body, "用户修改后的旧正文");
  });

  test(`${path}：模拟 502 不重试、不替换现有编辑和图片`, async () => {
    const h = makeHarness(); const initial = h.current;
    await assert.rejects(h.choice(preserve, async () => Response.json({ error: { message: "供应商暂时不可用" } }, { status: 502 })), /供应商暂时不可用/);
    assert.equal(h.current, initial); assert.equal(h.current.generation!.result.body, "用户修改后的旧正文");
    assert.equal(h.requests, 1); assert.equal(h.copies, Number(preserve)); assert.deepEqual(h.current.images.map((i) => i.id), h.ids);
  });

  test(`${path}：网络超时提示超时且保留旧内容`, async () => {
    const h = makeHarness(); const initial = h.current;
    await assert.rejects(h.choice(preserve, (signal) => new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }), 10), (error: unknown) => error instanceof GenerationRequestError && error.code === "TIMEOUT");
    assert.equal(h.current, initial); assert.equal(h.requests, 1); assert.equal(h.copies, Number(preserve));
  });

  test(`${path}：请求取消提示取消且保留旧内容`, async () => {
    const h = makeHarness(); const initial = h.current;
    await assert.rejects(h.choice(preserve, (signal) => new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      queueMicrotask(() => h.controller.abort());
    })), (error: unknown) => error instanceof GenerationRequestError && error.code === "CANCELLED");
    assert.equal(h.current, initial); assert.equal(h.requests, 1); assert.equal(h.copies, Number(preserve));
  });

  test(`${path}：即使模拟网络忽略取消并迟到返回，也不会应用结果`, async () => {
    const h = makeHarness(); const initial = h.current;
    await assert.rejects(h.choice(preserve, async () => { h.controller.abort(); return h.success(); }),
      (error: unknown) => error instanceof GenerationRequestError && error.code === "CANCELLED");
    assert.equal(h.current, initial); assert.equal(h.requests, 1); assert.equal(h.copies, Number(preserve));
  });

  test(`${path}：快速重复选择只启动一次请求与至多一个副本`, async () => {
    const h = makeHarness();
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; });
    const first = h.choice(preserve, () => waiting);
    const second = h.choice(preserve, () => waiting);
    assert.equal(await second, false);
    // 等第一项完成图片处理并真正进入请求，避免用假百分比或定时器控制测试。
    while (!h.requests) await new Promise<void>((resolve) => setImmediate(resolve));
    release(h.success()); assert.equal(await first, true);
    assert.equal(h.requests, 1); assert.equal(h.copies, Number(preserve)); assert.equal(h.starts, 1);
  });
}

test("首次生成只发送当前表单、图片 ID 和真实模式，不包含旧文案或口令到正文", async () => {
  const h = makeHarness(); const first = newDraft();
  first.brief = h.draft.brief; first.mode = "live"; first.images = h.draft.images;
  let requests = 0;
  const output = await submitGeneration({ brief: first.brief, mode: first.mode, images: first.images, accessToken: "private-token", controller: new AbortController(),
    onProgress: () => undefined, onRequestStarted: () => undefined,
    compress: async (images) => images.map(() => new Blob(["image"], { type: "image/jpeg" })),
    request: async (_url, init) => {
      requests++;
      const raw = String((init?.body as FormData).get("payload"));
      const payload = JSON.parse(raw);
      assert.equal(payload.mode, "live"); assert.deepEqual(payload.imageIds, h.ids);
      assert(!raw.includes("private-token")); assert(!raw.includes("用户修改后的旧正文"));
      assert.equal(new Headers(init?.headers).get("x-access-token"), "private-token");
      return h.success();
    },
  });
  assert.equal(requests, 1); assert.equal(first.generation, null);
  const generated = applyValidatedGeneration(first, first.id, output, "live", first.images, inputSnapshot(first));
  assert.equal(generated.generation!.result.body, "新生成的正文"); assert.equal(generated.hasUserEdits, false);
});

test("浏览器默认等待 105 秒，超过旧 55 秒不会提前中断", async () => {
  const h = makeHarness();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const promise = submitGeneration({ brief: h.draft.brief, mode: "live", images: h.draft.images, accessToken: "", controller: new AbortController(),
      onProgress: () => undefined, onRequestStarted: () => undefined,
      compress: async (images) => images.map(() => new Blob(["image"], { type: "image/jpeg" })),
      request: async (_url, init) => { entered(); return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }); },
    });
    let settled = false;
    const outcome = promise.then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    await started;
    mock.timers.tick(55_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    mock.timers.tick(GENERATION_CLIENT_TIMEOUT_MS - 55_000);
    const error = await outcome;
    assert(error instanceof GenerationRequestError); assert.equal(error.code, "TIMEOUT");
  } finally { mock.timers.reset(); }
});

test("保留副本写入失败时不发请求、不覆盖当前草稿", async () => {
  const lock = { current: false }; let starts = 0;
  assert.equal(await runRegenerationChoice(lock, true, async () => false, async () => { starts++; }), false);
  assert.equal(starts, 0); assert.equal(lock.current, false);
});

test("图片处理期间取消不会发送请求，也不会写入任何结果", async () => {
  const h = makeHarness(); const controller = new AbortController(); let release!: (blobs: Blob[]) => void; let requests = 0;
  const pending = submitGeneration({ brief: h.draft.brief, mode: "live", images: h.draft.images, accessToken: "token", controller,
    onProgress: () => undefined, onRequestStarted: () => undefined,
    compress: () => new Promise<Blob[]>((resolve) => { release = resolve; }),
    request: async () => { requests++; return h.success(); },
  });
  controller.abort(); release(h.draft.images.map(() => new Blob(["test"], { type: "image/jpeg" })));
  await assert.rejects(pending, (error: unknown) => error instanceof GenerationRequestError && error.code === "CANCELLED");
  assert.equal(requests, 0); assert.equal(h.current.generation!.result.body, "用户修改后的旧正文");
});

test("旧请求迟到时不会覆盖另一个草稿", () => {
  const h = makeHarness(); const other = newDraft();
  const output = { result: createDemoResult(h.ids), imageIds: h.ids, metadata: { durationMs: 2, completedAt: new Date().toISOString() }, research: undefined };
  assert.equal(applyValidatedGeneration(other, h.draft.id, output, "live", h.draft.images, inputSnapshot(h.draft)), other);
  assert.equal(other.generation, null);
});

test("客户端 UUID 和服务端阶段只接收受控值，安全 HTTP 502 显示可关联编号", async () => {
  const h = makeHarness(); const requestId = crypto.randomUUID(); const output: string[] = [];
  const logger = mock.method(console, "info", (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); });
  try {
    await assert.rejects(submitGeneration({ brief: h.draft.brief, mode: "live", images: h.draft.images, accessToken: "secret-private-token", controller: new AbortController(), requestId,
      onProgress: () => undefined, onRequestStarted: () => undefined,
      compress: async (items) => items.map(() => new Blob(["private image"], { type: "image/jpeg" })),
      request: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("X-Client-Request-Id"), requestId);
        return Response.json({ error: { code: "PROVIDER_UNAVAILABLE", message: "生成暂时不可用", requestId, stage: "tag_repair_request" } }, { status: 502, headers: { "X-Request-Id": requestId } });
      },
    }), (error: unknown) => {
      assert(error instanceof GenerationRequestError); assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.requestId, requestId); assert.equal(error.stage, "tag_repair_request"); assert.equal(error.httpStatus, 502);
      assert.match(generationErrorMessage(error), /阶段：话题补全/); assert(generationErrorMessage(error).includes(requestId)); return true;
    });
    assert(output.some((line) => line.includes(`requestId=${requestId}`) && line.includes("phase=image_compression") && line.includes("result=success")));
    assert(output.some((line) => line.includes(`requestId=${requestId}`) && line.includes("phase=api_request") && line.includes("httpStatus=502") && line.includes("code=PROVIDER_UNAVAILABLE")));
    const logs = output.join("\n");
    for (const secret of ["secret-private-token", "private image", "测试主题", "目标读者", "用户修改后的旧正文", "生成暂时不可用"]) assert(!logs.includes(secret));
  } finally { logger.mock.restore(); }
});

test("不可信的服务端编号、阶段与错误码不会混入诊断或 UI 的安全字段", async () => {
  const h = makeHarness(); const requestId = crypto.randomUUID(); const output: string[] = [];
  const logger = mock.method(console, "info", (...parts: unknown[]) => { output.push(parts.map(String).join(" ")); });
  try {
    await assert.rejects(submitGeneration({ brief: h.draft.brief, mode: "live", images: h.draft.images, accessToken: "secret-private-token", controller: new AbortController(), requestId,
      onProgress: () => undefined, onRequestStarted: () => undefined,
      compress: async (items) => items.map(() => new Blob(["private image"], { type: "image/jpeg" })),
      request: async () => Response.json({ error: { code: "SECRET_API_KEY", message: "安全失败提示", requestId: "SECRET_API_KEY", stage: "tag_repair_request\nSECRET_API_KEY" } }, { status: 502 }),
    }), (error: unknown) => {
      assert(error instanceof GenerationRequestError); assert.equal(error.code, "UNKNOWN");
      assert.equal(error.requestId, requestId); assert.equal(error.stage, "api_request");
      assert.match(generationErrorMessage(error), /阶段：接口请求/); assert(!generationErrorMessage(error).includes("SECRET_API_KEY")); return true;
    });
    recordClientDiagnostic({ requestId, phase: "api_request", result: "failed", elapsedMs: 12, code: "SECRET_API_KEY" });
    assert(!output.join("\n").includes("SECRET_API_KEY")); assert(!output.join("\n").includes("secret-private-token"));
    assert(output.some((line) => line.includes("code=UNKNOWN")));
    assert.equal(isRequestId("not-a-uuid"), false); assert.equal(safeServerStage("__proto__"), undefined);
  } finally { logger.mock.restore(); }
});

test("保留副本诊断只记录成功、失败及耗时，不记录异常内容", async () => {
  const id = crypto.randomUUID(), logs: string[] = [];
  const logger = mock.method(console, "info", (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); });
  try {
    assert.equal(await measurePreservation(id, async () => true), true);
    assert.equal(await measurePreservation(id, async () => false), false);
    await assert.rejects(measurePreservation(id, async () => { throw new Error("SECRET_STORAGE_DETAIL"); }));
    assert.equal(logs.length, 3); assert(logs.every((line) => line.includes(`requestId=${id}`) && line.includes("phase=save_copy")));
    assert.match(logs[0], /result=success/); assert.match(logs[1], /result=failed/); assert.match(logs[2], /code=STORAGE_FAILED/);
    assert(!logs.join("\n").includes("SECRET_STORAGE_DETAIL"));
  } finally { logger.mock.restore(); }
});

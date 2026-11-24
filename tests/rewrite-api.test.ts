// 只拦截占位供应商，不读取 .env.local，也不会调用真实 API。
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { POST } from "../app/api/rewrite/route";
import { emptyBrief } from "../lib/schema";

const originalEnv = { ...process.env };
let outbound: ReturnType<typeof mock.method<typeof globalThis, "fetch">>;
let clock = Date.now();
beforeEach(() => {
  clock += 60_001;
  mock.method(Date, "now", () => clock);
  process.env.OPENAI_API_KEY = "test-only-placeholder";
  process.env.OPENAI_MODEL = "test-vision-model";
  process.env.APP_ACCESS_TOKEN = "";
  delete process.env.OPENAI_BASE_URL;
  process.env = { ...process.env, NODE_ENV: "test" };
  outbound = mock.method(globalThis, "fetch", async () => { throw new Error("mock not configured"); });
});
afterEach(() => { mock.restoreAll(); process.env = { ...originalEnv }; });

function answer(body: string) {
  return { id: "response-test", object: "response", status: "completed", output: [{ id: "message-test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ body }), annotations: [] }] }] };
}
async function upload(options: { forbidden?: string; emoji?: boolean; signal?: AbortSignal; mode?: string; direction?: string } = {}) {
  const id = randomUUID();
  const form = new FormData();
  form.set("payload", JSON.stringify({ mode: options.mode ?? "live", brief: { ...emptyBrief, topic: "测试主题", forbidden: options.forbidden ?? "", emoji: options.emoji ?? false }, imageIds: [id], body: "原文。原文第二句。", direction: options.direction ?? "natural", instruction: "" }));
  const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#dd9977" } }).png().toBuffer();
  form.append("images", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "fixture.png");
  return new Request("http://localhost/api/rewrite", { method: "POST", headers: { host: "localhost", origin: "http://localhost" }, body: form, signal: options.signal });
}

test("重写严格返回正文，模型请求包含原图、原要求与原文且没有重试", async () => {
  outbound.mock.mockImplementation(async () => Response.json(answer("第一段。\n\n第二段。")));
  const response = await POST(await upload());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.body, "第一段。\n\n第二段。");
  assert.deepEqual(Object.keys(data).sort(), ["body", "meta"]);
  const sent = JSON.parse(String(outbound.mock.calls[0].arguments[1]?.body));
  assert.equal(sent.model, "test-vision-model");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.type, "json_schema");
  assert.equal(sent.text.format.strict, true);
  assert.ok(sent.input[1].content[0].text.includes("原文"));
  assert.ok(sent.input[1].content.some((item: { type: string }) => item.type === "input_image"));
  assert.equal(outbound.mock.callCount(), 1);
});

test("禁用词和 Emoji 不合格时不返回正文", async () => {
  outbound.mock.mockImplementation(async () => Response.json(answer("违反禁词。\n\n第二段。")));
  let response = await POST(await upload({ forbidden: "禁词" }));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "CONSTRAINT_FAILED");
  outbound.mock.mockImplementation(async () => Response.json(answer("第一段😊。\n\n第二段。")));
  response = await POST(await upload());
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "CONSTRAINT_FAILED");
});

test("供应商 502 与超时区分，原始错误不泄露，不会重试", async () => {
  outbound.mock.mockImplementation(async () => Response.json({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }, { status: 502 }));
  let response = await POST(await upload());
  let data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.error.code, "PROVIDER_UNAVAILABLE");
  assert.ok(!JSON.stringify(data).includes("PRIVATE_PROVIDER_DETAIL"));
  assert.equal(outbound.mock.callCount(), 1);
  outbound.mock.mockImplementation(async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); });
  response = await POST(await upload());
  data = await response.json();
  assert.equal(data.error.code, "TIMEOUT");
  assert.equal(outbound.mock.callCount(), 2);
});

test("用户取消、不允许演示模式及非法方向都不调用供应商", async () => {
  for (const options of [{ signal: AbortSignal.abort() }, { mode: "demo" }, { direction: "unknown" }]) {
    const response = await POST(await upload(options));
    assert.equal(response.ok, false);
  }
  assert.equal(outbound.mock.callCount(), 0);
});

test("模型请求开始后取消，路由返回取消且不发起第二次请求", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  outbound.mock.mockImplementation(async (_url, init) => {
    entered();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = POST(await upload({ signal: controller.signal }));
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, "CANCELLED");
  assert.equal(outbound.mock.callCount(), 1);
});

// 本文件使用官方 SDK，但拦截所有出站 fetch；验证协议和失败处理，不验证真实模型质量。
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getPublicConfig, resolveProvider } from "../lib/server/config";
import { generateContent } from "../lib/server/openai";
import { createDemoResult } from "../lib/demo";
import { emptyBrief, generationMetaSchema, type ContentResult } from "../lib/schema";
import { AppError } from "../lib/errors";
import { validateResult } from "../lib/validate-result";
import { POST } from "../app/api/generate/route";
import { generationTimeouts } from "../lib/server/generation-timeouts";

const ids = [randomUUID(), randomUUID()];
const brief = { ...emptyBrief, topic: "合成图片接口测试" };
const images = ids.map((id) => ({ id, dataUrl: "data:image/jpeg;base64,dGVzdA==" }));
const originalEnv = { ...process.env };
let outbound: ReturnType<typeof mock.method<typeof globalThis, "fetch">>;
const testClockStart = Date.now();
let testClockStep = 0;

beforeEach(() => {
  // 每个用例使用独立限流窗口，不让前面的路由测试污染后续诊断验证。
  const now = testClockStart + ++testClockStep * 60_001;
  mock.method(Date, "now", () => now);
  // 仅当前测试进程使用的占位值，不读取用户 .env.local。
  process.env.OPENAI_API_KEY = "test-only-placeholder";
  process.env.OPENAI_MODEL = "test-vision-model";
  process.env.APP_ACCESS_TOKEN = "";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.VERCEL;
  delete process.env.GENERATION_TIMEOUT_PROFILE;
  process.env = { ...process.env, NODE_ENV: "test" };
  outbound = mock.method(globalThis, "fetch", async () => { throw new Error("Test transport must be configured"); });
});
afterEach(() => { mock.restoreAll(); process.env = { ...originalEnv }; });

function modelReply(result: ContentResult = createDemoResult(ids), status = "completed") {
  return {
    id: "test-response", object: "response", status,
    output: [{ id: "test-message", type: "message", role: "assistant", status,
      content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }],
  };
}
function serve(value: unknown, status = 200) {
  outbound.mock.mockImplementation(async () => Response.json(value, { status }));
}
function code(expected: string) {
  return (error: unknown) => error instanceof AppError && error.code === expected;
}
async function upload(mode = "live", token = "", topic = brief.topic) {
  const form = new FormData();
  form.set("payload", JSON.stringify({ brief: { ...brief, topic }, mode, imageIds: ids }));
  for (const background of ["#e56854", "#5479b2"]) {
    const bytes = await sharp({ create: { width: 20, height: 12, channels: 3, background } }).png().toBuffer();
    form.append("images", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "synthetic.png");
  }
  return new Request("http://localhost/api/generate", {
    method: "POST", body: form, headers: { host: "localhost", origin: "http://localhost", "x-access-token": token },
  });
}

test("配置已填写不声称已连接；公开配置不泄露任何密钥", () => {
  const config = getPublicConfig();
  assert.equal(config.liveAvailable, true);
  assert.match(config.setupMessage, /配置已填写/);
  assert.doesNotMatch(config.setupMessage, /已连接/);
  assert.ok(!JSON.stringify(config).includes(process.env.OPENAI_API_KEY!));
  assert.equal(outbound.mock.callCount(), 0);
});

test("生产模式必须有足够长的访问口令；缺配置不能开启真实模式", () => {
  process.env = { ...process.env, NODE_ENV: "production" };
  assert.equal(getPublicConfig().liveAvailable, false);
  process.env.APP_ACCESS_TOKEN = "test-private-access-token";
  assert.equal(getPublicConfig().liveAvailable, true);
  delete process.env.OPENAI_MODEL;
  assert.equal(getPublicConfig().liveAvailable, false);
});

test("真实分支贯通上传、图片 ID 配对、官方 SDK、结构化校验和耗时记录（模拟供应商）", async () => {
  const draft = createDemoResult(ids);
  draft.imageCaptions.reverse();
  serve(modelReply(draft));
  const response = await POST(await upload());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mode, "live");
  assert.equal(generationMetaSchema.safeParse(data.meta).success, true);
  assert.deepEqual(data.result.imageCaptions.map((item: { imageId: string }) => item.imageId), ids);
  assert.equal(validateResult(data.result, ids).titles.length, 5);
  assert.equal(outbound.mock.callCount(), 1);
  const call = outbound.mock.calls[0].arguments;
  assert.match(String(call[0]), /\/responses$/);
  const sent = JSON.parse(String(call[1]?.body));
  assert.equal(sent.model, "test-vision-model");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.type, "json_schema");
  assert.equal(sent.text.format.strict, true);
  const content = sent.input[1].content;
  assert.ok(content[0].text.includes(brief.topic));
  assert.ok(content[1].text.includes(ids[0]));
  assert.ok(content[3].text.includes(ids[1]));
  assert.equal(content[2].type, "input_image");
  assert.match(content[2].image_url, /^data:image\/jpeg;base64,/);
  assert.notEqual(content[2].image_url, content[4].image_url);
  const responseText = JSON.stringify(data);
  assert.ok(!responseText.includes("test-only-placeholder"));
  assert.ok(!responseText.includes("base64"));
});

test("生成时逐图配文缺少多行说明被拒绝，旧内容不被覆盖", async () => {
  const sample = createDemoResult(ids);
  sample.imageCaptions[0].description = "只有一行说明";
  serve(modelReply(sample));
  await assert.rejects(generateContent(brief, images), (error: unknown) => error instanceof AppError && error.code === "INVALID_RESULT");
  assert.equal(outbound.mock.callCount(), 1);
});

test("格式损坏和 schema 缺项均返回明确的结果不完整错误", async () => {
  for (const text of ["{", '{"titles":[]}']) {
    const reply = modelReply();
    reply.output[0].content[0].text = text;
    serve(reply);
    await assert.rejects(generateContent(brief, images), code("INVALID_RESULT"));
  }
});

test("模型拒绝与 token 截断得到明确错误，不显示半成品", async () => {
  serve({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "synthetic refusal" }] }] });
  await assert.rejects(generateContent(brief, images), code("REFUSAL"));
  const reply = modelReply(undefined, "incomplete");
  reply.output[0].content[0].text = '{"titles":[';
  serve(reply);
  await assert.rejects(generateContent(brief, images), code("INCOMPLETE"));
});

test("模型漏图或重复图片 ID 时不返回成功结果", async () => {
  for (const returned of [[ids[0]], [ids[0], ids[0]]]) {
    serve(modelReply(createDemoResult(returned)));
    await assert.rejects(generateContent(brief, images), code("IMAGE_MISMATCH"));
  }
});

test("真实分支仍会拒绝禁用词，且不会自动重试", async () => {
  serve(modelReply());
  await assert.rejects(generateContent({ ...brief, forbidden: "咖啡" }, images), code("CONSTRAINT_FAILED"));
  assert.equal(outbound.mock.callCount(), 1);
});

test("供应商认证、限流和模型权限错误不会泄露响应详情或自动重试", async () => {
  for (const [status, expected] of [[401, "INVALID_KEY"], [429, "PROVIDER_LIMIT"], [404, "ENDPOINT_NOT_FOUND"], [500, "PROVIDER_UNAVAILABLE"]] as const) {
    serve({ error: { message: "PRIVATE_PROVIDER_DETAIL", type: "test_error" } }, status);
    const before = outbound.mock.callCount();
    await assert.rejects(generateContent(brief, images), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, expected);
      assert.ok(!error.message.includes("PRIVATE_PROVIDER_DETAIL"));
      return true;
    });
    assert.equal(outbound.mock.callCount() - before, 1);
  }
});

test("网络中断、超时和取消分别返回可理解错误", async () => {
  outbound.mock.mockImplementation(async () => { throw new TypeError("connection failed"); });
  await assert.rejects(generateContent(brief, images), code("PROVIDER_NETWORK"));
  outbound.mock.mockImplementation(async () => { throw Object.assign(new Error("timed out"), { name: "AbortError" }); });
  await assert.rejects(generateContent(brief, images), code("TIMEOUT"));
  await assert.rejects(generateContent(brief, images, AbortSignal.abort()), code("CANCELLED"));
});

test("可用额度不足与临时限流分开提示，不引导无效重试", async () => {
  const quotaCodes = ["insufficient_quota", "credit_balance_exhausted", "organization_usage_limit_exceeded", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"];
  for (const quotaCode of quotaCodes) {
    serve({ error: { code: quotaCode, type: "insufficient_quota", message: "private detail" } }, 429);
    await assert.rejects(generateContent(brief, images), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "PROVIDER_QUOTA");
      assert.match(error.message, /重复点击不会恢复额度/);
      return true;
    });
  }
  const response = await POST(await upload());
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "PROVIDER_QUOTA");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(outbound.mock.callCount(), quotaCodes.length + 1);
});

test("未填密钥、缺生产口令、错误口令都在付费调用前拒绝", async () => {
  delete process.env.OPENAI_API_KEY;
  let response = await POST(await upload());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "NOT_CONFIGURED");
  process.env.OPENAI_API_KEY = "test-only-placeholder";
  process.env = { ...process.env, NODE_ENV: "production" };
  response = await POST(await upload());
  assert.equal((await response.json()).error.code, "ACCESS_NOT_CONFIGURED");
  process.env.APP_ACCESS_TOKEN = "test-private-access-token";
  response = await POST(await upload("live", "wrong"));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "UNAUTHORIZED");
  assert.equal(outbound.mock.callCount(), 0);
});

test("无效要求不会调用供应商；演示结果不算真实调用", async () => {
  let response = await POST(await upload("live", "", " "));
  assert.equal(response.status, 400);
  response = await POST(await upload("demo"));
  assert.equal((await response.json()).mode, "demo");
  assert.equal(outbound.mock.callCount(), 0);
});

test("Right Code 基础地址只拼一次 /v1，系统提示词、图片与严格 JSON 格式保持完整", async () => {
  process.env.OPENAI_BASE_URL = "https://rightapi.ai/v1/";
  process.env.OPENAI_MODEL = "gpt-6.1-sol";
  process.env.OPENAI_API_KEY = "test-new-rightcode-key";
  process.env.OPENAI_ORG_ID = "test-official-organization";
  process.env.OPENAI_PROJECT_ID = "test-official-project";
  serve(modelReply());
  await generateContent(brief, images);
  const [url, options] = outbound.mock.calls[0].arguments;
  assert.equal(String(url), "https://rightapi.ai/v1/responses");
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-new-rightcode-key");
  assert.equal(headers.get("OpenAI-Organization"), null); assert.equal(headers.get("OpenAI-Project"), null);
  assert.equal(options?.redirect, "manual");
  const request = JSON.parse(String(options?.body));
  assert.equal(request.model, "gpt-6.1-sol"); assert.equal(request.input[0].role, "system");
  assert.match(request.input[0].content, /不得虚构/);
  assert.equal(request.input[1].content[2].type, "input_image");
  assert.equal(request.text.format.type, "json_schema"); assert.equal(request.text.format.strict, true);
  assert.equal(outbound.mock.callCount(), 1);
});

test("错误域名、重复版本和完整接口地址在出站前被拒绝，演示仍可运行", async () => {
  for (const base of ["https://right.codes", "https://rightapi.ai/v1/v1", "https://rightapi.ai/v1/responses", "http://rightapi.ai/v1", "https://rightapi.ai/v1?api_key=private", "https://rightapi.ai.attacker.example/v1"]) {
    process.env.OPENAI_BASE_URL = base;
    assert.equal(getPublicConfig().liveAvailable, false);
    assert(!JSON.stringify(getPublicConfig()).includes("private"));
    await assert.rejects(generateContent(brief, images), code("INVALID_BASE_URL"));
  }
  assert.equal(outbound.mock.callCount(), 0);
  const response = await POST(await upload("demo")); assert.equal(response.status, 200);
  assert.equal(resolveProvider(undefined).baseURL, "https://api.openai.com/v1");
});

test("中转模式公开状态仅为已配置，缺密钥时不回退到官方账户", async () => {
  process.env.OPENAI_BASE_URL = "https://rightapi.ai/v1";
  const config = getPublicConfig();
  assert.equal(config.providerName, "Right Code"); assert.equal(config.liveAvailable, true);
  assert.match(config.setupMessage, /尚不代表真实请求成功/);
  delete process.env.OPENAI_API_KEY;
  assert.equal(getPublicConfig().liveAvailable, false);
  await assert.rejects(generateContent(brief, images), code("NOT_CONFIGURED"));
  assert.equal(outbound.mock.callCount(), 0);
});

test("中转模型权限、接口缺失、图片或 JSON 不兼容分别分类且不自动降级", async () => {
  process.env.OPENAI_BASE_URL = "https://rightapi.ai/v1";
  for (const [status, providerCode, expected] of [
    [404, "model_not_found", "MODEL_UNAVAILABLE"], [403, "permission_denied", "MODEL_UNAVAILABLE"],
    [404, "route_not_found", "ENDPOINT_NOT_FOUND"], [400, "unsupported_parameter", "PROVIDER_INCOMPATIBLE"],
    [422, "unsupported_image", "VISION_UNSUPPORTED"], [402, "insufficient_balance", "PROVIDER_QUOTA"],
    [302, "", "ENDPOINT_REDIRECT"],
  ] as const) {
    serve({ error: { code: providerCode, message: "PRIVATE_DETAIL" } }, status);
    const before = outbound.mock.callCount();
    await assert.rejects(generateContent(brief, images), (error: unknown) => {
      assert(error instanceof AppError); assert.equal(error.code, expected); assert(!error.message.includes("PRIVATE_DETAIL")); return true;
    });
    assert.equal(outbound.mock.callCount(), before + 1);
  }
});

test("中转返回 HTML 或其他聊天协议时不伪装成成功", async () => {
  process.env.OPENAI_BASE_URL = "https://rightapi.ai/v1";
  for (const response of ["<html>not an API response</html>", { choices: [{ message: { content: "hello" } }] }]) {
    serve(response);
    await assert.rejects(generateContent(brief, images), code("PROVIDER_INCOMPATIBLE"));
  }
});

test("标签不足或超量时只修正一次标签，仍使用原图和正文", async () => {
  for (const amount of [3, 11]) {
    const original = createDemoResult(ids);
    original.hashtags = Array.from({ length: amount }, (_, i) => `#测试话题${i}`);
    const fixed = createDemoResult(ids).hashtags;
    let n = 0;
    outbound.mock.mockImplementation(async () => {
      const reply = modelReply(original);
      if (n++ > 0) reply.output[0].content[0].text = JSON.stringify({ hashtags: fixed });
      return Response.json(reply);
    });
    const before = outbound.mock.callCount();
    const result = await generateContent(brief, images);
    assert.equal(outbound.mock.callCount() - before, 2);
    assert.equal(result.hashtags.length, 10);
    assert(result.hashtags.every((tag) => tag.startsWith("#") && !tag.startsWith("##")));
    assert.equal(result.body, original.body); assert.deepEqual(result.titles, original.titles);
    const sent = JSON.parse(String(outbound.mock.calls[before + 1].arguments[1]?.body));
    assert.equal(sent.text.format.name, "xhs_hashtags");
    assert.equal(sent.input[1].content.filter((item: { type: string }) => item.type === "input_image").length, 2);
    assert(sent.input[1].content[0].text.includes(original.body.slice(0, 20)));
  }
});

test("一次补正后仍不足十个时拒绝成功，不无限重试", async () => {
  const original = createDemoResult(ids); original.hashtags = ["#重复", "#重复", ""];
  let n = 0;
  outbound.mock.mockImplementation(async () => {
    const reply = modelReply(original);
    if (n++ > 0) reply.output[0].content[0].text = JSON.stringify({ hashtags: ["#不足", "#不足"] });
    return Response.json(reply);
  });
  await assert.rejects(generateContent(brief, images), code("HASHTAG_COUNT"));
  assert.equal(outbound.mock.callCount(), 2);
});

test("供应商在首次生成返回 502 时记录准确阶段与状态，响应不泄露原文", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  serve({ error: { message: "PRIVATE_PROVIDER_DETAIL test-only-placeholder", type: "server_error" } }, 502);
  const response = await POST(await upload());
  const result = await response.json();
  assert.equal(response.status, 502); assert.equal(result.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(result.error.stage, "initial_request"); assert.match(result.error.message, /正文生成阶段/);
  assert.match(result.error.requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(response.headers.get("X-Request-Id"), result.error.requestId);
  assert.equal(outbound.mock.callCount(), 1);
  assert(lines.some((line) => line.includes(`requestId=${result.error.requestId}`) && line.includes("stage=initial_request") && line.includes("source=provider_http") && line.includes("providerStatus=502")));
  const evidence = JSON.stringify({ result, lines });
  for (const privateText of ["PRIVATE_PROVIDER_DETAIL", "test-only-placeholder", brief.topic, "base64", ids[0]]) assert(!evidence.includes(privateText));
});

test("合法的客户端 UUID 贯穿响应和阶段日志，便于安全关联", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  serve({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }, 502);
  const id = randomUUID(), request = await upload();
  request.headers.set("X-Client-Request-Id", id);
  const response = await POST(request); const data = await response.json();
  assert.equal(response.headers.get("X-Request-Id"), id); assert.equal(data.error.requestId, id);
  assert(lines.every((line) => line.includes(`requestId=${id}`)));
  assert(!JSON.stringify(lines).includes("PRIVATE_PROVIDER_DETAIL"));
});

test("非 UUID 的客户端标识不会进入日志或响应，而是替换成随机 UUID", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  serve({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }, 502);
  const request = await upload(), unsafe = "DO_NOT_LOG_RAW_CLIENT_HEADER";
  request.headers.set("X-Client-Request-Id", unsafe);
  const response = await POST(request); const data = await response.json();
  assert.match(data.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  assert.equal(response.headers.get("X-Request-Id"), data.error.requestId);
  assert(!JSON.stringify({ data, lines }).includes(unsafe));
  assert(lines.every((line) => line.includes(`requestId=${data.error.requestId}`)));
});

test("首次模型成功但话题补全返回 502 时，阶段与原始模型请求区分", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const initial = createDemoResult(ids); initial.hashtags = ["#不足", "#重复", "#重复"];
  let count = 0;
  outbound.mock.mockImplementation(async () => count++ === 0 ? Response.json(modelReply(initial)) : Response.json({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }, { status: 502 }));
  const response = await POST(await upload()); const data = await response.json();
  assert.equal(response.status, 502); assert.equal(data.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(data.error.stage, "tag_repair_request"); assert.match(data.error.message, /话题补全阶段/);
  assert.equal(outbound.mock.callCount(), 2);
  assert(lines.some((line) => line.includes("stage=initial_request") && line.includes("status=success")));
  assert(lines.some((line) => line.includes("stage=initial_validation") && line.includes("status=needs_repair")));
  assert(lines.some((line) => line.includes("stage=tag_repair_request") && line.includes("source=provider_http") && line.includes("providerStatus=502")));
  assert(!JSON.stringify({ data, lines }).includes("PRIVATE_PROVIDER_DETAIL"));
});

test("补全成功时记录两个模型阶段并复用同一关联标识", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const initial = createDemoResult(ids); initial.hashtags = ["#不足"];
  let count = 0;
  outbound.mock.mockImplementation(async () => {
    const reply = modelReply(initial);
    if (count++ > 0) reply.output[0].content[0].text = JSON.stringify({ hashtags: createDemoResult(ids).hashtags });
    return Response.json(reply);
  });
  const response = await POST(await upload()); const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.result.hashtags.length, 10);
  assert.equal(outbound.mock.callCount(), 2);
  const requestId = response.headers.get("X-Request-Id");
  assert(requestId);
  for (const phase of ["initial_request", "initial_validation", "tag_repair_request", "tag_validation"]) {
    assert(lines.some((line) => line.includes(`requestId=${requestId}`) && line.includes(`stage=${phase}`)));
  }
  for (const privateText of ["test-only-placeholder", brief.topic, "base64", ids[0]]) assert(!JSON.stringify(lines).includes(privateText));
});

test("应用返回 502 的格式错误与供应商 HTTP 502 可区分", async () => {
  const lines: string[] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const malformed = modelReply(); malformed.output[0].content[0].text = "{";
  serve(malformed);
  const response = await POST(await upload()); const data = await response.json();
  assert.equal(response.status, 502); assert.equal(data.error.code, "INVALID_RESULT");
  assert.equal(data.error.stage, "initial_request");
  assert(lines.some((line) => line.includes("source=transport_or_response") && line.includes("providerStatus=none")));
  assert(!lines.some((line) => line.includes("providerStatus=502")));
});

test("首次请求与话题补全各自超时或取消时保留正确阶段，不额外重试", async () => {
  for (const repair of [false, true]) for (const cancel of [false, true]) {
    const initial = createDemoResult(ids); initial.hashtags = ["#不足"];
    const controller = new AbortController(); let count = 0;
    outbound.mock.mockImplementation(async () => {
      count++;
      if (repair && count === 1) return Response.json(modelReply(initial));
      if (cancel) controller.abort();
      throw Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), { name: "AbortError" });
    });
    const before = outbound.mock.callCount();
    await assert.rejects(generateContent(brief, images, controller.signal), (error: unknown) => {
      assert(error instanceof AppError);
      assert.equal(error.code, cancel ? "CANCELLED" : "TIMEOUT");
      assert.equal((error as { stage?: string }).stage, repair ? "tag_repair_request" : "initial_request");
      assert(!error.message.includes("PRIVATE_PROVIDER_DETAIL")); return true;
    });
    assert.equal(outbound.mock.callCount() - before, repair ? 2 : 1);
  }
});

type FakeDelay = { first: number; repair: number | null; tickFirst: number; tickRepair?: number; expected: "success" | "initial_timeout" | "repair_timeout"; budgetMs?: number; modelTimeoutMs?: number };
async function simulateSlowModel(scenario: FakeDelay) {
  // 这不是实际等待：用虚拟时钟分别推进模型单次和应用总期限。
  mock.timers.enable({ apis: ["setTimeout"] });
  let deadlineCreated = 0;
  mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, scenario.budgetMs ?? 50_000); deadlineCreated++;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const original = createDemoResult(ids);
  if (scenario.repair !== null) original.hashtags = ["#话题不足"];
  const stages: Array<() => void> = [];
  const entered = [0, 1].map(() => new Promise<void>((resolve) => { stages.push(resolve); }));
  let count = 0;
  outbound.mock.mockImplementation(async (_input, options) => {
    const stage = count++;
    stages[stage]?.();
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        const reply = modelReply(original);
        if (stage === 1) reply.output[0].content[0].text = JSON.stringify({ hashtags: createDemoResult(ids).hashtags });
        resolve(Response.json(reply));
      }, stage === 0 ? scenario.first : scenario.repair!);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer); reject(Object.assign(new Error("simulated abort"), { name: "AbortError" }));
      }, { once: true });
    });
  });
  try {
    const budget = scenario.budgetMs === undefined ? undefined : { signal: AbortSignal.timeout(scenario.budgetMs), startedAt: performance.now(), maxDurationMs: scenario.budgetMs, modelTimeoutMs: scenario.modelTimeoutMs };
    const operation = generateContent(brief, images, undefined, undefined, budget);
    // 在虚拟时钟到期前安装拒绝处理，避免被 Node 视为未处理拒绝。
    const outcome = operation.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    await entered[0];
    mock.timers.tick(scenario.tickFirst);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (scenario.tickRepair !== undefined) {
      await entered[1];
      mock.timers.tick(scenario.tickRepair);
    }
    const result = await outcome;
    assert.equal(deadlineCreated, 1);
    if (scenario.expected === "success") {
      assert.equal(result.value?.hashtags.length, 10); assert.equal(result.error, undefined);
    } else {
      assert(result.error instanceof AppError); assert.equal(result.error.code, "TIMEOUT");
      assert.equal((result.error as { stage?: string }).stage, scenario.expected === "initial_timeout" ? "initial_request" : "tag_repair_request");
      if (scenario.expected === "initial_timeout") assert.match(result.error.message, /正文生成未在限定时间内返回完整结果/);
      if (scenario.expected === "repair_timeout" && scenario.budgetMs === undefined && scenario.tickRepair === 48_000) assert.match(result.error.message, /话题补全未在限定时间内返回完整结果/);
    }
    assert.equal(count, scenario.repair === null || scenario.expected === "initial_timeout" ? 1 : 2);
  } finally { mock.timers.reset(); }
}

test("首次模型缓慢但在 48 秒内返回，可正常生成", async () => {
  await simulateSlowModel({ first: 42_000, repair: null, tickFirst: 42_000, expected: "success" });
});
test("首次模型在 45 至 48 秒内返回时，不再被旧上限提前终止", async () => {
  await simulateSlowModel({ first: 47_000, repair: null, tickFirst: 47_000, expected: "success" });
});

test("首次模型和补全均缓慢但合计少于 50 秒，能够成功", async () => {
  await simulateSlowModel({ first: 42_000, repair: 7_000, tickFirst: 42_000, tickRepair: 7_000, expected: "success" });
});

test("首次模型耗时 44 秒后补全缓慢，会在共用 50 秒期限超时", async () => {
  await simulateSlowModel({ first: 44_000, repair: 7_000, tickFirst: 44_000, tickRepair: 6_000, expected: "repair_timeout" });
});

test("首次模型超过单次 48 秒限制，归类首次阶段超时", async () => {
  await simulateSlowModel({ first: 48_001, repair: null, tickFirst: 48_000, expected: "initial_timeout" });
});

test("补全阶段超过单次 48 秒限制，即使总期限未到也会超时", async () => {
  await simulateSlowModel({ first: 1_000, repair: 48_001, tickFirst: 1_000, tickRepair: 48_000, expected: "repair_timeout" });
});

test("本机和 Vercel 分别采用与部署限制协调的总期限和模型时限", () => {
  assert.deepEqual(generationTimeouts("local", ""), { totalMs: 100_000, modelMs: 90_000 });
  assert.deepEqual(generationTimeouts("local", "1"), { totalMs: 50_000, modelMs: 48_000 });
  assert.deepEqual(generationTimeouts("", ""), { totalMs: 50_000, modelMs: 48_000 });
  assert.deepEqual(generationTimeouts("unknown", ""), { totalMs: 50_000, modelMs: 48_000 });
});
test("本机模型在 48 秒后、90 秒前返回仍可成功", async () => {
  await simulateSlowModel({ first: 80_000, repair: null, tickFirst: 80_000, expected: "success", budgetMs: 100_000, modelTimeoutMs: 90_000 });
});
test("本机模型超过 90 秒仍会超时，不会无限等待", async () => {
  await simulateSlowModel({ first: 90_001, repair: null, tickFirst: 90_000, expected: "initial_timeout", budgetMs: 100_000, modelTimeoutMs: 90_000 });
});
test("本机话题补全与首次生成共用 100 秒总期限", async () => {
  await simulateSlowModel({ first: 75_000, repair: 26_000, tickFirst: 75_000, tickRepair: 25_000, expected: "repair_timeout", budgetMs: 100_000, modelTimeoutMs: 90_000 });
});

function enableVirtualRequestDeadline(totalMs = 50_000) {
  if (totalMs === 50_000) process.env.VERCEL = "1";
  else { delete process.env.VERCEL; process.env.GENERATION_TIMEOUT_PROFILE = "local"; }
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, totalMs);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
}

test("本机路由不会在 50 秒提前中断，仍会在总计 100 秒终止", async () => {
  enableVirtualRequestDeadline(100_000);
  try {
    const upload = stalledUpload(); const pending = POST(upload.request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(50_000); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(upload.wasCancelled(), false);
    mock.timers.tick(50_000);
    const response = await pending; const data = await response.json();
    assert.equal(response.status, 504); assert.equal(data.error.code, "TIMEOUT");
    assert.equal(data.error.stage, "read_upload"); assert.equal(upload.wasCancelled(), true);
    assert.equal(outbound.mock.callCount(), 0);
  } finally { mock.timers.reset(); }
});

function stalledUpload(signal?: AbortSignal) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const request = new Request("http://localhost/api/generate", {
    method: "POST", body, signal, duplex: "half", headers: { host: "localhost", origin: "http://localhost", "Content-Type": "multipart/form-data; boundary=test-boundary" },
  } as RequestInit & { duplex: "half" });
  return { request, wasCancelled: () => cancelled };
}

test("上传读取超过路由起始 50 秒时终止读取并返回上传阶段超时", async () => {
  enableVirtualRequestDeadline();
  try {
    const upload = stalledUpload();
    const responsePromise = POST(upload.request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(50_000);
    const response = await responsePromise; const data = await response.json();
    assert.equal(response.status, 504); assert.equal(data.error.code, "TIMEOUT"); assert.equal(data.error.stage, "read_upload");
    assert.equal(upload.wasCancelled(), true); assert.equal(outbound.mock.callCount(), 0);
  } finally { mock.timers.reset(); }
});

test("用户在上传阶段取消时释放读取流，并优先标记为取消", async () => {
  enableVirtualRequestDeadline();
  try {
    const controller = new AbortController(); const upload = stalledUpload(controller.signal);
    const responsePromise = POST(upload.request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(); mock.timers.tick(50_000);
    const response = await responsePromise; const data = await response.json();
    assert.equal(response.status, 499); assert.equal(data.error.code, "CANCELLED"); assert.equal(data.error.stage, "read_upload");
    assert.equal(upload.wasCancelled(), true); assert.equal(outbound.mock.callCount(), 0);
  } finally { mock.timers.reset(); }
});

test("图片校验完成后若已耗尽总预算，不发模型请求", async () => {
  process.env.VERCEL = "1";
  const request = await upload();
  const originalRead = File.prototype.arrayBuffer;
  let imageRead = false;
  mock.method(File.prototype, "arrayBuffer", async function (this: File) {
    const result = await originalRead.call(this); imageRead = true; return result;
  });
  mock.method(performance, "now", () => imageRead ? 50_001 : 0);
  const response = await POST(request); const data = await response.json();
  assert.equal(response.status, 504); assert.equal(data.error.code, "TIMEOUT");
  assert.equal(data.error.stage, "input_validation"); assert.equal(outbound.mock.callCount(), 0);
});

test("上传占用预算后，主生成与补全共用剩余时间，补全不能重新获得 50 秒", async () => {
  const originalRequest = await upload();
  const bytes = new Uint8Array(await originalRequest.arrayBuffer());
  const contentType = originalRequest.headers.get("content-type")!;
  enableVirtualRequestDeadline();
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { setTimeout(() => { controller.enqueue(bytes); controller.close(); }, 20_000); },
    });
    const request = new Request("http://localhost/api/generate", {
      method: "POST", body: stream, duplex: "half", headers: { host: "localhost", origin: "http://localhost", "content-type": contentType },
    } as RequestInit & { duplex: "half" });
    const original = createDemoResult(ids); original.hashtags = ["#不足"];
    const entered: Array<() => void> = [];
    const stages = [0, 1].map(() => new Promise<void>((resolve) => { entered.push(resolve); }));
    let count = 0;
    outbound.mock.mockImplementation(async (_input, options) => {
      const stage = count++; entered[stage]?.();
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          const reply = modelReply(original);
          if (stage === 1) reply.output[0].content[0].text = JSON.stringify({ hashtags: createDemoResult(ids).hashtags });
          resolve(Response.json(reply));
        }, stage === 0 ? 25_000 : 10_000);
        options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("simulated"), { name: "AbortError" })); }, { once: true });
      });
    });
    const responsePromise = POST(request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    mock.timers.tick(20_000); await stages[0];
    mock.timers.tick(25_000); await stages[1];
    mock.timers.tick(5_000);
    const response = await responsePromise; const data = await response.json();
    assert.equal(response.status, 504); assert.equal(data.error.code, "TIMEOUT"); assert.equal(data.error.stage, "tag_repair_request");
    assert.equal(count, 2);
  } finally { mock.timers.reset(); }
});

test("模型同步处理耗尽预算但定时器尚未运行时，仍记录准确模型阶段超时", async () => {
  let elapsed = 0;
  mock.method(performance, "now", () => elapsed);
  outbound.mock.mockImplementation(async () => { elapsed = 50_001; return Response.json(modelReply()); });
  const requestDeadline = new AbortController();
  await assert.rejects(generateContent(brief, images, undefined, undefined, { signal: requestDeadline.signal, startedAt: 0, maxDurationMs: 50_000 }), (error: unknown) => {
    assert(error instanceof AppError); assert.equal(error.code, "TIMEOUT");
    assert.equal((error as { stage?: string }).stage, "initial_request");
    assert.equal((error as { source?: string }).source, "request_budget"); return true;
  });
});

test("用户取消与服务端期限同时生效时，模型阶段优先记录用户取消", async () => {
  const user = new AbortController(), deadline = new AbortController();
  user.abort(); deadline.abort();
  await assert.rejects(generateContent(brief, images, user.signal, undefined, { signal: deadline.signal, startedAt: performance.now(), maxDurationMs: 50_000 }), (error: unknown) => {
    assert(error instanceof AppError); assert.equal(error.code, "CANCELLED");
    assert.equal((error as { stage?: string }).stage, "initial_request");
    assert.equal((error as { source?: string }).source, "request_cancel"); return true;
  });
  assert.equal(outbound.mock.callCount(), 0);
});

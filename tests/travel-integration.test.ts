import { mockSearchBrowser } from "./browser-search-fixture";
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "fake-indexeddb/auto";
import sharp from "sharp";
import { POST as generate } from "../app/api/generate/route";
import { POST as refreshResearch } from "../app/api/travel-research/route";
import { createDemoResult } from "../lib/demo";
import { emptyBrief, type Brief } from "../lib/schema";
import { newDraft, inputSnapshot, serializeDraft, storedDraftSchema } from "../lib/drafts";
import { localStore } from "../lib/local-store";
import { formatAll, formatNote } from "../lib/format";
import { applyResearchIfCurrent, researchFingerprint } from "../lib/research-client";
import { researchForPrompt } from "../lib/research-prompt";
import { TRAVEL_SEARCH_ENDPOINT } from "../lib/server/travel-search";
import { bootstrapAdmin, gateCookieName, getRequestAuthState, hashSecret, issueGate, registerUser, userCookieName } from "../lib/cloud/server/auth";
import { execute } from "../lib/cloud/server/jobs";
import { generateContent } from "../lib/server/openai";
import { AppError } from "../lib/errors";
import type { ContentResult } from "../lib/schema";
import type { TravelResearch } from "../lib/travel-research";

const originalEnv = { ...process.env };
const sourceUrl = "https://ylj.suzhou.gov.cn/page/test";
const syntheticImageId = randomUUID();
const result = createDemoResult([syntheticImageId]);
let modelInputs: string[] = [];
let searchCalls = 0;
let scenario: "success" | "empty" | "failure" = "success";

function modelReply() {
  return { id: "fake-response", object: "response", status: "completed", output: [{ id: "fake-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }] };
}
beforeEach(() => {
  process.env = { ...originalEnv, NODE_ENV: "test", APP_MODE: "local", APP_LOCAL_ONLY: "1", OPENAI_API_KEY: "synthetic-model-key", OPENAI_MODEL: "synthetic-model", BOCHA_API_KEY: "synthetic-search-key" };
  delete process.env.OPENAI_BASE_URL;
  modelInputs = []; searchCalls = 0; scenario = "success";
  mockSearchBrowser(query => {
    searchCalls++; assert.match(query, /^苏州 旅游攻略 /u);
    if (scenario === "failure") throw new Error("synthetic-browser-fault");
    return scenario === "empty" ? [] : [
      { title: `苏州官方信息 ${sourceUrl}`, url: sourceUrl, snippet: "苏州园林旅行 https://private.example/injected" },
      { title: "无关网页", url: "http://127.0.0.1/admin", snippet: "苏州" },
    ];
  });
  mock.method(globalThis, "fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url === TRAVEL_SEARCH_ENDPOINT) {
      searchCalls++;
      assert.equal(JSON.parse(String(init?.body)).query, "苏州 旅游 景区 交通 门票 开放时间 官方公告");
      if (scenario === "failure") return new Response("synthetic-provider-fault", { status: 503 });
      const pages = scenario === "empty" ? [] : [
        { name: `苏州官方信息 ${sourceUrl}`, url: sourceUrl, snippet: `苏州园林旅行 https://private.example/injected` },
        { name: "无关网页", url: "http://127.0.0.1/admin", snippet: "苏州" },
      ];
      return Response.json({ code: 200, data: { webPages: { value: pages } } });
    }
    assert.match(url, /\/responses$/);
    const body = JSON.parse(String(init?.body));
    modelInputs.push(body.input[1].content[0].text);
    return Response.json(modelReply());
  });
});
afterEach(() => { mock.restoreAll(); process.env = { ...originalEnv }; });

async function generateRequest() {
  const image = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#6baf81" } }).png().toBuffer();
  const brief: Brief = { ...emptyBrief, topic: "苏州旅行", creationTypes: ["travel"], primaryType: "travel", travelSearchPlace: "苏州", travelSearch: true };
  const form = new FormData();
  form.set("payload", JSON.stringify({ brief, mode: "live", imageIds: [syntheticImageId] }));
  form.append("images", new Blob([new Uint8Array(image)], { type: "image/png" }), "synthetic.png");
  return { request: new Request("http://localhost/api/generate", { method: "POST", headers: { host: "localhost", origin: "http://localhost" }, body: form }), brief, image };
}

test("非回环部署的资料更新必须通过访问令牌校验，再调用搜索服务",async()=>{
  process.env={...process.env,APP_LOCAL_ONLY:"0",NODE_ENV:"production",APP_ACCESS_TOKEN:"synthetic-access-token-long-enough"};
  const request=(token?:string)=>new Request("https://workbench.example/api/travel-research",{
    method:"POST",headers:{host:"workbench.example",origin:"https://workbench.example","Content-Type":"application/json",...(token?{"x-access-token":token}:{})},
    body:JSON.stringify({place:"苏州",enabled:true}),
  });
  assert.equal((await refreshResearch(request())).status,401);
  assert.equal((await refreshResearch(request("wrong-token"))).status,401);
  assert.equal(searchCalls,0);assert.equal(modelInputs.length,0);
  const accepted=await refreshResearch(request(process.env.APP_ACCESS_TOKEN));
  assert.equal(accepted.status,200);assert.equal(searchCalls,1);assert.equal(modelInputs.length,0);
  delete process.env.APP_ACCESS_TOKEN;
  const missingConfig=await refreshResearch(request());
  assert.equal(missingConfig.status,503);assert.equal((await missingConfig.json()).error.code,"ACCESS_NOT_CONFIGURED");assert.equal(searchCalls,1);
});

test("旅行来源经安全过滤传给模型、不传网址，生成后保存和读取不污染复制文本", async () => {
  const { request, brief, image } = await generateRequest();
  const response = await generate(request);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(searchCalls, 1); assert.equal(modelInputs.length, 1);
  assert.equal(data.research.status, "partial"); assert.equal(data.research.sources.length, 1);
  assert.equal(data.research.sources[0].url, sourceUrl);
  assert.match(modelInputs[0], /苏州园林旅行/);
  assert.doesNotMatch(modelInputs[0], /https:\/\/ylj\.suzhou\.gov\.cn|https:\/\/private\.example|127\.0\.0\.1/);
  assert.doesNotMatch(formatNote(data.result, 0), /https?:\/\//);
  assert.doesNotMatch(formatAll(data.result), /https?:\/\//);

  const draft = newDraft(), file = new File([new Uint8Array(image)], "synthetic.png", { type: "image/png" });
  draft.brief = brief; draft.mode = "live";
  draft.images = [{ id: syntheticImageId, file, preview: "blob:synthetic", width: 24, height: 16 }];
  draft.resultImages = [...draft.images]; draft.generatedInput = inputSnapshot(draft);
  draft.generation = { result: data.result, mode: "live", imageIds: [syntheticImageId], meta: data.meta, research: data.research };
  const stored = serializeDraft(draft, 1);
  await localStore.writeDraft(stored, null);
  const loaded = storedDraftSchema.parse(await localStore.getDraft(draft.id));
  assert.equal(loaded.generation?.research?.sources[0].url, sourceUrl);
  assert.deepEqual(loaded.generatedInput?.brief.creationTypes, ["travel"]);
  assert.doesNotMatch(formatNote(loaded.generation!.result, 0), /https?:\/\//);
});

test("旅行默认检索开启，无密钥可用浏览器，无结果或失败仍可生成并有提示", async () => {
  assert.equal(emptyBrief.travelSearch, true);
  for (const kind of ["partial", "no_results", "error"] as const) {
    scenario = kind === "no_results" ? "empty" : kind === "error" ? "failure" : "success";
    delete process.env.BOCHA_API_KEY;
    searchCalls = 0; modelInputs = [];
    const { request } = await generateRequest(); const response = await generate(request);
    assert.equal(response.status, 200); const data = await response.json();
    assert.equal(data.research.status, kind); assert.ok(data.research.notice.length > 0); assert.equal(modelInputs.length, 1);
    assert.equal(searchCalls, 1);
  }
});

test("云端后台任务在同一生成中检索一次并安全传递来源资料", async () => {
  process.env.APP_MODE = "cloud";
  const brief: Brief = { ...emptyBrief, topic: "苏州旅行", creationTypes: ["travel"], primaryType: "travel", travelSearchPlace: "苏州", travelSearch: true };
  const output = await execute({ kind: "generate", brief, images: [{ id: syntheticImageId, dataUrl: "data:image/jpeg;base64,c3ludGhldGlj" }], imageIds: [syntheticImageId] }, new AbortController().signal, randomUUID(), randomUUID()) as { research: { status: string; sources: { url: string }[] }; result: typeof result };
  assert.equal(searchCalls, 1); assert.equal(modelInputs.length, 1); assert.equal(output.research.status, "partial");
  assert.equal(output.research.sources[0].url, sourceUrl);
  assert.doesNotMatch(modelInputs[0], /https:\/\/ylj\.suzhou\.gov\.cn|https:\/\/private\.example/);
  assert.doesNotMatch(formatNote(output.result, 0), /https?:\/\//);
});

test("来源可能冲突时摘要和链接不交给模型，刷新资料不能应用到不同草稿", () => {
  const research = { status: "partial" as const, retrievedAt: "2026-01-01T00:00:00.000Z", potentialConflict: true, notice: "价格可能冲突", sources: [{ title: "苏州", url: sourceUrl, source: "ylj.suzhou.gov.cn", snippet: "门票100元" }] };
  const prompt = JSON.stringify(researchForPrompt(research));
  assert.doesNotMatch(prompt, /100元|https?:\/\//); assert.match(prompt, /冲突/);
  const draft = newDraft(); draft.generation = { result, mode: "demo", imageIds: [syntheticImageId], meta: { durationMs: 1, completedAt: new Date().toISOString() } };
  draft.generatedInput = { brief: emptyBrief, imageIds: [syntheticImageId], mode: "demo" };
  const version = researchFingerprint(draft);
  assert.equal(applyResearchIfCurrent({ ...draft, id: randomUUID() }, version, research).generation?.research, undefined);
  assert.deepEqual(applyResearchIfCurrent(draft, version, research).generation?.research, research);
});

function responseForModel(content: unknown) {
  return Response.json({ id: "fake-response", object: "response", status: "completed", output: [{ id: "fake-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(content), annotations: [] }] }] });
}
const syntheticResearch: TravelResearch = { status: "partial", retrievedAt: "2026-01-01T00:00:00.000Z", notice: "合成测试资料", sources: [{ title: "苏州", source: "ylj.suzhou.gov.cn", url: sourceUrl, snippet: "苏州园林信息" }] };
const onlyImage = [{ id: syntheticImageId, dataUrl: "data:image/jpeg;base64,c3ludGhldGlj" }];

test("模型把来源网址写进任一生成区域时拒绝且保留旧结果", async () => {
  const oldResult = structuredClone(result), oldSnapshot = JSON.stringify(oldResult);
  const examples: ((copy: ContentResult) => void)[] = [
    copy => { copy.titles[0] = `旅行 ${sourceUrl}`; },
    copy => { copy.coverCopy.headline = `旅行 ${sourceUrl}`; },
    copy => { copy.coverCopy.subline = `旅行 ${sourceUrl}`; },
    copy => { copy.imageCaptions[0].headline = `旅行 ${sourceUrl}`; },
    copy => { copy.imageCaptions[0].description = `旅行\n${sourceUrl}`; },
    copy => { copy.body = `旅行 ${sourceUrl}`; },
  ];
  for (const inject of examples) {
    const generated = structuredClone(result); inject(generated); let calls = 0;
    const transport = mock.method(globalThis, "fetch", async () => { calls++; return responseForModel(generated); });
    try {
      const brief: Brief = { ...emptyBrief, topic: "苏州旅行", creationTypes: ["travel"], primaryType: "travel" };
      await assert.rejects(generateContent(brief, onlyImage, undefined, undefined, undefined, syntheticResearch), error => error instanceof AppError && error.code === "INVALID_RESULT");
      assert.equal(calls, 1); assert.equal(JSON.stringify(oldResult), oldSnapshot);
    } finally { transport.mock.restore(); }
  }
});

test("标签补正不能泄漏来源网址，补正结果非法也不会覆盖旧结果", async () => {
  const brief: Brief = { ...emptyBrief, topic: "苏州旅行", creationTypes: ["travel"], primaryType: "travel" };
  const first = structuredClone(result); first.body = `来源 ${sourceUrl}`; first.hashtags = ["#不足"];
  const oldSnapshot = JSON.stringify(result); let calls = 0;
  let transport = mock.method(globalThis, "fetch", async () => { calls++; return responseForModel(first); });
  try {
    await assert.rejects(generateContent(brief, onlyImage, undefined, undefined, undefined, syntheticResearch), error => error instanceof AppError && error.code === "INVALID_RESULT");
    // The bad first response is rejected before it can be sent back for hashtag repair.
    assert.equal(calls, 1); assert.equal(JSON.stringify(result), oldSnapshot);
  } finally { transport.mock.restore(); }

  const cleanFirst = structuredClone(result); cleanFirst.hashtags = ["#不足"];
  calls = 0;
  transport = mock.method(globalThis, "fetch", async () => {
    calls++;
    return responseForModel(calls === 1 ? cleanFirst : { hashtags: [...result.hashtags.slice(0, 9), sourceUrl] });
  });
  try {
    await assert.rejects(generateContent(brief, onlyImage, undefined, undefined, undefined, syntheticResearch));
    assert.equal(calls, 2); assert.equal(JSON.stringify(result), oldSnapshot);
  } finally { transport.mock.restore(); }
});

test("用户自行提供的其他网址不会被误当成检索来源阻止，包括话题补正后", async () => {
  const ownUrl = "https://example.com/my-travel-diary";
  const brief: Brief = { ...emptyBrief, topic: "苏州旅行", details: `自己的记录：${ownUrl}`, creationTypes: ["travel"], primaryType: "travel" };
  const first = structuredClone(result); first.body = `用户自己的记录：${ownUrl}`; first.hashtags = ["#不足"];
  let calls = 0;
  const transport = mock.method(globalThis, "fetch", async () => {
    calls++;
    return responseForModel(calls === 1 ? first : { hashtags: result.hashtags });
  });
  try {
    const generated = await generateContent(brief, onlyImage, undefined, undefined, undefined, syntheticResearch);
    assert.equal(calls, 2); assert.match(generated.body, /https:\/\/example\.com\/my-travel-diary/);
    assert.equal(generated.hashtags.length, 10);
  } finally { transport.mock.restore(); }
});

test("手动更新仅允许本机同源，云端要求登录及匹配当前用户身份", async () => {
  const local = (origin: string) => new Request("http://localhost/api/travel-research", { method: "POST", headers: { host: "localhost", origin, "content-type": "application/json" }, body: JSON.stringify({ place: "苏州", enabled: true }) });
  assert.equal((await refreshResearch(local("https://foreign.example"))).status, 403);
  assert.equal((await refreshResearch(local("http://localhost"))).status, 200);

  const directory = await mkdtemp(join(tmpdir(), "xhs-research-isolated-")), origin = "http://127.0.0.1:3299";
  try {
    process.env = { ...process.env, APP_MODE: "cloud", CLOUD_LOCAL_TEST: "1", CLOUD_BACKEND: "sqlite", APP_ORIGIN: origin, CLOUD_SQLITE_PATH: join(directory, "test.sqlite"), CLOUD_BLOB_PATH: join(directory, "blobs"), SITE_ACCESS_HASH: await hashSecret("synthetic-site-pass-123"), ADMIN_BOOTSTRAP_HASH: await hashSecret("synthetic-admin-pass-123") };
    const gate = await issueGate("synthetic-site-pass-123");
    const gateCookie = `${gateCookieName()}=${gate}`;
    const gated = new Request(origin, { headers: { cookie: gateCookie } });
    await bootstrapAdmin(gated, "synthetic-admin-pass-123", "admin", "synthetic-password-123");
    const aliceToken = await registerUser(gated, "alice", "synthetic-password-456");
    const bobToken = await registerUser(gated, "bob", "synthetic-password-789");
    const cookie = (token: string) => `${gateCookie}; ${userCookieName()}=${token}`;
    const alice = await getRequestAuthState(new Request(origin, { headers: { cookie: cookie(aliceToken) } }));
    const bob = await getRequestAuthState(new Request(origin, { headers: { cookie: cookie(bobToken) } }));
    assert.ok(alice.user); assert.ok(bob.user);
    const cloudRequest = (session: string, identity: string) => new Request(`${origin}/api/travel-research`, { method: "POST", headers: { host: "127.0.0.1:3299", origin, cookie: session, "x-workspace-user": identity, "content-type": "application/json" }, body: JSON.stringify({ place: "苏州", enabled: true }) });
    assert.equal((await refreshResearch(cloudRequest("", alice.user.id))).status, 401);
    assert.equal((await refreshResearch(cloudRequest(cookie(aliceToken), bob.user.id))).status, 409);
    assert.equal((await refreshResearch(cloudRequest(cookie(aliceToken), alice.user.id))).status, 200);
    assert.equal((await refreshResearch(cloudRequest(cookie(bobToken), bob.user.id))).status, 200);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

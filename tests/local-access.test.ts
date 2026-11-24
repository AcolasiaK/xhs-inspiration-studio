// All credentials and content are sentinels; never load .env.local or call a real provider.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { getPublicConfig } from "../lib/server/config";
import { assertAppAccess, assertLocalRequest } from "../lib/server/guard";
import { POST as generate } from "../app/api/generate/route";
import { POST as rewrite } from "../app/api/rewrite/route";
import { POST as partial } from "../app/api/partial-rewrite/route";
import { POST as video } from "../app/api/video/route";
import { GET as hotGet, POST as hotPost } from "../app/api/hotspots/route";
import { getXhsHotspotsStore } from "../lib/server/xhs-hotspots-store";
import { blankCategory, type XhsHotspotState } from '../lib/xhs-hotspots';
import { xhsFixtureNote, xhsFixtureAnalysis } from './xhs-fixture';
import { emptyBrief } from "../lib/schema";
import { createDemoResult } from "../lib/demo";
import { videoInput, videoPlan } from "./video-fixture";

const originalEnv = { ...process.env };
let clock = Date.now();
let reply: unknown;
let outbound: ReturnType<typeof mock.method<typeof globalThis, "fetch">>;
beforeEach(() => {
  clock += 60_001; mock.method(Date, "now", () => clock);
  process.env = { ...process.env, NODE_ENV: "production", APP_LOCAL_ONLY: "1", APP_ACCESS_TOKEN: "test-old-private-token", OPENAI_API_KEY: "test-server-key-sentinel", OPENAI_MODEL: "test-model", OPENAI_BASE_URL: "https://rightapi.ai/v1" };
  delete process.env.VERCEL;
  outbound = mock.method(globalThis, "fetch", async () => Response.json({ id: "test-response", object: "response", status: "completed", output: [{ id: "test-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(reply), annotations: [] }] }] }));
  mock.method(console, "info", () => {}); mock.method(console, "error", () => {});
});
afterEach(() => { mock.restoreAll(); process.env = { ...originalEnv }; });
const brief = { ...emptyBrief, topic: "测试数据：本机使用", emoji: true };
const ids = [randomUUID()];
const json = (path: string, body: unknown, host = "127.0.0.1:3001", extra: Record<string, string> = {}) => new Request(`http://${host}/api/${path}`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
async function photo(path: string, extras = {}) {
  const form = new FormData();
  form.set("payload", JSON.stringify({ brief, imageIds: ids, mode: "live", ...extras }));
  const bytes = await sharp({ create: { width: 12, height: 10, channels: 3, background: "#cda98c" } }).png().toBuffer();
  form.append("images", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "synthetic.png");
  return new Request(`http://127.0.0.1:3001/api/${path}`, { method: "POST", headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" }, body: form });
}

for (const token of ["", "short", "test-old-private-token"]) test(`本机生产模式不依赖旧口令（${token ? "已配置" : "未配置"}），所有付费分支无需请求口令`, async () => {
  process.env.APP_ACCESS_TOKEN = token;
  const config = getPublicConfig();
  assert.equal(config.liveAvailable, true);
  assert.equal("accessRequired" in config, false);
  assert.deepEqual(Object.keys(config).sort(), ["liveAvailable", "providerName", "setupMessage"]);
  assert.doesNotMatch(JSON.stringify(config), /test-server-key-sentinel|test-old-private-token|口令/);
  reply = createDemoResult(ids);
  let response = await generate(await photo("generate"));
  assert.equal(response.status, 200); assert.equal((await response.json()).mode, "live");
  reply = { body: "模拟重写第一段。\n\n模拟重写第二段。" };
  response = await rewrite(await photo("rewrite", { body: "模拟原正文", direction: "natural", instruction: "" }));
  assert.equal(response.status, 200);
  reply = { titles: ["模拟新标题一", "模拟新标题二", "模拟新标题三"], imageCaptions: [], hashtags: [] };
  response = await partial(await photo("partial-rewrite", { current: createDemoResult(ids), target: "title_one", targetIndex: 0, direction: "natural", instruction: "" }));
  assert.equal(response.status, 200);
  for (const phase of ["before", "after"] as const) {
    reply = { plan: videoPlan() };
    response = await video(json("video", { action: "generate", input: videoInput(phase), current: null, targetId: "", instruction: "" }));
    assert.equal(response.status, 200);
  }
  const current = videoPlan(); reply = { shot: { ...current.shots[0], visual: "模拟改写画面" } };
  response = await video(json("video", { action: "rewrite", input: videoInput("after"), current, targetId: current.shots[0].shotId, instruction: "" }));
  assert.equal(response.status, 200);
  assert.equal(outbound.mock.callCount(), 6);
  for (const call of outbound.mock.calls) {
    assert.match(String(call.arguments[0]), /^https:\/\/rightapi\.ai\/v1\/responses$/);
    assert.doesNotMatch(JSON.stringify(call.arguments[1]?.headers), /test-old-private-token/);
  }
});

test("本机热点读取、更新与按篇拆解均无需口令，不改写真实缓存", async () => {
  const state: XhsHotspotState = { version: 2, categories: { travel: { ...blankCategory(), notes: [xhsFixtureNote] }, wedding: blankCategory(), daily: blankCategory() }, analyses: {}, analyzing: [], updating: false, progress: null, error: null, lastAttemptAt: null, lastSuccessAt: null, scheduler: false, storage: "disk", ordering: "测试" };
  const store = getXhsHotspotsStore();
  const read = mock.method(store, "state", async () => state);
  const update = mock.method(store, "update", async () => state);
  const analyze = mock.method(store, "analyze", async () => xhsFixtureAnalysis);
  for (const token of ["", "test-old-private-token"]) {
    process.env.APP_ACCESS_TOKEN = token;
    const response = await hotGet(new Request("http://127.0.0.1:3001/api/hotspots", { headers: { host: "127.0.0.1:3001" } }));
    assert.equal(response.status, 200); assert.equal((await response.json()).categories.travel.notes.length, 1);
    assert.equal((await hotPost(json("hotspots", { action: "update" }))).status, 200);
    assert.equal((await hotPost(json("hotspots", { action: "analyze", noteId: xhsFixtureNote.id }))).status, 200);
  }
  assert.equal(read.mock.callCount(), 4); assert.equal(update.mock.callCount(), 2); assert.equal(analyze.mock.callCount(), 2); assert.equal(outbound.mock.callCount(), 0);
});

test("本机模式拒绝非回环 Host、跨站 Origin、跨站读取与伪造转发头", async () => {
  assert.doesNotThrow(() => assertAppAccess(new NextRequest("http://127.0.0.1:3001/api/video", { headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" } })));
  for (const host of ["localhost", "127.0.0.1:3001", "[::1]:3001"]) assert.doesNotThrow(() => assertAppAccess(json("video", {}, host)));
  for (const request of [json("video", {}, "attacker.example"), json("video", {}, "192.168.1.8:3001"), json("video", {}, "localhost", { origin: "https://evil.example" }), json("video", {}, "localhost", { "sec-fetch-site": "cross-site" }), json("video", {}, "attacker.example", { "x-forwarded-host": "localhost" })]) {
    assert.throws(() => assertLocalRequest(request));
  }
  assert.equal((await hotGet(new Request("http://localhost/api/hotspots", { headers: { host: "localhost", "sec-fetch-site": "cross-site" } }))).status, 403);
  assert.equal((await video(json("video", {}, "attacker.example"))).status, 403);
  assert.equal((await hotPost(json("hotspots", { action: "update" }, "attacker.example"))).status, 403);
  assert.equal(outbound.mock.callCount(), 0);
});

test("未选择本机模式或云环境不因为 localhost 请求头而绕过原访问控制", () => {
  delete process.env.APP_LOCAL_ONLY;
  assert.throws(() => assertAppAccess(json("video", {})), /访问控制/);
  process.env.APP_ACCESS_TOKEN = "";
  assert.equal(getPublicConfig().liveAvailable, false);
  assert.throws(() => assertAppAccess(json("video", {})), /访问控制/);
  process.env.APP_LOCAL_ONLY = "1"; process.env.VERCEL = "1";
  assert.equal(getPublicConfig().liveAvailable, false);
  assert.throws(() => assertAppAccess(json("video", {})), /访问控制/);
});

test("所有本机启动命令同时启用本机模式并仅监听回环地址", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const key of ["dev", "start", "start:local"]) {
    assert.match(pkg.scripts[key], /APP_LOCAL_ONLY=1/);
    assert.match(pkg.scripts[key], /--hostname 127\.0\.0\.1(?:\s|$)/);
    assert.doesNotMatch(pkg.scripts[key], /0\.0\.0\.0/);
  }
});

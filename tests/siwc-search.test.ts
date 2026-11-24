import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchWithChatGPT, CHATGPT_SEARCH_TIMEOUT_MS } from "../lib/server/siwc/search";
import { travelResearchSchema } from "../lib/travel-research";

const previous = { ...process.env };
let directory = "";
const model = "gpt-synthetic-search";
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "siwc-search-synthetic-"));
  process.env = { ...process.env, NODE_ENV: "test", APP_MODE: "local", APP_LOCAL_ONLY: "1", SIWC_TEST_DIR: directory };
  delete process.env.VERCEL;
});
after(async () => { process.env = previous; await rm(directory, { recursive: true, force: true }); });

async function saveFake(overrides: Record<string, unknown> = {}) {
  await writeFile(path.join(directory, "connection.json"), JSON.stringify({
    version: 1, hostId: `urn:uuid:${randomUUID()}`, clientId: "oaiapp_synthetic_client", subject: "synthetic-subject",
    accessToken: "synthetic-search-access", refreshToken: "synthetic-search-refresh",
    scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3_600_000, model, ...overrides,
  }), { mode: 0o600 });
}

const url = "https://www.gov.cn/synthetic/travel";
const summary = "合成地点的公开交通资料适合作为出行准备参考，具体班次请查最新公告。citeturn0search0";
const citation = { type: "url_citation", url, title: "合成地点交通说明", start_index: summary.indexOf(""), end_index: summary.length };
const search = { id: "ws_synthetic", type: "web_search_call", status: "completed", action: { type: "search", queries: ["合成地点"], sources: [{ type: "url", url }] } };
const message = { id: "msg_synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: summary, annotations: [citation] }] };
function response(output: unknown[]) { return { id: "resp_synthetic", object: "response", created_at: 1, status: "completed", model, error: null, incomplete_details: null, output }; }
function eventResponse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function finalEvents(output: unknown[] = [search, message]) {
  return [{ type: "response.created", response: { ...response([]), status: "in_progress" } }, { type: "response.completed", response: response(output) }];
}
function mockSearch(run: (init?: RequestInit) => Response | Promise<Response>) {
  return mock.method(globalThis, "fetch", async (target: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(String(target).startsWith("https://api.openai.com/v1/"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-search-access");
    if (String(target).endsWith("/models")) return Response.json({ models: [{ slug: model, display_name: "Synthetic search", visibility: "list" }] });
    assert.equal(String(target), "https://api.openai.com/v1/responses");
    return run(init);
  });
}

test("订阅搜索使用官方工具、来源 include 和本机授权，一次请求无重试", async () => {
  await saveFake(); let calls = 0;
  const fetchMock = mockSearch(init => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, model); assert.equal(body.stream, true); assert.equal(body.store, false);
    assert.equal(body.tool_choice, "required"); assert.deepEqual(body.include, ["web_search_call.action.sources"]);
    assert.deepEqual(body.tools, [{ type: "web_search", search_context_size: "low", filters: { allowed_domains: ["gov.cn", "12306.cn", "news.cn", "people.com.cn"] } }]);
    assert.ok(!("max_tool_calls" in body)); assert.ok(!("max_output_tokens" in body)); assert.ok(!("text" in body));
    assert.deepEqual(JSON.parse(body.input[0].content[0].text), { searchQuery: "合成地点" });
    return eventResponse(finalEvents());
  });
  try {
    const result = await searchWithChatGPT({ query: "合成地点" });
    assert.equal(result.status, "partial"); assert.equal(result.sources.length, 1); assert.equal(calls, 1);
    assert.equal(result.provider, "chatgpt"); assert.equal(result.summaryKind, "search_summary"); assert.equal(result.query, "合成地点");
    assert.equal(result.sources[0].url, url); assert.doesNotMatch(result.sources[0].snippet, /[\uE000-\uF8FF]/u);
    assert.match(result.notice, /不是网页原文/u); assert.ok(travelResearchSchema.safeParse(result).success);
  } finally { fetchMock.mock.restore(); }
});

test("缺少实际搜索、缺少来源、来源不匹配或无平台引用都不冒充检索成功", async () => {
  await saveFake(); let output: unknown[] = [];
  const fetchMock = mockSearch(() => eventResponse(finalEvents(output)));
  const cases = [
    [message],
    [{ ...search, status: "failed" }, message],
    [{ ...search, action: { type: "search" } }, message],
    [search, { ...message, content: [{ type: "output_text", text: summary, annotations: [] }] }],
    [search, { ...message, content: [{ type: "output_text", text: summary, annotations: [{ ...citation, url: "https://www.news.cn/another" }] }] }],
    [search, { ...message, content: [{ type: "output_text", text: summary, annotations: [{ ...citation, end_index: summary.length + 1 }] }] }],
  ];
  try {
    for (output of cases) {
      const result = await searchWithChatGPT({ query: "合成地点" });
      assert.ok(["error", "no_results"].includes(result.status)); assert.equal(result.sources.length, 0);
    }
  } finally { fetchMock.mock.restore(); }
});

test("来源必须为 HTTPS 白名单域名，去重后最多保留五个引用", async () => {
  await saveFake();
  const links = [url, `${url}#anchor`, "http://www.gov.cn/insecure", "https://gov.cn.attacker.invalid/", "http://127.0.0.1/private", "https://www.gov.cn:8443/", "https://user:pass@www.gov.cn/", "https://www.news.cn/a", "https://www.people.com.cn/a", "https://www.12306.cn/a", "https://www.gov.cn/b", "https://www.gov.cn/c"];
  const fetchMock = mockSearch(() => eventResponse(finalEvents([
    { ...search, action: { type: "search", sources: links.map(item => ({ type: "url", url: item })) } },
    { ...message, content: [{ type: "output_text", text: summary, annotations: links.map(item => ({ ...citation, url: item })) }] },
  ])));
  try {
    const result = await searchWithChatGPT({ query: "合成地点" });
    assert.equal(result.status, "success"); assert.equal(result.sources.length, 5);
    assert.equal(result.sources.filter(item => item.url === url).length, 1);
    assert.ok(result.sources.every(item => !/attacker|127\.0|user:|8443/u.test(item.url)));
  } finally { fetchMock.mock.restore(); }
});

test("平台引用可缺少标题和附加标准 UTM，核对来源时保留内容定位参数", async () => {
  await saveFake();
  const sourceUrl = `${url}?article=1&lang=zh`;
  const { title: unusedTitle, ...withoutTitle } = citation;
  void unusedTitle;
  const citationUrls = [
    `${sourceUrl}&utm_source=chatgpt.com`,
    `${sourceUrl}&utm_medium=web&utm_campaign=search&utm_term=travel&utm_content=link&utm_id=test&utm_source_platform=chatgpt&utm_creative_format=text&utm_marketing_tactic=reference`,
    `${sourceUrl}&UTM_SOURCE=chatgpt.com#section`,
    `${url}?article=2&lang=zh&utm_source=chatgpt.com`,
    `${sourceUrl}&source=another`,
    `${sourceUrl}&ref=another`,
  ];
  const fetchMock = mockSearch(() => eventResponse(finalEvents([
    { ...search, action: { type: "search", sources: [{ type: "url", url: sourceUrl }] } },
    { ...message, content: [{ type: "output_text", text: summary, annotations: citationUrls.map(item => ({ ...withoutTitle, url: item })) }] },
  ])));
  try {
    const result = await searchWithChatGPT({ query: "合成地点" });
    assert.equal(result.status, "partial"); assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, sourceUrl);
    assert.equal(result.sources[0].title, "www.gov.cn · 来源页面（未提供标题）");
    assert.ok(travelResearchSchema.safeParse(result).success);
  } finally { fetchMock.mock.restore(); }
});

test("完成响应省略 output 时可以核对已结束的文字流、工具和平台引用事件", async () => {
  await saveFake(); let wrongIdentity = false;
  const fetchMock = mockSearch(() => eventResponse([
    { type: "response.created", response: { ...response([]), status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: search },
    { type: "response.output_text.delta", item_id: "msg_synthetic", output_index: 1, content_index: 0, delta: summary },
    { type: "response.output_text.annotation.added", item_id: wrongIdentity ? "wrong_message" : "msg_synthetic", output_index: 1, content_index: 0, annotation_index: 0, annotation: citation },
    { type: "response.output_text.done", item_id: "msg_synthetic", output_index: 1, content_index: 0, text: summary },
    { type: "response.completed", response: response([]) },
  ]));
  try {
    assert.equal((await searchWithChatGPT({ query: "合成地点" })).status, "partial");
    wrongIdentity = true;
    assert.equal((await searchWithChatGPT({ query: "合成地点" })).status, "error");
  } finally { fetchMock.mock.restore(); }
});

test("观察到第四个搜索调用时停止，不继续自动重试", async () => {
  await saveFake(); let calls = 0;
  const fetchMock = mockSearch(() => {
    calls++;
    return eventResponse([
      { type: "response.created", response: { ...response([]), status: "in_progress" } },
      ...Array.from({ length: 4 }, (_, index) => ({ type: "response.output_item.added", output_index: index, item: { ...search, id: `ws_${index}`, status: "in_progress" } })),
      { type: "response.completed", response: response([search, message]) },
    ]);
  });
  try {
    const result = await searchWithChatGPT({ query: "合成地点" });
    assert.equal(result.status, "error"); assert.match(result.notice, /步骤超过限制/u); assert.equal(calls, 1);
  } finally { fetchMock.mock.restore(); }
});

test("权限、额度、模型不兼容和网络异常只返回安全提示，无静默换源", async () => {
  await saveFake(); let status = 400, calls = 0;
  const logs: string[] = [];
  const logger = mock.method(console, "error", (...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  const fetchMock = mockSearch(() => {
    calls++;
    if (status === 0) throw new TypeError("SYNTHETIC_PRIVATE_NETWORK_MESSAGE");
    return Response.json({ error: { message: "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE" } }, { status });
  });
  try {
    for (const [value, expected] of [[400, /可能不支持搜索/u], [401, /授权已失效/u], [403, /使用权限/u], [429, /用量受限/u], [502, /服务暂时不可用/u], [0, /检查网络/u]] as const) {
      status = value;
      const result = await searchWithChatGPT({ query: "合成地点" });
      assert.equal(result.status, "error"); assert.match(result.notice, expected);
    }
    assert.equal(calls, 6); assert.equal(logs.length, 0);
  } finally { fetchMock.mock.restore(); logger.mock.restore(); }
});

test("取消上抛 AbortError，超时在 35 秒总上限内返回可恢复提示", async () => {
  await saveFake(); let entered: (() => void) | undefined, aborted = 0;
  const fetchMock = mockSearch(init => new Promise<Response>((_, reject) => {
    entered?.();
    const stop = () => { aborted++; reject(new DOMException("SYNTHETIC_PRIVATE", "AbortError")); };
    if (init?.signal?.aborted) stop(); else init?.signal?.addEventListener("abort", stop, { once: true });
  }));
  try {
    const controller = new AbortController();
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const request = searchWithChatGPT({ query: "合成地点", signal: controller.signal });
    const rejection = assert.rejects(request, { name: "AbortError" });
    await ready; controller.abort(); await rejection;
    assert.equal(aborted, 1);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const timeoutMock = mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.ok(ms <= CHATGPT_SEARCH_TIMEOUT_MS);
      const timeoutController = new AbortController();
      timers.push(setTimeout(() => timeoutController.abort(new DOMException("timeout", "TimeoutError")), ms === CHATGPT_SEARCH_TIMEOUT_MS ? 15 : 500));
      return timeoutController.signal;
    });
    try {
      const result = await searchWithChatGPT({ query: "合成地点" });
      assert.equal(result.status, "error"); assert.match(result.notice, /35 秒等待上限/u);
    } finally { timers.forEach(clearTimeout); timeoutMock.mock.restore(); }
  } finally { fetchMock.mock.restore(); }
});

test("空关键词不发请求；云端在读取授权之前拒绝搜索入口", async () => {
  await saveFake(); let calls = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected call"); });
  try {
    assert.equal((await searchWithChatGPT({ query: "  " })).status, "missing_place");
    assert.equal((await searchWithChatGPT({ query: "https://127.0.0.1/private" })).status, "missing_place");
    process.env.APP_MODE = "cloud"; process.env.APP_LOCAL_ONLY = "0";
    await assert.rejects(searchWithChatGPT({ query: "合成地点" }), error => { assert.equal((error as { code?: string }).code, "NOT_FOUND"); return true; });
    assert.equal(calls, 0);
  } finally { process.env.APP_MODE = "local"; process.env.APP_LOCAL_ONLY = "1"; fetchMock.mock.restore(); }
});

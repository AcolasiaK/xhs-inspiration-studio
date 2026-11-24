import { test } from "node:test";
import assert from "node:assert/strict";
import { searchBochaTravelInfo as searchTravelInfo, TRAVEL_SEARCH_ENDPOINT } from "../lib/server/travel-search";
import { isSafeTravelSourceUrl, travelResearchSchema } from "../lib/travel-research";

const now = () => new Date("2026-01-01T00:00:00.000Z");
const officialPage = (n: number) => ({ name: `苏州官方资讯 ${n}`, url: `https://www.gov.cn/article/${n}`, snippet: `旅行信息 ${n}`, datePublished: "2025-09-01T12:00:00+08:00" });
const response = (pages: unknown[]) => Response.json({ code: 200, data: { webPages: { value: pages } } });

test("只将地点发给固定搜索地址，不发送图片、正文或模型密钥", async () => {
  let count = 0;
  const fetcher: typeof fetch = async (url, options) => {
    count++;
    assert.equal(url, TRAVEL_SEARCH_ENDPOINT);
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(JSON.parse(String(options?.body)), { query: "苏州 旅游 景区 交通 门票 开放时间 官方公告", freshness: "noLimit", summary: false, count: 10 });
    return response([officialPage(1), officialPage(2), officialPage(3)]);
  };
  const result = await searchTravelInfo({ enabled: true, place: "苏州" }, { fetcher, apiKey: "synthetic-only", now });
  assert.equal(count, 1); assert.equal(result.status, "success"); assert.equal(result.sources.length, 3);
  assert.equal(result.retrievedAt, now().toISOString()); assert.match(result.notice, /矛盾/); assert.equal(travelResearchSchema.safeParse(result).success, true);
});

test("开关关闭、缺地点、缺配置时都不访问网络", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("不应调用搜索"); };
  assert.equal((await searchTravelInfo({ enabled: false, place: "苏州" }, { fetcher, apiKey: "synthetic" })).status, "disabled");
  assert.equal((await searchTravelInfo({ enabled: true, place: "" }, { fetcher, apiKey: "synthetic" })).status, "missing_place");
  assert.equal((await searchTravelInfo({ enabled: true, place: "苏州" }, { fetcher, apiKey: "" })).status, "not_configured");
  assert.equal((await searchTravelInfo({ enabled: true, place: "https://example.com" }, { fetcher, apiKey: "synthetic" })).status, "missing_place");
});

test("只留下合法、去重的公开政府铁路媒体链接，内容不足明确提示", async () => {
  const pages = [officialPage(1), officialPage(1), { name: "本地", url: "http://127.0.0.1/admin", snippet: "private" }, { name: "恶意", url: "https://gov.cn.attacker.com", snippet: "bad" }, { name: "跳转", url: "https://evil@gov.cn/a", snippet: "bad" }, { name: "苏州注入", url: "https://news.cn/article", snippet: "<b>内容</b>" }];
  const result = await searchTravelInfo({ enabled: true, place: "苏州" }, { apiKey: "synthetic", now, fetcher: async () => response(pages) });
  assert.equal(result.status, "partial"); assert.equal(result.sources.length, 2); assert.match(result.notice, /核实/);
  assert.equal(result.sources[1].snippet, "内容");
  assert.equal(isSafeTravelSourceUrl("https://www.gov.cn:8080/a"), false);
  assert.equal(isSafeTravelSourceUrl("https://www.gov.cn@127.0.0.1/a"), false);
  assert.equal(isSafeTravelSourceUrl("https://www.gov.cn/a"), true);
});

test("没有可靠结果、服务失败、畸形响应均可继续创作且不泄露响应", async () => {
  const input = { enabled: true, place: "苏州" };
  const options = { apiKey: "synthetic", now };
  const noResults = await searchTravelInfo(input, { ...options, fetcher: async () => response([{ name: "别站", url: "https://example.com", snippet: "文字" }]) });
  assert.equal(noResults.status, "no_results");
  for (const fetcher of [async () => new Response("SECRET_PRIVATE_RESPONSE", { status: 502 }), async () => Response.json({ invalid: true }), async () => { throw new Error("SECRET_PRIVATE_ERROR"); }]) {
    const result = await searchTravelInfo(input, { ...options, fetcher });
    assert.equal(result.status, "error"); assert.doesNotMatch(JSON.stringify(result), /SECRET_PRIVATE/);
  }
});

test("主动取消传递给上层，不会假装检索成功", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(searchTravelInfo({ enabled: true, place: "苏州", signal: controller.signal }, { apiKey: "synthetic" }), { name: "AbortError" });
});

test("提供方响应过慢时有界等待，不追加请求", async () => {
  let requests = 0;
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const result = await searchTravelInfo({ enabled: true, place: "苏州" }, { apiKey: "synthetic", timeoutMs: 20, fetcher: async () => { requests++; return new Promise(() => {}); } });
    assert.equal(result.status, "error"); assert.equal(requests, 1); assert.match(result.notice, /超时/);
  } finally { clearTimeout(keepAlive); }
});

test("价格或开放时间出现可能差异时标出待核实，保留原始来源供用户检查", async () => {
  const pages = [{ ...officialPage(1), snippet: "苏州某景区门票价格100元" }, { ...officialPage(2), snippet: "苏州某景区门票价格120元" }];
  const result = await searchTravelInfo({ enabled: true, place: "苏州" }, { apiKey: "synthetic", fetcher: async () => response(pages) });
  assert.equal(result.status, "partial"); assert.equal(result.potentialConflict, true); assert.match(result.notice, /差异/); assert.equal(result.sources.length, 2);
});

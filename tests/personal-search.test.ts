import { mockSearchBrowser } from "./browser-search-fixture";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../lib/errors";
import { formatAll, formatNote } from "../lib/format";
import { safeDerivedPersonalSearchQuery, safePersonalSearchQuery } from "../lib/personal/search-query";
import { emptyPersonalInput, personalRequestSchema } from "../lib/personal/schema";
import { runPersonal } from "../lib/server/personal";
import { searchPersonalBackground } from "../lib/server/personal-search";
import { searchBochaTravelInfo as searchTravelInfo, TRAVEL_SEARCH_ENDPOINT } from "../lib/server/travel-search";

const input = { ...emptyPersonalInput, experience: "今天在杭州西湖散步，觉得放松，想把这个片刻记下来。", search: true };
const note = { titles: ["湖边片刻", "放慢一步", "随心走走", "今天的松弛", "留住眼前"], coverCopy: { headline: "湖边片刻", subline: "记录放松" }, imageCaptions: [], body: "测试生成正文，按自己的感受书写。\n\n来源保留在文案之外。", hashtags: ["#散步", "#西湖", "#杭州", "#慢生活", "#旅行", "#旅行记录", "#日常", "#生活记录", "#放松", "#风景"], warnings: [] };

function modelResponse(value: unknown) {
  return Response.json({ id: "synthetic-search-test", object: "response", created_at: 1, model: "synthetic", status: "completed", error: null, incomplete_details: null,
    output: [{ id: "synthetic-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] });
}
const searchState: { queries: string[]; onSearch?: () => void } = { queries: [] };
function searchPages() {
  return [1,2,3].map(index => ({title:`杭州西湖合成背景 ${index}`,url:`https://www.gov.cn/personal-search-fixture/${index}`,snippet:`杭州西湖的合成背景资料 ${index}，从湖滨入口出发，沿湖步行到码头，回程可在湖滨站乘坐公交。`}));
}
function searchResponse() { return Response.json({code:200,data:{webPages:{value:searchPages().map(p=>({...p,name:p.title}))}}}); }
function environment(bocha = true) {
  const previous = { ...process.env };
  process.env.APP_MODE = "local"; process.env.APP_LOCAL_ONLY = "1";
  process.env.OPENAI_API_KEY = "synthetic-model-key"; process.env.OPENAI_MODEL = "synthetic-model";
  delete process.env.OPENAI_BASE_URL;
  if (bocha) process.env.BOCHA_API_KEY = "synthetic-search-key"; else delete process.env.BOCHA_API_KEY;
  searchState.queries = []; searchState.onSearch = undefined;
  const browser = mockSearchBrowser(query => { searchState.queries.push(query); searchState.onSearch?.(); return searchPages(); });
  return () => { browser.mock.restore(); process.env = previous; };
}
function modelMaterial(init?: RequestInit) {
  const request = JSON.parse(String(init?.body));
  return JSON.parse(request.input.find((item: { role: string }) => item.role === "user").content[0].text);
}

test("个人检索关闭时只生成提示词，不请求搜索或要求模型提取检索词", async () => {
  const restore = environment(); let modelCalls = 0;
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.notEqual(String(url), TRAVEL_SEARCH_ENDPOINT); modelCalls++;
    const body = JSON.parse(String(init?.body));
    assert.ok(!body.text.format.schema.properties.searchQuery);
    return modelResponse({ prompt: "关闭联网时的合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "保留散步时的松弛" });
  });
  try {
    const result = await runPersonal(personalRequestSchema.parse({ action: "prompt", input: { ...input, search: false }, imageIds: [] }), [], new AbortController().signal);
    assert.equal(modelCalls, 1); assert.equal(result.research?.status, "disabled");
  } finally { net.mock.restore(); restore(); }
});

test("仅有经历时同次模型提取公开词，搜索不收到完整经历，用户指定词优先", async () => {
  const restore = environment(); const queries = searchState.queries; let modelCalls = 0;
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === TRAVEL_SEARCH_ENDPOINT) {
      const search = JSON.parse(String(init?.body)); queries.push(search.query);
      assert.doesNotMatch(String(init?.body), /今天在|觉得放松|记下来|synthetic-model-key/u);
      return searchResponse();
    }
    modelCalls++; assert.equal(modelMaterial(init).context.input.experience, input.experience);
    return modelResponse({ prompt: "仅依据已给经历的合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "保留散步时的松弛", guideScope: "segment", searchQuery: "杭州 西湖" });
  });
  try {
    const derived = await runPersonal(personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }), [], new AbortController().signal);
    assert.equal(derived.research?.query, "杭州 西湖");
    assert.ok(queries.some(query => query.startsWith("杭州 西湖") && query.includes("游览线路")));
    assert.ok(queries.some(query => query.startsWith("杭州 西湖") && query.includes("交通")));
    assert.ok(queries.every(query => !/今天在|觉得放松|记下来|synthetic-model-key/u.test(query)));
    queries.length = 0;
    await runPersonal(personalRequestSchema.parse({ action: "prompt", input: { ...input, searchPlace: "苏州 园林" }, imageIds: [] }), [], new AbortController().signal);
    assert.equal(modelCalls, 2);
    assert.ok(queries.length > 0 && queries.every(query => query.startsWith("苏州 园林 ")));
    assert.doesNotMatch(queries.join(" "), /今天在|觉得放松|记下来|synthetic-model-key/u);
  } finally { net.mock.restore(); restore(); }
});

test("敏感格式、网址和超长检索词被拒绝，不外发搜索", async () => {
  const invalid = ["https://example.com/path", "杭州\n私人备注", "me@example.com", "138 1234 5678", "sk-syntheticcredential", "Bearer synthetic", "我的密码是测试值", "验证码 123456", "口令 测试", "词".repeat(101)];
  for (const query of invalid) assert.equal(safePersonalSearchQuery(query), "", query);
  assert.equal(safePersonalSearchQuery("  杭州，西湖  "), "杭州 西湖");
  const restore = environment(); let calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected request"); });
  try {
    for (const query of invalid) {
      const result = await searchPersonalBackground({ query, enabled: true }, "relay");
      assert.equal(result.status, "missing_place");
    }
    assert.equal(calls, 0);
  } finally { net.mock.restore(); restore(); }
});

test("模型复制经历全文或长句时不外发，仍保留创作提示词与输入", async () => {
  assert.equal(safeDerivedPersonalSearchQuery("杭州 西湖", input.experience), "杭州 西湖");
  assert.equal(safeDerivedPersonalSearchQuery(input.experience, input.experience), "");
  assert.equal(safeDerivedPersonalSearchQuery(input.experience.replace(/[，。]/gu, " "), input.experience), "");
  assert.equal(safeDerivedPersonalSearchQuery("一 二 三 四 五 六", input.experience), "");
  assert.equal(safeDerivedPersonalSearchQuery("词".repeat(21), input.experience), "");
  const restore = environment(); let calls = 0;
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    assert.notEqual(String(url), TRAVEL_SEARCH_ENDPOINT, "错误提取的日记全文不能发往搜索服务");
    calls++; return modelResponse({ prompt: "输入仍可以用于创作的合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "保留散步时的松弛", guideScope: "segment", searchQuery: input.experience });
  });
  try {
    const payload = personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }); const before = structuredClone(payload);
    const result = await runPersonal(payload, [], new AbortController().signal);
    assert.equal(result.research?.status, "missing_place"); assert.equal(result.research?.sources.length, 0);
    assert.ok(typeof result.prompt === "string"); assert.match(result.prompt, /输入仍可以用于创作/u);
    assert.equal(calls, 1); assert.deepEqual(payload, before);
  } finally { net.mock.restore(); restore(); }
});

test("本机未配置博查也可检索，不调用模型或搜索 API", async () => {
  const restore = environment(false); let calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  try {
    const result = await searchPersonalBackground({ query: "杭州 西湖", enabled: true }, "relay");
    assert.equal(result.status, "success"); assert.equal(result.provider, "browser");
    assert.equal(result.sources.length, 3); assert.equal(calls, 0);
  } finally { net.mock.restore(); restore(); }
});

test("云端保留原独立搜索兼容，401/429/502 分类且不失败切换", async () => {
  const restore = environment(); process.env.APP_MODE = "cloud"; let calls = 0, status = 401;
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    calls++; assert.equal(String(url), TRAVEL_SEARCH_ENDPOINT);
    return new Response("SYNTHETIC_PRIVATE_ERROR_SHOULD_NOT_LEAK", { status });
  });
  try {
    for (const source of ["relay", "chatgpt"] as const) {
      for (const failure of [{ status: 401, message: /密钥无效|权限/u }, { status: 429, message: /受限/u }, { status: 502, message: /服务暂时异常/u }]) {
        status = failure.status; const before = calls;
        const result = await searchPersonalBackground({ query: "杭州 西湖", enabled: true }, source);
        assert.equal(result.status, "error"); assert.match(result.notice, failure.message);
        assert.equal(result.provider, "bocha"); assert.equal(calls, before + 1);
        assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_LEAK/u);
      }
    }
  } finally { net.mock.restore(); restore(); }
});

test("博查超时有界返回，主动取消时抛出取消且不会继续模型或搜索请求", async () => {
  let calls = 0; const keepAlive = setTimeout(() => undefined, 500);
  try {
    const result = await searchTravelInfo({ place: "杭州 西湖", enabled: true, background: true }, { apiKey: "synthetic", timeoutMs: 15, fetcher: async () => { calls++; return new Promise(() => undefined); } });
    assert.equal(result.status, "error"); assert.match(result.notice, /超时/u); assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
  const restore = environment(); const controller = new AbortController(); const endpoints: string[] = [];
  searchState.onSearch = () => controller.abort();
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    endpoints.push(String(url));
    if (String(url) === TRAVEL_SEARCH_ENDPOINT) { controller.abort(); return searchResponse(); }
    return modelResponse({ prompt: "合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "保留散步时的松弛", guideScope: "segment", searchQuery: "杭州 西湖" });
  });
  try {
    const payload = personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }); const before = structuredClone(payload);
    await assert.rejects(runPersonal(payload, [], controller.signal), { name: "AbortError" });
    assert.equal(endpoints.length, 1); assert.equal(searchState.queries.length, 1); assert.deepEqual(payload, before);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runPersonal(payload, [], cancelled.signal), (error: unknown) => error instanceof AppError && error.code === "CANCELLED");
    assert.equal(endpoints.length, 1);
  } finally { net.mock.restore(); restore(); }
});

test("云端直接构造订阅检索请求仍被拒绝，不读取本机授权", async () => {
  const restore = environment(false); process.env.APP_MODE = "cloud"; let calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; throw new Error("unexpected network"); });
  try {
    assert.equal((await searchPersonalBackground({ query: "杭州 西湖", enabled: true }, "chatgpt")).status,"not_configured");
    assert.equal(calls, 0);
  } finally { net.mock.restore(); restore(); }
});

test("检索摘要与时间进入可编辑提示词，来源单独返回，确认和复制正文不混入网址", async () => {
  const restore = environment(); let finalPrompt = "", finalCalls = 0;
  const net = mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === TRAVEL_SEARCH_ENDPOINT) return searchResponse();
    const request = JSON.parse(String(init?.body));
    if (request.text.format.name === "personal_prompt") return modelResponse({ prompt: "模型整理的合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "保留散步时的松弛", guideScope: "segment", searchQuery: "杭州 西湖" });
    const sent = modelMaterial(init); finalPrompt = sent.confirmedPrompt; finalCalls++;
    assert.equal(sent.context.research.sources.length, 3);
    assert.doesNotMatch(JSON.stringify(sent.context.research), /https:\/\//u);
    return modelResponse(note);
  });
  try {
    const p = await runPersonal(personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }), [], new AbortController().signal);
    assert.ok(typeof p.prompt === "string"); assert.ok(p.research?.retrievedAt);
    assert.equal(p.research?.sources.length, 3); assert.match(p.prompt, /合成背景资料/u);
    assert.ok(p.prompt.includes(p.research.retrievedAt)); assert.doesNotMatch(p.prompt, /https:\/\//u);
    const edited = `${p.prompt}\n用户修改：结尾保留自然留白。`;
    const result = await runPersonal(personalRequestSchema.parse({ action: "generate", input, imageIds: [], confirmedPrompt: edited, research: p.research }), [], new AbortController().signal);
    assert.equal(finalPrompt, edited); assert.equal(finalCalls, 1); assert.ok("result" in result && result.result);
    assert.doesNotMatch(formatNote(result.result, 0), /https:\/\/|gov.cn|合成背景资料/u);
    assert.doesNotMatch(formatAll(result.result), /https:\/\/|gov.cn|合成背景资料/u);
  } finally { net.mock.restore(); restore(); }
});

test("思考+攻略根据整地或局部范围决定是否增查经典景点，正文资料进入确认提示词", async () => {
  const restore = environment();
  const {createPersonalStyle,activatePersonalStyle} = await import("../lib/server/personal-style-store");
  const {emptyRuleContent} = await import("../lib/personal/style-rules");
  const owner = "route-regression";
  const record = await createPersonalStyle(owner,emptyRuleContent("思考+攻略"));
  await activatePersonalStyle(owner,record.id,record.revision,record.draftVersionId);
  const queries:string[] = [];
  const browser = mockSearchBrowser(q=>{
    queries.push(q);
    const articles=[
      {title:"大理概况",url:"https://www.gov.cn/general",snippet:"大理古城年游客人数增长。"},
      {title:"大理古城步行游线",url:"https://www.gov.cn/walk",snippet:"大理古城从南城门出发，沿道路步行至游客中心。"},
      {title:"大理洱海公交",url:"https://www.gov.cn/transit",snippet:"大理洱海入口可乘坐接驳车到码头。"},
    ];
    return q.includes("精品线路") ? [{
      title:"大理经典旅游线路",
      url:"https://www.gov.cn/destination",
      snippet:"大理古城→崇圣寺三塔→苍山；喜洲古镇→双廊，可乘车衔接。",
    }, ...articles] : articles;
  });
  let guideScope: "segment" | "destination" = "segment";
  const net=mock.method(globalThis,"fetch", async()=>modelResponse({prompt:"合成写作要求",coreIntent:"想念当时的声音",writingPlan:"从听歌的片刻说起，再写出古城到湖岸的建议走法。",searchQuery:"大理 古城 洱海",guideScope}));
  try {
    const prepareGuide = (requirements:string) => runPersonal(personalRequestSchema.parse({action:"prompt",input:{...input,styles:[record.id],searchPlace:"大理",experience:"去过大理古城、洱海。",requirements},imageIds:[]}),[],new AbortController().signal,"relay",owner);
    const response = await prepareGuide("只写古城到湖边半日游");
    assert.match(queries[0],/大理 古城 游览线路/);
    assert.match(queries[1],/大理 洱海 游玩 路线 交通/);
    assert.match(response.prompt!,/接驳车到码头/u);
    assert.doesNotMatch(response.prompt!,/年游客人数增长/u);
    assert.ok(queries.every(q=>!q.includes("精品线路")));
    queries.length=0;
    guideScope="destination";
    const overview=await prepareGuide("给第一次去大理的人一份完整路线");
    assert.match(queries[0],/^大理 旅游 精品线路 推荐 景点 /u);
    assert.match(overview.prompt!,/崇圣寺三塔→苍山/u);
    assert.match(overview.prompt!,/为第一次去的读者整理整地行程/u);
    assert.equal(net.mock.callCount(),2);
  } finally {net.mock.restore();browser.mock.restore();restore();}
});

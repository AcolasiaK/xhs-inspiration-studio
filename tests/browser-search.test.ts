import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { searchBrowserBackground, browserSearchTransport, type BrowserSearchPort } from "../lib/server/browser-search";
import { searchTravelInfo } from "../lib/server/travel-search";
import { travelResearchSchema } from "../lib/travel-research";

const url = "https://www.dali.gov.cn/travel.html";
const redirect = (value: string) => `https://www.bing.com/ck/a?u=a1${Buffer.from(value).toString("base64url")}`;
function fixture(options: { pages?: unknown[]; blocked?: boolean; wrongQuery?: boolean; document?: object } = {}) {
  const calls: string[][] = []; let queryUrl = "";
  const port: BrowserSearchPort = async args => {
    calls.push(args);
    if (args[0] === "open") { queryUrl = args[1]; return { targetId: "owned-tab" }; }
    if (args[0] === "navigate") { queryUrl = args[1]; return { ok: true }; }
    if (args[0] === "evaluate" && options.document) {
      const inspect = args[args.indexOf("--fn") + 1];
      return { result: await runInNewContext(`(${inspect})()`, {
        document: options.document, location: { href: queryUrl }, setTimeout: queueMicrotask,
      }) };
    }
    if (args[0] === "evaluate") return { result: { url: options.wrongQuery ? "https://cn.bing.com/search?q=other" : queryUrl, blocked: options.blocked ?? false, pages: options.pages ?? [{ title: "大理官方旅行", url: redirect(url), snippet: "大理洱海交通说明。" }] } };
    return { ok: true };
  };
  return { calls, port };
}
test("本机无密钥或已配置博查均直接读取浏览器来源，保留来源实际链接", async () => {
  const env = { ...process.env }; const f = fixture();
  const browser = mock.method(browserSearchTransport, "run", f.port);
  const network = mock.method(globalThis, "fetch", async () => { throw new Error("不得调用搜索 API"); });
  try {
    process.env.APP_MODE = "local";
    for (const key of ["", "synthetic-unused"]) {
      process.env.BOCHA_API_KEY = key;
      const result = await searchTravelInfo({ place: "大理", enabled: true });
      assert.equal(result.provider, "browser"); assert.equal(result.status, "partial");
      assert.equal(result.sources[0].url, url); assert.equal(result.query, "大理");
      assert.ok(travelResearchSchema.safeParse(result).success);
    }
    assert.equal(network.mock.callCount(), 0);
    assert.equal(f.calls.filter(c => c[0] === "close").length, 2);
    assert.ok(f.calls.filter(c => c[0] === "evaluate").every(c => c[2] === "owned-tab"));
  } finally { browser.mock.restore(); network.mock.restore(); process.env = env; }
});
test("关闭检索、敏感输入和云端不能启动本机浏览器", async () => {
  const f = fixture(); const env = { ...process.env };
  try {
    process.env.APP_MODE = "local";
    for (const place of ["", "https://example.com", "13812345678", "密码 test", "大理\n个人经历"]) {
      assert.equal((await searchBrowserBackground({ place, enabled: true }, { port: f.port })).status, "missing_place");
    }
    assert.equal((await searchBrowserBackground({ place: "大理", enabled: false }, { port: f.port })).status, "disabled");
    process.env.APP_MODE = "cloud";
    assert.equal((await searchBrowserBackground({ place: "大理", enabled: true }, { port: f.port })).status, "not_configured");
    assert.equal(f.calls.length, 0);
  } finally { process.env = env; }
});
test("解码后的私网、伪官方、重复与不相关来源被过滤，价格冲突有提示", async () => {
  const f = fixture({ pages: [
    { title: "大理票价", url: redirect(url), snippet: "大理门票100元" },
    { title: "大理重复", url: url + "#part", snippet: "大理门票100元" },
    { title: "大理另一票价", url: "https://www.news.cn/a.html", snippet: "大理门票80元" },
    ...["http://127.0.0.1/admin", "https://gov.cn.evil.example/a", "https://www.gov.cn@evil.example/a", "javascript:alert(1)"].map(url => ({ title: "大理", url: redirect(url), snippet: "大理" })),
    { title: "杭州", url: "https://www.gov.cn/irrelevant", snippet: "西湖" },
  ] });
  const result = await searchBrowserBackground({ place: "大理", enabled: true }, { port: f.port });
  assert.equal(result.sources.length, 2); assert.equal(result.potentialConflict, true); assert.equal(result.status, "partial");
  assert.equal(result.sources[0].publishedAt, undefined);
});
test("验证码、错页、无结果与 CLI 失败如实提示且不泄漏底层错误", async () => {
  for (const options of [{ blocked: true }, { wrongQuery: true }, { pages: [] }]) {
    const f = fixture(options);
    const result = await searchBrowserBackground({ place: "大理", enabled: true }, { port: f.port });
    assert.equal(result.sources.length, 0); assert.notEqual(result.status, "success");
    if (options.blocked) assert.match(result.notice, /验证/);
    // Verification tabs stay available for the user; all other owned tabs close.
    assert.equal(f.calls.some(c => c[0] === "close"), !options.blocked);
  }
  const result = await searchBrowserBackground({ place: "大理", enabled: true }, { port: async () => { throw new Error("PRIVATE_CLI_CREDENTIAL"); } });
  assert.equal(result.status, "error"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CLI/);
});
test("必应英文验证页保留给用户，正常结果引用相同文字仍可使用", async () => {
  const message = "One last step\nPlease solve the challenge below to continue";
  const card = {
    querySelector: (selector: string) => selector === "h2 a"
      ? { textContent: "大理出行", href: url }
      : { innerText: "大理出行指南：" + message },
  };
  for (const hasResult of [false, true]) {
    const f = fixture({ document: {
      body: { innerText: hasResult ? "大理出行指南：" + message : "Rewards\n" + message },
      querySelector: (selector: string) => hasResult && selector.split(",").includes("li.b_algo") ? card : null,
      querySelectorAll: (selector: string) => hasResult && selector === "li.b_algo" ? [card] : [],
    } });
    const result = await searchBrowserBackground({ place: "大理", enabled: true }, { port: f.port });
    if (hasResult) {
      assert.equal(result.status, "partial");
      assert.equal(result.sources[0]?.url, url);
    } else {
      assert.equal(result.status, "error");
      assert.match(result.notice, /验证/);
      assert.equal(result.sources.length, 0);
    }
    assert.equal(f.calls.some(call => call[0] === "close"), hasResult);
  }
});
test("用户取消传播且清理自己的标签；总超时不等待挂起的浏览器调用", async () => {
  const controller = new AbortController(); const f = fixture();
  const port: BrowserSearchPort = async (args, signal) => { if (args[0] === "evaluate") controller.abort(); return f.port(args, signal); };
  await assert.rejects(searchBrowserBackground({ place: "大理", enabled: true, signal: controller.signal }, { port }), { name: "AbortError" });
  assert.deepEqual(f.calls.at(-1), ["close", "owned-tab"]);
  const keepAlive = setTimeout(() => undefined, 1000);
  try {
    const result = await searchBrowserBackground({ place: "大理", enabled: true }, { timeoutMs: 15, port: async args => args[0] === "start" ? {} : new Promise(() => undefined) });
    assert.equal(result.status, "error"); assert.match(result.notice, /超时/);
  } finally { clearTimeout(keepAlive); }
});

test("打开页面时取消仍取得晚到的标签身份并清理，不再导航搜索", async () => {
  const controller = new AbortController(), calls: string[][] = [];
  const port: BrowserSearchPort = async (args, signal) => {
    calls.push(args);
    if (args[0] === "open") {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      signal.throwIfAborted();
      return { targetId: "late-owned-tab" };
    }
    return {};
  };
  await assert.rejects(searchBrowserBackground({place:"大理",enabled:true,signal:controller.signal},{port}),{name:"AbortError"});
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(calls.some(args => args[0] === "close" && args[1] === "late-owned-tab"));
  assert.ok(!calls.some(args => args[0] === "navigate"));
});

test("攻略中缺少的目的地触发简化补搜；五条城市概况也不能冒充可用路线",async()=>{
  const f=fixture({pages:Array.from({length:5},(_,i)=>({title:"大理市概况",url:"https://www.gov.cn/"+i,snippet:"大理古城与洱海游客数量增加。"}))});
  const r=await searchBrowserBackground({place:"大理 古城 洱海",enabled:true,guide:true},{port:f.port});
  assert.equal(r.status,"no_results");
  const queries=f.calls.filter(c=>c[0]==="navigate").map(c=>new URL(c[1]).searchParams.get("q"));
  assert.equal(queries.length,3);
  assert.match(queries[2]!,/^大理 洱海 交通 /u);
});

test("攻略查公开网页，单个景点摘要只有预告时读取并核对正文", async () => {
  const guideUrl = "https://zh.wikivoyage.org/wiki/" + encodeURIComponent("洛伽寺");
  const guidePage = { title: "洛伽寺游览攻略", url: guideUrl, snippet: "本页介绍游览安排。" };
  for (const relevant of [true, false]) {
    let location = "";
    const searches: string[] = [], articles: string[] = [];
    const port: BrowserSearchPort = async args => {
      if (args[0] === "open") return { targetId: "ours" };
      if (args[0] === "navigate") {
        location = args[1];
        const q = new URL(location).searchParams.get("q");
        if (q) searches.push(q); else articles.push(location);
      }
      if (args[0] === "evaluate") {
        if (location === guideUrl) return { result: { url: location, text: relevant
          ? "到洛伽寺可从黄金海岸沿桥步行至山门，再沿海岸步道回到停车场。"
          : "到杭州西湖可从湖滨入口步行至断桥，再沿白堤走到孤山入口。\n相关阅读：洛伽寺" } };
        return { result: { url: location, blocked: false, pages: [guidePage] } };
      }
      return { ok: true };
    };
    const result = await searchBrowserBackground({ place: "洛伽寺", enabled: true, guide: true }, { port });
    assert.doesNotMatch(searches[0], /site:/u);
    assert.match(searches.find(q => q.includes("交通")) ?? "", /site:gov.cn/u);
    assert.deepEqual(articles, [guideUrl]);
    assert.equal(result.sources.length, relevant ? 1 : 0);
    if (relevant) {
      assert.equal(result.sources[0].kind, "travel_guide");
      assert.match(result.sources[0].snippet, /黄金海岸/u);
      assert.ok(travelResearchSchema.safeParse(result).success);
    }
  }
});

test("实际必应显示无匹配与结果列表未就绪应分别提示", async () => {
  for (const empty of [false, true]) {
    const f = fixture({ document: {
      body: { innerText: empty ? "没有与本次查询匹配的结果" : "搜索" },
      querySelector: (selector: string) => empty && selector.includes(".b_no") ? {} : null,
      querySelectorAll: () => [],
    } });
    const result = await searchBrowserBackground({ place: "洛伽寺", enabled: true, guide: true }, { port: f.port });
    assert.equal(result.status, empty ? "no_results" : "error");
    assert.match(result.notice, empty ? /搜索结果|匹配/u : /结果列表|页面结构/u);
  }
});

test("下一个查询需要人工验证时保留已取得的路线和验证标签", async () => {
  let location = "", count = 0;
  const calls: string[][] = [];
  const port: BrowserSearchPort = async args => {
    calls.push(args);
    if (args[0] === "open") return { targetId: "ours" };
    if (args[0] === "navigate") { location = args[1]; count++; }
    if (args[0] === "evaluate") return { result: {
      url: location, blocked: count === 2,
      pages: count === 1 ? [{ title: "大理古城步行游线", url, snippet: "从大理古城南门沿复兴路步行至五华楼。" }] : [],
    } };
    return { ok: true };
  };
  const result = await searchBrowserBackground({ place: "大理 古城", enabled: true, guide: true }, { port });
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0]?.url, url);
  assert.match(result.notice, /验证/u);
  assert.equal(calls.some(c => c[0] === "close"), false);
  assert.equal(count, 2);
});

test("必应新版结果容器、标题和截断摘要也可读取", async () => {
  const card = { querySelector: (selector: string) => {
    if (selector.includes("h3 a")) return { textContent: "大理洱海游线", href: url };
    if (selector.includes(".b_lineclamp3")) return { innerText: "大理洱海码头步行游线。" };
    return null;
  } };
  const f = fixture({ document: {
    body: { innerText: "大理洱海游线" },
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector.includes("#b_results .b_algo") ? [card] : [],
  } });
  const result = await searchBrowserBackground({ place: "大理 洱海", enabled: true }, { port: f.port });
  assert.equal(result.sources[0]?.url, url);
  assert.match(result.sources[0]?.snippet ?? "", /洱海码头/u);
});

test("补搜按缺口只执行一次不同于首轮的公开查询，交通可参考公开攻略", async () => {
  const guideUrl = "https://you.ctrip.com/sight/quanzhou243/14445.html";
  for (const [followUp, intent] of [["route", /游览顺序/u], ["transit", /公交站/u], ["sources", /一日游/u]] as const) {
    const f = fixture({ pages: [{ title: "泉州洛伽寺攻略", url: guideUrl, snippet: "泉州洛伽寺可从公交站沿桥步行到入口。" }] });
    const result = await searchBrowserBackground({ place: "泉州 洛伽寺", guide: true, enabled: true, followUp }, { port: f.port });
    const navigations = f.calls.filter(c=>c[0] === "navigate").map(c=>new URL(c[1]));
    const queries = navigations.filter(u=>u.hostname === "www.baidu.com").map(u=>u.searchParams.get("wd"));
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /^泉州 洛伽寺 /u);
    assert.match(queries[0]!, intent);
    assert.doesNotMatch(queries[0]!, /site:/u);
    assert.equal(result.sources[0]?.kind, "travel_guide");
  }
});

test("景点的城市前缀与简繁写法不妨碍核对攻略正文，同时排除异地同名寺庙", async () => {
  const guideUrl = "https://www.eastchinatrip.com/zh-hant/china-city-guides/quanzhou-travel-guide/";
  for (const place of ["泉州 泉州开元寺", "泉州开元寺"]) {
    for (const city of ["泉州", "潮州"]) {
      let location = "";
      const articles: string[] = [];
      const port: BrowserSearchPort = async args => {
        if (args[0] === "open") return { targetId: "ours" };
        if (args[0] === "navigate") {
          location = args[1];
          if (!new URL(location).searchParams.has("wd")) articles.push(location);
        }
        if (args[0] === "evaluate") return { result: location === guideUrl
          ? { url: location, text: city + "行程\n第一天從開元寺出發，沿西街步行至鐘樓，再轉乘公交車到古城入口。" }
          : { url: location, blocked: false, pages: [{ title: "開元寺旅遊攻略", url: guideUrl, snippet: "了解這趟旅遊行程。" }] } };
        return {};
      };
      const result = await searchBrowserBackground({ place, enabled: true, guide: true, followUp: "sources" }, { port });
      assert.deepEqual(articles, [guideUrl]);
      assert.equal(result.sources.length, city === "泉州" ? 1 : 0);
      if (city === "泉州") assert.match(result.sources[0].snippet, /從開元寺出發/u);
    }
  }
});

test("结果容器先于链接加载时等待可读标题与链接", async () => {
  let reads = 0;
  const card = { querySelector: (selector:string) => {
    if (selector === "h2 a" && ++reads > 1) return { textContent: "大理古城攻略", href: url };
    return selector === ".b_caption p" ? { innerText: "大理古城游览路线。" } : null;
  } };
  const f = fixture({ document: { body: { innerText:"" }, querySelector:()=>null,
    querySelectorAll:(selector:string)=>selector === "li.b_algo" ? [card] : [],
  } });
  const result = await searchBrowserBackground({ place:"大理", enabled:true }, {port:f.port});
  assert.equal(result.sources[0]?.url, url);
});

test("公开攻略详情遇到人工验证时停止并保留标签", async () => {
  const guideUrl = "https://zhuanlan.zhihu.com/p/717883054";
  let location = "";
  const calls: string[][] = [];
  const port: BrowserSearchPort = async args => {
    calls.push(args);
    if (args[0] === "open") return { targetId: "ours" };
    if (args[0] === "navigate") location = args[1];
    if (args[0] === "evaluate") {
      if (location === guideUrl) {
        return {result:await runInNewContext(`(${args.at(-1)})()`, {
          location:{href:guideUrl}, document:{
            body: {innerText:"请完成安全验证后继续访问"}, querySelectorAll:()=>[], querySelector:()=>null,
          },
        })};
      }
      return {result:{url:location,blocked:false,pages:[{title:"泉州开元寺攻略",url:guideUrl,snippet:"点击阅读完整攻略。"}]}};
    }
    return {};
  };
  const result = await searchBrowserBackground({place:"泉州 开元寺",guide:true,enabled:true,followUp:"route"},{port});
  assert.equal(result.status, "error");
  assert.match(result.notice, /验证/u);
  assert.equal(calls.some(c=>c[0]==="close"),false);
});

test("百度自然结果从卡片读取可核对的原文链接，百度跳转与百科卡不进入来源", async () => {
  const targetUrl = "https://zhuanlan.zhihu.com/p/717883054";
  const makeCard = (mu:string, tpl = "www_index") => ({
    getAttribute:(name:string)=>name === "mu" ? mu : name==="tpl" ? tpl : null,
    querySelector:(selector:string)=> {
      if (selector.includes("h3")) return { textContent:"泉州旅游攻略", href:"https://www.baidu.com/link?url=example" };
      if (selector.includes("summary-text")) return { textContent:"从泉州开元寺出发，沿西街步行至钟楼，再乘坐公交车到梧林。"};
      return null;
    },
  });
  const cards = [makeCard(targetUrl), makeCard("https://baike.baidu.com/item/泉州","bk_polysemy"), makeCard(""), makeCard("https://www.news.cn/irrelevant","wenda_generate")];
  const f = fixture({document:{ body:{innerText:"泉州旅游攻略"}, querySelector:()=>null,
    querySelectorAll:(selector:string)=>selector.includes("#content_left") ? cards : [],
  }});
  const result = await searchBrowserBackground({place:"泉州 开元寺 梧林 洛伽寺",guide:true,enabled:true,followUp:"route"},{port:f.port});
  const q = new URL(f.calls.find(c=>c[0]==="navigate")![1]);
  assert.equal(q.hostname,"www.baidu.com");
  assert.match(q.searchParams.get("wd")!,/泉州 开元寺/u);
  assert.doesNotMatch(q.searchParams.get("wd")!,/梧林|洛伽寺/u);
  assert.deepEqual(result.sources.map(s=>s.url), [targetUrl]);
  assert.ok(!f.calls.some(c=>c[0]==="navigate" && c[1].startsWith("https://www.baidu.com/link?")));
});

test("整座城市的补搜使用城市及通用攻略词，可引用没有点名模型所提取景点的市内公交路线", async () => {
  for (const [followUp, intent] of [["route", "步行 游览路线 攻略"], ["transit", "旅游攻略 路线 公交"], ["sources","一日游 路线 攻略"]] as const) {
  const f = fixture({ pages: [{ title: "轻松玩转泉州世遗", url: "https://zhuanlan.zhihu.com/p/717883054",
    snippet:"线路一从泉州站出发，沿城北路乘坐公交车到西街入口。" }] });
  const result = await searchBrowserBackground({
    place:"泉州 泉州开元寺 洛伽寺 梧林传统村落", enabled:true, guide:true, wholeDestination:true, followUp,
  }, {port:f.port});
  const urls = f.calls.filter(c=>c[0]==="navigate").map(c=>new URL(c[1]));
  assert.deepEqual(urls.filter(u=>u.hostname==="www.baidu.com").map(u=>u.searchParams.get("wd")),["泉州 " + intent]);
  assert.equal(result.sources[0]?.kind, "travel_guide");
  assert.match(result.sources[0]?.snippet ?? "", /城北路/u);
  }
});

test("补搜摘要已给出所缺的游览顺序时不再加载网页，及时保全来源", async () => {
  const f=fixture({pages:[{title:"泉州旅游攻略",url:"https://zhuanlan.zhihu.com/p/717883054",snippet:"泉州古城可从开元寺出发，沿西街步行至钟楼，再前往中山路。"}]});
  const result=await searchBrowserBackground({place:"泉州",guide:true,enabled:true,wholeDestination:true,followUp:"route"},{port:f.port});
  assert.equal(result.sources.length,1);
  assert.deepEqual(f.calls.filter(c=>c[0]==="navigate").map(c=>new URL(c[1]).hostname),["www.baidu.com"]);
});

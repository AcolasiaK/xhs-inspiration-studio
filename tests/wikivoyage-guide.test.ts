import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { runInNewContext } from "node:vm";
import type { BrowserSearchPort } from "../lib/server/openclaw-browser";
import { searchWikivoyageGuide, wikivoyageTransport } from "../lib/server/wikivoyage-guide";

const url = "https://zh.wikivoyage.org/zh-hans/" + encodeURIComponent("泉州");
const article = {
  url, title: "泉州", unavailable: false,
  rows: [
    { section: "观光", text: "开元寺，地址 鲤城区西街176号。" },
    { section: "观光", text: "泉州府文庙，地址 鲤城区中山中路泮宫内。" },
    { section: "交通", text: "泉州站可乘坐公交到市区。" },
    { section: "了解", text: "泉州市历史悠久，交通便利。" },
  ],
};
function fixture(result: unknown = article) {
  const calls: string[][] = [];
  const port: BrowserSearchPort = async args => {
    calls.push(args);
    if (args[0] === "open") return { targetId: "wiki-test-tab" };
    if (args[0] === "evaluate") return { result };
    return { ok: true };
  };
  return { calls, port };
}
test("整地攻略从公开旅行指南取得匹配点位，并优先保留本次涉及的地名", async () => {
  const f = fixture();
  const useFixture = mock.method(wikivoyageTransport, "run", f.port);
  try {
    const res = await searchWikivoyageGuide({ query: "泉州市 泉州开元寺 泉州府文庙 梧林传统村落", wholeDestination: true });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].kind, "travel_guide");
    assert.equal(res.sources[0].url, url);
    assert.match(res.sources[0].snippet, /开元寺.*西街176号/u);
    assert.match(res.sources[0].snippet, /泉州府文庙.*泮宫/u);
    assert.doesNotMatch(res.sources[0].snippet, /梧林传统村落|历史悠久/);
    assert.deepEqual(f.calls.filter(a=>a[0]==="navigate").map(a=>a[1]), [url]);
    assert.deepEqual(f.calls.at(-1), ["close", "wiki-test-tab"]);
  } finally { useFixture.mock.restore(); }
});
test("局部请求要求正文段落实有指定景点，城市交通不能代替洛伽寺攻略", async () => {
  assert.deepEqual((await searchWikivoyageGuide({ query: "泉州 洛伽寺" },fixture().port)).sources,[]);
  const res=await searchWikivoyageGuide({ query: "泉州 泉州开元寺" },fixture().port);
  assert.match(res.sources[0]?.snippet ?? "", /开元寺/u);
  assert.doesNotMatch(res.sources[0].snippet,/府文庙|泉州站/u);
});
test("空白、消歧义、错页与只有空泛介绍的指南都不生成来源", async () => {
  for (const doc of [{...article,unavailable:true}, {...article,title:"泉港"}, {...article,url:"https://example.org/zh-hans/泉州"},
    {...article,rows:[{section:"交通",text:"城市交通十分便利，市区适合旅游。"}]}]) {
    const f=fixture(doc);
    assert.deepEqual((await searchWikivoyageGuide({query:"泉州",wholeDestination:true},f.port)).sources,[]);
    assert.deepEqual(f.calls.at(-1),["close","wiki-test-tab"]);
  }
  const f=fixture();
  assert.deepEqual((await searchWikivoyageGuide({query:"https://example.org/path"},f.port)).sources,[]);
  assert.equal(f.calls.length,0);
});
test("打开空白标签期间取消时，清理晚到的标签且不访问网页",async()=>{
  const user=new AbortController();
  const calls:string[][]=[];
  let opened!: (reply:{targetId:string})=>void;
  const port:BrowserSearchPort = async args=>{
    calls.push(args);
    if(args[0]==="open")return new Promise(resolve=>{opened=resolve;user.abort();});
    return {};
  };
  await assert.rejects(searchWikivoyageGuide({query:"泉州",signal:user.signal},port),{name:"AbortError"});
  opened({targetId:"only-owned-tab"}); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[["start"],["open","about:blank"],["close","only-owned-tab"]]);
});

test("正文链接到其他消歧义条目时保留城市，消歧义页本身不作为攻略", async () => {
  const pageUrl = url;
  for (const ambiguous of [false, true]) {
    const port: BrowserSearchPort = async args => {
      if (args[0] === "open") return { targetId: "wiki-test-tab" };
      if (args[0] !== "evaluate") return { ok: true };
      const row = (tagName: string, innerText: string) => ({ tagName, innerText, closest: () => null, querySelector: () => null });
      const content = { querySelectorAll: () => [row("H2", "观光"), row("LI", "开元寺，地址 泉州市鲤城区西街176号。")] };
      const document = {
        title: "泉州 - 来自维基导游的旅行指南",
        querySelector(selector: string) {
          if (selector === "#mw-content-text .mw-parser-output") return content;
          if (selector.split(",").includes(".mw-disambig")) return { tagName: "A", title: "永安" };
          return null;
        },
        querySelectorAll: () => [{textContent: ambiguous ? "消歧义页" : "有消歧义链接的页面"}],
      };
      return { result: runInNewContext(`(${args.at(-1)})()`, { document, location: {href: pageUrl} }) };
    };
    const res = await searchWikivoyageGuide({query: "泉州 开元寺"}, port);
    assert.equal(res.sources.length, ambiguous ? 0 : 1);
  }
});

test("带县名的请求保留行政区，拒绝同名城市页面", async () => {
  const f = fixture({...article, title:"朝阳", url:"https://zh.wikivoyage.org/zh-hans/" + encodeURIComponent("朝阳")});
  assert.deepEqual((await searchWikivoyageGuide({query:"朝阳县",wholeDestination:true},f.port)).sources,[]);
  assert.equal(f.calls.find(a=>a[0]==="navigate")?.[1],"https://zh.wikivoyage.org/zh-hans/" + encodeURIComponent("朝阳县"));
});

test("新标签没有返回 ID 时停止检索，导航中丢失或取消后仅尝试关闭本次标签", async () => {
  const missing = fixture();
  const emptyOpen: BrowserSearchPort = async (args, signal) =>
    args[0] === "open" ? {} : missing.port(args, signal);
  const result = await searchWikivoyageGuide({ query: "泉州" }, emptyOpen);
  assert.match(result.notice ?? "", /标签/u);
  assert.deepEqual(missing.calls, [["start"]]);

  for (const cancelled of [false, true]) {
    const user = new AbortController();
    const f = fixture();
    const lost: BrowserSearchPort = async (args, signal) => {
      const res = await f.port(args, signal);
      if (args[0] === "navigate") {
        if (cancelled) user.abort();
        throw new Error("target closed");
      }
      return res;
    };
    const request = searchWikivoyageGuide({ query: "泉州", signal: user.signal }, lost);
    if (cancelled) await assert.rejects(request, {name: "AbortError"});
    else assert.match((await request).notice ?? "", /无法读取/u);
    assert.deepEqual(f.calls.filter(args => args[0] === "close"), [["close", "wiki-test-tab"]]);
    assert.equal(f.calls.some(args => args[0] === "evaluate"), false);
  }
});

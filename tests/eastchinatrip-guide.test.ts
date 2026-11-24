import assert from "node:assert/strict";
import { test } from "node:test";
import { searchEastChinaTripGuide } from "../lib/server/eastchinatrip-guide";
import type { BrowserSearchPort } from "../lib/server/openclaw-browser";

const directory = "https://www.eastchinatrip.com/zh-hant/china-city-guides/";
const url = directory + "xiamen-travel-guide/";
const index = {url: directory, blocked: false, links: [
  {label: "廈門", url}, {label: "廈門大學", url: directory + "other-travel-guide/"},
]};
const page = {url, city: "廈門", blocked: false, rows: [
  "第一天：植物園→中山公園→中山路", "第二天：鼓浪嶼→八市→小學路", "出發前請預約門票和酒店。",
]};
function browser(documents: unknown[]) {
  const calls: string[][] = [];
  const port: BrowserSearchPort = async args => {
    calls.push(args);
    if (args[0] === "open") return {targetId: "new-guide"};
    if (args[0] === "evaluate") return {result: documents.shift()};
    return {ok: true};
  };
  return {port,calls};
}

test("目录匹配简繁地名，只把实际城市文章的游览顺序作为来源", async () => {
  const f = browser([index,page]);
  const result = await searchEastChinaTripGuide({query:"厦门市 鼓浪嶼",wholeDestination:true}, f.port);
  assert.equal(result.sources.length,1);
  assert.equal(result.sources[0].url,url);
  assert.equal(result.sources[0].kind,"travel_guide");
  assert.match(result.sources[0].snippet,/植物園→中山公園/u);
  assert.match(result.sources[0].snippet,/第一天.*第二天/u);
  assert.doesNotMatch(result.sources[0].snippet,/酒店/u);
  assert.deepEqual(f.calls.filter(a=>a[0]==="navigate").map(a=>a[1]),[directory,url]);
  assert.deepEqual(f.calls.at(-1),["close","new-guide"]);
});
test("局部攻略仅返回含指定景点的那一段，无命中不补城市路线", async () => {
  const local = await searchEastChinaTripGuide({query:"廈門 中山公园"},browser([index,page]).port);
  assert.match(local.sources[0]?.snippet ?? "",/中山公園/u);
  assert.doesNotMatch(local.sources[0].snippet,/鼓浪嶼/u);
  assert.deepEqual((await searchEastChinaTripGuide({query:"廈門 南普陀寺"},browser([index,page]).port)).sources,[]);
  assert.deepEqual((await searchEastChinaTripGuide({query:"廈門",wholeDestination:false},browser([index,page]).port)).sources,[]);
});
test("站点身份、目录歧义、错页、验证页和泛泛的交通介绍不能充当资料", async () => {
  for (const dir of [
    {...index, url: "https://example.org/"},
    {...index, links: [{label:"廈門大學",url}]},
    {...index, links: [{label:"廈門",url:"https://example.org/xiamen-travel-guide/"}]},
    {...index, links: [...index.links,{label:"廈門市",url:directory+"another-travel-guide/"}]},
    {...index, blocked:true},
  ]) {
    const f = browser([dir,page]);
    assert.deepEqual((await searchEastChinaTripGuide({query:"廈門",wholeDestination:true}, f.port)).sources,[]);
    assert.equal(f.calls.some(a=>a[0]==="navigate" && a[1]!==directory),false);
  }
  for (const doc of [{...page,city:"福州"},{...page,url:directory+"fuzhou-travel-guide/"},{...page,blocked:true},
    {...page,rows:["可以搭乘公車、計程車、網約車及其他交通工具。"]}]) {
    assert.deepEqual((await searchEastChinaTripGuide({query:"廈門",wholeDestination:true},browser([index,doc]).port)).sources,[]);
  }
});
test("取消应立即结束，不访问文章、不操作其他标签", async () => {
  const ac = new AbortController(), f = browser([index,page]);
  const port: BrowserSearchPort = async (args,signal) => {
    const result = await f.port(args,signal);
    if (args[0]==="navigate") { ac.abort(); return new Promise(()=>{}); }
    return result;
  };
  await assert.rejects(searchEastChinaTripGuide({query:"廈門 鼓浪嶼",signal:ac.signal},port),{name:"AbortError"});
  assert.deepEqual(f.calls.at(-1),["close","new-guide"]);
  assert.equal(f.calls.some(a=>a[0]==="evaluate"),false);
});

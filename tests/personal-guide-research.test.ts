import { test } from "node:test";
import assert from "node:assert/strict";
import { researchPersonalGuide } from "../lib/server/personal-guide-research";
import type { TravelResearch } from "../lib/travel-research";

const place = { query: "泉州", wholeDestination: true };
const source = (path: string, snippet: string) => ({ url: "https://www.gov.cn/" + path, title: "泉州攻略", source: "www.gov.cn", snippet });
const route = source("walk", "从泉州开元寺出发，沿西街步行到钟楼。");
const transit = source("bus", "从泉州站乘坐K1路公交，在钟楼站下车。");
const guide = source("wharf", "泉州古渡位于晋江北岸，渡口入口在水门巷。");
const result = (...sources: TravelResearch["sources"]): TravelResearch => ({status:"success", sources, retrievedAt:null, notice:"", provider:"browser"});
const noGuide = async () => ({sources:[]});

test("资料齐备即结束，同一批中已达标可取消尚未返回的补充来源", async () => {
  const calls: unknown[] = [];
  let stopped = false;
  const report = await researchPersonalGuide(place, {
    browser: async params => {calls.push(params.followUp);return result(route, transit, guide);},
    wiki: async ({signal}) => new Promise(resolve => signal!.addEventListener("abort", () => {stopped=true;resolve({sources:[]});}, {once:true})),
  });
  assert.equal(report.status,"success"); assert.equal(report.sources.length,3); assert.deepEqual(calls,[undefined]); assert.ok(stopped);
});

test("重复页面及重复摘录只计一次，缺交通就定向补搜一次", async () => {
  const calls: unknown[] = [];
  const report = await researchPersonalGuide(place, {
    browser: async p => {calls.push(p.followUp);return p.followUp ? result(transit) : result(route, {...route, url:route.url+"#top"}, {...route,url:route.url+"-reprint"});},
    wiki: async () => ({sources:[guide]}),
  });
  assert.deepEqual(calls,[undefined,"transit"]); assert.equal(report.status,"success"); assert.equal(report.sources.length,3);
});

test("只有资料数量达标时，最多两轮并指出缺少的可执行路线", async () => {
  const calls: unknown[] = [];
  const report = await researchPersonalGuide(place, {
    browser: async p => {calls.push(p.followUp);return result(transit, guide, source("station","泉州站设有公交和出租车上客区。"));}, wiki:noGuide,
  });
  assert.deepEqual(calls,[undefined,"route"]); assert.equal(report.status,"partial"); assert.match(report.notice,/2 轮/u); assert.match(report.notice,/游览顺序/u);
});

test("时限硬截止，保存已经返回的材料；取消不启动补搜", async () => {
  const keepAlive=setTimeout(()=>undefined,500);
  try {
    const report = await researchPersonalGuide(place, {timeoutMs:25, browser:async()=>new Promise(()=>{}), wiki:async()=>({sources:[guide]})});
    assert.equal(report.status,"partial"); assert.deepEqual(report.sources,[guide]); assert.match(report.notice,/时间上限/u);
    const controller=new AbortController();
    const pending = researchPersonalGuide({...place,signal:controller.signal},{browser:async()=>new Promise(()=>{}),wiki:noGuide});
    controller.abort(); await assert.rejects(pending, {name:"AbortError"});
  } finally {clearTimeout(keepAlive);}
});

test("安全验证停止主动补查，保留具体原因和独立取得的来源", async () => {
  let calls=0;
  const report = await researchPersonalGuide(place,{browser:async()=>{calls++;return {...result(),status:"error",notice:"必应需要安全验证。请在已保留的标签页完成验证。"};},wiki:async()=>({sources:[guide]})});
  assert.equal(calls,1); assert.equal(report.status,"partial"); assert.deepEqual(report.sources,[guide]); assert.match(report.notice,/安全验证/u);
});

test("年份范围和只有栏目名称的摘要不能冒充游览顺序或具体页面", async () => {
  const vague = source("list","2025—2026 年泉州旅游攻略，相关栏目含交通、景点入口、地址信息。");
  const report = await researchPersonalGuide(place, {browser:async()=>result(vague,transit,guide),wiki:noGuide});
  assert.equal(report.status,"partial"); assert.match(report.notice,/还差 1 个/u); assert.match(report.notice,/缺少具体游览顺序/u);
});

test("有地址的具名车站能作为到达依据，但车站列表不能算游览路线", async () => {
  const station = source("rail","泉州站，地址 泉州市丰泽区北峰街道普贤路928号。");
  const report = await researchPersonalGuide(place, {browser:async()=>result(station,route,guide),wiki:noGuide});
  assert.equal(report.status,"success");
});

test("指定路段的点位缺口会触发一次补搜；返回的资料仍按原查询保存", async () => {
  const queries: string[] = [];
  const report = await researchPersonalGuide({query:"泉州 西街 梧林传统村落",wholeDestination:false}, {
    browser:async p=>{queries.push(p.place);return p.followUp ? result(source("village","梧林传统村落入口位于晋江新塘街道。")) : result(route,transit,guide);},
    wiki:noGuide,
  });
  assert.deepEqual(queries,["泉州 西街 梧林传统村落","泉州 梧林传统村落"]); assert.equal(report.status,"success"); assert.equal(report.query,"泉州 西街 梧林传统村落");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyBrief } from "../lib/schema";
import { buildRewritePrompt } from "../lib/rewrite-prompt";
import { buildPartialRewritePrompt } from "../lib/partial-rewrite-prompt";
import { partialRewriteRequestSchema } from "../lib/partial-rewrite-schema";
import { rewriteRequestSchema } from "../lib/rewrite-schema";
import { createDemoResult } from "../lib/demo";
import { researchForPrompt } from "../lib/research-prompt";
import { isSafeTravelSourceUrl, travelResearchSchema, travelSourcesMayConflict, type TravelResearch } from "../lib/travel-research";
import { partialFingerprint } from "../lib/partial-client";
import { applyRewriteIfCurrent } from "../lib/rewrite-request";
import { newDraft } from "../lib/drafts";

const research: TravelResearch = {status:"success",retrievedAt:"2026-10-30T00:00:00.000Z",notice:"已检索",sources:[{title:"官方景区信息",source:"政府网站",url:"https://www.gov.cn/test",snippet:"公开景区信息"}]};
const id=randomUUID(), brief={...emptyBrief,topic:"旅行",creationTypes:["travel"] as "travel"[],primaryType:"travel" as const};

test("旧请求可以无资料；重写传入已验证资料，仅摘要进入提示词，绝不自动搜索",()=>{
 const input={mode:"live",brief,imageIds:[id],body:"已有正文",direction:"natural",instruction:""};
 assert.equal(rewriteRequestSchema.safeParse(input).success,true);
 assert.equal(rewriteRequestSchema.safeParse({...input,research}).success,true);
 assert.equal(rewriteRequestSchema.safeParse({...input,research:{...research,sources:[{...research.sources[0],url:"http://127.0.0.1"}]}}).success,false);
 const prompt=buildRewritePrompt(brief,input.body,"natural","",research);
 assert.match(prompt,/公开景区信息/);assert.doesNotMatch(prompt,/https:\/\/www.gov.cn\/test/);assert.match(prompt,/未经信任/);
 assert.match(JSON.stringify(researchForPrompt()),/没有保存检索资料/);
 const partial=partialRewriteRequestSchema.parse({...input,target:"titles_all",current:createDemoResult([id]),research});
 assert.match(buildPartialRewritePrompt(partial),/公开景区信息/);assert.doesNotMatch(buildPartialRewritePrompt(partial),/https:\/\/www.gov.cn\/test/);
});

test("来源冲突时不把标题和摘要传给模型",()=>{
 const conflict={...research,potentialConflict:true};const value=JSON.stringify(researchForPrompt(conflict));
 assert.match(value,/资料可能冲突/);assert.doesNotMatch(value,/公开景区信息|官方景区信息|gov\.cn/);
});

test("小红书参考用独立的链接约束与资料身份，公共资料冲突不会遮掉路线经验", () => {
 const url = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
 const note = { kind: "xiaohongshu" as const, title: "先逛喜洲再去双廊", source: "小红书",
   url, snippet: "步行从四方街到院子。票价100元。更多 xiaohongshu.com/explore/0123456789abcdef01234567" };
 const combined = { ...research, sources: [
   {...research.sources[0], snippet:"官方测试摘要，票价200元"}, note,
 ] };
 assert.equal(travelResearchSchema.safeParse(combined).success, true);
 assert.equal(isSafeTravelSourceUrl(url), false);
 for (const invalidUrl of [url + "?xsec_token=secret", url.replace("www.xiaohongshu.com", "www.xiaohongshu.com.example.test"), url.replace("/explore/", "/user/profile/")]) {
   assert.equal(travelResearchSchema.safeParse({...combined, sources:[{...note, url:invalidUrl}]}).success, false);
 }
 assert.equal(travelResearchSchema.safeParse({...combined, sources:[{...note, kind:undefined}]}).success, false);
 assert.equal(travelSourcesMayConflict(combined.sources), false);

 const prompt = JSON.stringify(researchForPrompt(combined));
 assert.match(prompt, /小红书游览经验/);
 assert.match(prompt, /不把作者经历写成用户亲历/);
 assert.match(prompt, /票价、开放时间、预约和班次须按同期官方资料核实/);
 assert.match(prompt, /官方测试摘要/);
 assert.doesNotMatch(prompt, /xiaohongshu\.com|0123456789abcdef01234567/u);
 const conflictPrompt = JSON.stringify(researchForPrompt({...combined, potentialConflict:true}));
 assert.match(conflictPrompt, /步行从四方街到院子/);
 assert.match(conflictPrompt, /资料中的价时信息可能冲突/);
 assert.doesNotMatch(conflictPrompt, /官方测试摘要|xiaohongshu\.com/u);
});

test("公开攻略只接受指定站点的文章地址，路线经验不参与票价冲突判断", () => {
  const guide = {
    kind: "travel_guide" as const, title: "泉州古城步行攻略", source: "维基导游",
    url: "https://zh.wikivoyage.org/wiki/泉州", snippet: "从开元寺沿西街步行到钟楼。门票100元。",
  };
  const withUrl = (url: string) => travelResearchSchema.safeParse({ ...research, sources: [{ ...guide, url }] }).success;
  for (const url of [
    "https://baijiahao.baidu.com/s?id=1820111100000000000", "https://post.smzdm.com/p/apq2mwl7/",
    guide.url, "https://zh.wikivoyage.org/zh-hans/%E6%B3%89%E5%B7%9E",
    "https://you.ctrip.com/sight/quanzhou243/14445.html", "https://you.ctrip.com/travels/quanzhou243/4099120.html",
    "https://zhuanlan.zhihu.com/p/717883054", "https://www.sohu.com/a/865460951_529342",
    "https://www.eastchinatrip.com/zh-hant/china-city-guides/quanzhou-travel-guide/",
  ]) {
    assert.equal(withUrl(url), true, url);
    assert.equal(isSafeTravelSourceUrl(url), false);
  }
  for (const url of [
    "https://baijiahao.baidu.com/s?id=1820111100000000000&token=bad", "https://baijiahao.baidu.com/s?id=abc",
    "https://post.smzdm.com/p/login", "http://zh.wikivoyage.org/wiki/泉州", "https://user@zh.wikivoyage.org/wiki/泉州",
    "https://zh.wikivoyage.org:8080/wiki/泉州", "https://zh.wikivoyage.org.example.com/wiki/泉州",
    "https://zh.wikivoyage.org/wiki/Special%3ASearch", "https://zh.wikivoyage.org/w/index.php?title=泉州",
    "https://zh.wikivoyage.org/wiki/泉州?action=edit", "https://you.ctrip.com/travels/quanzhou243/",
    "https://you.ctrip.com/sight/quanzhou243/14445.html?redirect=x", "https://you.ctrip.com/account/login",
    "https://zhuanlan.zhihu.com/p/preview", "https://www.sohu.com/a/account",
    "https://www.eastchinatrip.com/zh-hant/china-city-guides/", "https://www.eastchinatrip.com/checkout/quanzhou-travel-guide/",
    research.sources[0].url,
  ]) assert.equal(withUrl(url), false, url);
  assert.equal(travelResearchSchema.safeParse({ ...research, sources: [{ ...guide, kind: undefined }] }).success, false);
  const official = { ...research.sources[0], snippet: "门票120元。" };
  assert.equal(travelSourcesMayConflict([guide, official]), false);
  const prompt = JSON.stringify(researchForPrompt({ ...research, sources: [official, guide], potentialConflict: true }));
  assert.match(prompt, /从开元寺沿西街步行到钟楼/);
  assert.match(prompt, /票价、开放时间、预约和班次须按同期官方资料核实/);
  assert.doesNotMatch(prompt, /门票120元|zh\.wikivoyage\.org/);
  for (const guideScope of ["destination", "segment"]) {
    assert.equal(travelResearchSchema.parse({ ...research, guideScope }).guideScope, guideScope);
  }
  assert.equal(travelResearchSchema.parse(research).guideScope, undefined);
});

test("重写期间参考资料变化，旧正文和局部结果不得覆盖",()=>{
 const base=newDraft(), id=randomUUID(),when=new Date().toISOString();
 const d={...base, generation:{mode:"live" as const,result:createDemoResult([id]),imageIds:[id],meta:{durationMs:0,completedAt:when},research}};
 const before=partialFingerprint(d);const changed={...d,generation:{...d.generation,research:{...research,status:"error" as const}}};
 assert.notEqual(partialFingerprint(changed),before);
 assert.equal(applyRewriteIfCurrent(changed,d.id,d.generation.result.body,when,"新的正文",research),changed);
 assert.notEqual(applyRewriteIfCurrent(d,d.id,d.generation.result.body,when,"新的正文",research),d);
});

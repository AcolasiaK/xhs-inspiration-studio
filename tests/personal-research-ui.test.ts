import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement, ReactNode } from "react";
import { ResearchInfo } from "../components/personal/research-info";
import type { TravelResearch } from "../lib/travel-research";

type Element = ReactElement<Record<string, unknown>>;
function isElement(node: unknown): node is Element {
  return Boolean(node && typeof node === "object" && "props" in node && "type" in node);
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isElement(node)) return [];
  return [node, ...elements(node.props.children)];
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isElement(node) ? text(node.props.children) : "";
}
function children(element: Element): Element[] {
  const children = element.props.children;
  return (Array.isArray(children) ? children.flat() : [children]).filter(isElement);
}
const fixture: TravelResearch = {
  status: "success", notice: "完整来源说明；资料只能作背景，时间和票价仍需核实。", provider: "chatgpt",
  query: "测试景区开放信息", retrievedAt: "2026-11-01T02:00:00.000Z", summaryKind: "search_summary",
  sources: [
    { title: "公开景区公告", source: "example.gov.cn", url: "https://example.gov.cn/open", snippet: "合成摘要第一行\n第二行", publishedAt: "2026-10-30T00:00:00.000Z" },
    { title: "出行参考", source: "12306.cn", url: "https://12306.cn/test", snippet: "合成出行摘要" },
  ],
};

test("个人参考来源默认折叠且成功主视图只保留紧凑入口，完整元数据与摘要仍可查看", () => {
  const before = structuredClone(fixture);
  const root = ResearchInfo({ research: fixture, title: "提示词的参考来源" }) as Element;
  assert.equal(root.type, "aside");
  const direct = children(root);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].type, "details");
  assert.equal(direct[0].props.open, undefined);
  const summary = children(direct[0]).find(item => item.type === "summary")!;
  assert.match(text(summary), /参考来源（2 条）/u);
  assert.doesNotMatch(text(summary), /完整来源说明|第一行/u);
  const rendered = text(root);
  for (const item of [fixture.notice, fixture.query!, "本机 ChatGPT 订阅搜索", "北京时间", "公开景区公告", fixture.sources[0].url, "来源未提供可核实的发布时间", "合成摘要第一行"]) assert.ok(rendered.includes(item));
  const disclosures = elements(root).filter(item => item.type === "details");
  assert.equal(disclosures.length, 3);
  assert.ok(disclosures.every(item => item.props.open === undefined));
  assert.match(text(disclosures[1]), /查看检索整理摘要/u);
  const links = elements(root).filter(item => item.type === "a");
  assert.equal(links.length, 2);
  assert.ok(links.every(link => link.props.target === "_blank" && link.props.rel === "noopener noreferrer"));
  assert.deepEqual(fixture, before);
});

test("不完整、冲突或失败原因始终在折叠外，空结果不伪装检索成功", () => {
  for (const status of ["partial", "no_results", "not_configured", "error", "missing_place"] as const) {
    const notice = `合成原因：${status}`;
    const root = ResearchInfo({ research: { ...fixture, status, notice, sources: status === "partial" ? fixture.sources : [] }, title: "这篇笔记的参考来源" }) as Element;
    const direct = children(root);
    assert.equal(direct[0].type, "p");
    assert.equal(direct[0].props.role, "status");
    assert.ok(text(direct[0]).includes(notice));
    assert.doesNotMatch(text(root), /参考来源（0 条）|已检索/u);
  }
  const conflict = ResearchInfo({ research: { ...fixture, potentialConflict: true }, title: "有冲突的资料" }) as Element;
  assert.match(text(children(conflict)[0]), /来源之间可能存在冲突/u);
  const empty = ResearchInfo({ research: { ...fixture, sources: [] }, title: "空来源" }) as Element;
  assert.match(text(children(empty)[0]), /没有可展示的可靠来源/u);
  assert.doesNotMatch(text(empty), /已检索/u);
});

test("关闭联网不生成空列表，坏时间不崩溃，不安全链接不进入展示", () => {
  const disabled = ResearchInfo({ research: { ...fixture, status: "disabled", sources: [], retrievedAt: null }, title: "未联网的提示词" });
  assert.match(text(disabled), /本次未联网检索/u);
  assert.equal(elements(disabled).filter(item => item.type === "details" || item.type === "ul").length, 0);
  const invalid = ResearchInfo({ research: { ...fixture, retrievedAt: "bad date", sources: [{ ...fixture.sources[0], publishedAt: "bad date" }, { ...fixture.sources[1], url: "javascript:alert(1)" }] }, title: "旧记录" });
  assert.match(text(invalid), /检索时间无法读取/u);
  assert.match(text(invalid), /来源发布时间无法读取/u);
  assert.match(text(invalid), /有 1 条链接不符合来源安全规则/u);
  assert.doesNotMatch(text(invalid), /javascript:alert/u);
  assert.equal(elements(invalid).filter(item => item.type === "a").length, 1);
});

test("提示词与正文参考区域使用不同上下文名称，查询词不依赖 provider 才显示", () => {
  const roots = ["提示词的参考来源（不包含在正文中）", "这篇笔记的参考来源（不包含在正文中）"].map(title => ResearchInfo({ research: { ...fixture, provider: undefined }, title }) as Element);
  assert.notEqual(roots[0].props["aria-label"], roots[1].props["aria-label"]);
  const labels = roots.map(root => elements(root).find(item => item.type === "summary")?.props["aria-label"]);
  assert.notEqual(labels[0], labels[1]);
  assert.ok(roots.every(root => text(root as ReactNode).includes(fixture.query!)));
});


test("确认区的紧凑来源入口始终折叠，未联网或旧记录仍可查看状态",()=>{
 for(const research of [null,{...fixture,status:'disabled' as const,sources:[]}]){
  const root=ResearchInfo({research,title:'提示词来源',compact:true});const ds=elements(root).filter(e=>e.type==='details');assert.equal(ds.length,1);assert.equal(ds[0].props.open,undefined);assert.match(text(root),/参考来源（0 条）/);
 }
 const root=ResearchInfo({research:fixture,title:'提示词来源',compact:true});assert.match(text(root),/参考来源（2 条）/);assert.ok(elements(root).filter(e=>e.type==='details').every(e=>e.props.open===undefined));assert.match(text(root),/公开景区公告/);
});
test("紧凑来源模式不隐藏搜索失败原因或清除安全检查",()=>{
 const root=ResearchInfo({research:{...fixture,status:'error',sources:[],notice:'检索超时，仍可继续创作。'},title:'提示词来源',compact:true}) as Element;
 const direct=children(root);assert.equal(direct[0].props.role,'status');assert.match(text(direct[0]),/检索超时/);assert.match(text(direct[1]),/参考来源（0 条）/);assert.equal(direct[1].props.open,undefined);
});

test("新浏览器来源与旧提供方显示准确且保留链接", () => {
 for (const [provider,label] of [["browser","本机浏览器搜索"],["bocha","博查搜索"],["chatgpt","本机 ChatGPT 订阅搜索"]] as const) {
  const root=ResearchInfo({research:{...fixture,provider},title:"参考来源"});
  assert.ok(text(root).includes(label));
  assert.equal(elements(root).find(e=>e.type==="a")?.props.href,fixture.sources[0].url);
 }
});

test("小红书笔记与公共资料分别标识，不展示带访问标记的笔记地址", () => {
  const url = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
  const note = { kind: "xiaohongshu" as const, url, title: "测试游览路线", source: "小红书", snippet: "合成路线", likes: 500, collects: 600 };
  const root = ResearchInfo({ research: {
    ...fixture, provider: "browser", sources: [note, fixture.sources[0], { ...note, url: url + "?xsec_token=synthetic" }],
  }, title: "攻略来源" });
  assert.match(text(root), /小红书 · 游览经验 · 点赞 500 · 收藏 600/u);
  assert.match(text(root), /example\.gov\.cn · 公共资料/u);
  assert.match(text(root), /查看笔记摘录/u);
  const links = elements(root).filter(element => element.type === "a");
  assert.deepEqual(links.map(link => link.props.href), [url, fixture.sources[0].url]);
  assert.doesNotMatch(text(root), /xsec_token/u);
});

test("公开旅行指南在个人参考资料中展示为路线经验", () => {
  const guide = {
    kind: "travel_guide" as const, url: "https://zh.wikivoyage.org/wiki/泉州", title: "泉州古城",
    source: "维基导游", snippet: "从开元寺沿西街步行到钟楼。",
  };
  const root = ResearchInfo({ research: { ...fixture, sources: [guide, fixture.sources[0]] }, title: "攻略来源" });
  assert.match(text(root), /维基导游 · 非官方游览经验/);
  assert.match(text(root), /example\.gov\.cn · 公共资料/);
  assert.match(text(root), /查看攻略摘要/);
  const links = elements(root).filter(element => element.type === "a");
  assert.deepEqual(links.map(link => link.props.href), [guide.url, fixture.sources[0].url]);
});

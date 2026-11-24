import "server-only";
import { z } from "zod";
import { isCloudMode } from "../cloud/mode";
import { personalGuidePlaces } from "../personal/search-query";
import { withPublicGuideTab, type PublicGuideResult } from "./public-guide-tab";
import { runOpenClawBrowser, type BrowserSearchPort } from "./openclaw-browser";

export const wikivoyageTransport: { run: BrowserSearchPort } = { run: runOpenClawBrowser };
const origin = "https://zh.wikivoyage.org";
const pageSchema = z.object({
  url: z.string().max(2048), title: z.string().max(180), unavailable: z.boolean(),
  rows: z.array(z.object({section: z.string().max(80), text: z.string().max(450)})).max(350),
});

// Keep section boundaries: the contents menu and location names in navigation are not article evidence.
const readGuidePage = String.raw`() => {
  const root = document.querySelector('#mw-content-text .mw-parser-output');
  const title = document.querySelector('#firstHeading')?.innerText.trim() || document.title.split(/\s+[-–—]\s+/)[0].trim();
  const disambiguation = [...document.querySelectorAll('#catlinks a')].some(a => /^消歧[义義](?:的?[页頁]面?)?$/.test(a.textContent.trim()));
  const unavailable = !root || disambiguation || !!document.querySelector('.noarticletext,#disambigbox,[property="mw:PageProp/disambiguation"]');
  const rows = [];
  let section = '', subsection = '';
  for (const el of root?.querySelectorAll('h2,h3,h4,p,li') || []) {
    if (el.closest('table,nav,.toc,.noprint,.gallery,.mw-indicators')) continue;
    if (el.tagName === 'H2') { section = el.innerText.replace(/\[.*?\]/g,'').trim(); subsection = ''; continue; }
    if (el.tagName === 'H3' || el.tagName === 'H4') { subsection = el.innerText.replace(/\[.*?\]/g,'').trim(); continue; }
    if (!/抵达|到达|交通|出行|游览|遊覽|观光|观赏|景点|游线|行程|路线|活动/.test(section)) continue;
    if (el.querySelector('li,p')) continue;
    const text = el.innerText.replace(/\s+/g,' ').trim().slice(0,450);
    if (text) rows.push({section:[section,subsection].filter(Boolean).join(' / ').slice(0,80),text});
    if (rows.length === 350) break;
  }
  return {url:location.href,title,unavailable,rows};
}`;

function placeName(name: string) {
  return name.trim().replace(/^(.{2,})市$/u,"$1");
}

function guideExcerpt(rows: z.infer<typeof pageSchema>["rows"], focus: string[], whole: boolean) {
  const candidates = [];
  for (const row of rows) {
    if (!/到达|抵达|交通|出行|游览|遊覽|观光|观赏|景点|游线|行程|路线|活动/u.test(row.section)) continue;
    const text = row.text.replace(/\uFFFC|\[编辑\]/gu,"").replace(/^\s*\d+\s+/u,"")
      .split(/📞|💰|🕘|(?:电话|票价|门票价格|开放时间)[：:]|[（(]更新日期/u,1)[0].trim();
    if (text.length < 8 || !/地址|位于|[东西南北]岸|[东西南北]门|(?:乘坐|换乘|下车|途经|可从|步行|骑行|自驾|出入口)|[路街]\d+号|[\u3400-\u9fff]{2,}(?:机场|火车站|高铁站|汽车站|客运站|码头|高速公路)|\d+路公交/u.test(text)) continue;
    const match = focus.some(word => text.includes(word));
    if (!whole && focus.length && !match) continue;
    candidates.push({text, score: (match ? 4 : 0) + (/乘坐|换乘|下车|途经|可从|步行|骑行/.test(text) ? 1 : 0)});
  }
  candidates.sort((a,b)=>b.score-a.score);
  return [...new Set(candidates.map(c=>c.text))].slice(0,4).map(s=>s.slice(0,138)).join(" ｜ ");
}

export async function searchWikivoyageGuide(
  input: {query: string; wholeDestination?: boolean; signal?: AbortSignal},
  port: BrowserSearchPort = wikivoyageTransport.run,
): Promise<PublicGuideResult> {
  input.signal?.throwIfAborted();
  const [first, ...terms] = personalGuidePlaces(input.query);
  if (isCloudMode() || !first) return {sources: []};
  const destination = placeName(first);
  if (!/^[\p{L}\p{M}\d·-]{2,40}$/u.test(destination)) return {sources: []};
  const url = new URL("/zh-hans/" + encodeURIComponent(destination), origin);
  const focus = terms.map(word => word.startsWith(destination) && word.length > destination.length + 1 ? word.slice(destination.length) : word)
    .filter(word => word !== destination && !/^(?:旅游|游玩|景点|步行|骑行|自驾|公交|地铁|接驳|交通|线路|路线|攻略)$/u.test(word));
  return withPublicGuideTab("维基导游", port, 35_000, input.signal, async tab => {
    const result = await tab.read(url.href, readGuidePage);
    const page = pageSchema.safeParse(result);
    if (!page.success || page.data.unavailable || new URL(page.data.url).href !== url.href || placeName(page.data.title) !== destination) return {sources:[]};
    const snippet = guideExcerpt(page.data.rows, focus, !!input.wholeDestination);
    if (!snippet) return {sources:[]};
    return {sources:[{kind:"travel_guide",source:"维基导游",title:page.data.title+"旅行指南",url:url.href,snippet}]};
  });
}

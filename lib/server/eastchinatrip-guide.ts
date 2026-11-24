import "server-only";
import { z } from "zod";
import { isCloudMode } from "../cloud/mode";
import { personalGuidePlaces } from "../personal/search-query";
import { isSafePublicTravelGuideUrl } from "../travel-research";
import { guideKey } from "./browser-search";
import { runOpenClawBrowser, type BrowserSearchPort } from "./openclaw-browser";
import { withPublicGuideTab, type PublicGuideResult } from "./public-guide-tab";

export const eastChinaTripTransport: {run: BrowserSearchPort} = {run: runOpenClawBrowser};
const directory = "https://www.eastchinatrip.com/zh-hant/china-city-guides/";
const locationFields = {url: z.string().max(2048), blocked: z.boolean()};
const indexSchema = z.object({...locationFields, links: z.array(z.object({
  label: z.string().max(100), url: z.string().max(2048),
})).max(500)});
const articleSchema = z.object({...locationFields, city: z.string().max(100), rows: z.array(z.string().max(500)).max(100)});

const challenge = String.raw`!!document.querySelector('#challenge-form,#challenge-running,.cf-turnstile') ||
  /just a moment|verify you are human|安全验证|安全驗證/i.test(document.title)`;
const readDirectory = String.raw`() => {
  const blocked = ${challenge};
  const links = [];
  if (!blocked) for (const a of document.querySelectorAll('ul.elementor-icon-list-items li a[href]')) {
    if (a.closest('header,nav,aside,footer,[role="navigation"]')) continue;
    if (!a.href.startsWith('https://www.eastchinatrip.com/zh-hant/china-city-guides/')) continue;
    const label = a.innerText.trim();
    if (label && label.length <= 100 && a.href.length <= 2048) links.push({url:a.href, label});
    if (links.length === 500) break;
  }
  return {url:location.href,blocked,links};
}`;
const readArticle = String.raw`() => {
  const blocked = ${challenge};
  const root = document.querySelector('.st-blog');
  const headings = [...(root?.querySelectorAll('h1,h2') || [])];
  const city = headings.map(el => el.innerText.trim().match(/^(.+?)(?:旅遊|旅游|旅行)攻略$/u)?.[1]).find(Boolean) || '';
  const rows = [];
  let relevant = false;
  if (root && !blocked) for (const el of root.querySelectorAll('.elementor-widget-container h2,.elementor-widget-container h3,.elementor-widget-container p,.elementor-widget-container li')) {
    if (el.closest('aside,header,footer,nav,[role="navigation"],.elementor-toc')) continue;
    const text = el.innerText.replace(/\s+/g, ' ').trim();
    if (/^H[23]$/.test(el.tagName)) { relevant = /推薦行程|推荐行程|遊覽路線|游览路线|交通|如何前往/.test(text); continue; }
    if (!relevant || text.length < 8 || text.length > 500 || el.querySelector('p,li')) continue;
    rows.push(text);
    if (rows.length === 100) break;
  }
  return {url:location.href,blocked,city,rows};
}`;

const placeKey = (value: string) => guideKey(value).trim().replace(/^(.{2,})市$/u,"$1");
const landmarkKey = (value: string) => guideKey(value).replace(/传统村落/gu,"村落");
const route = /[\p{L}\d）)]\s*(?:→|➡|➜|->|—{1,2}|-{2})\s*[（(\p{L}\d]|(?:先遊|先游|先到|先去)[^。！？]{2,40}(?:再到|再去|再遊|再游)/u;
const transit = /(?:[A-Z]?\d{1,4})(?:路|[号號][线線])[^。！？]{0,30}(?:站|[车車])|(?:乘坐|搭乘|[转轉]乘|[换換]乘)[^。！？]{0,14}(?:公交|公[车車]|地[铁鐵]|巴士)[^。！？]{0,18}(?:到|至|下[车車])/u;

export async function searchEastChinaTripGuide(
  input: {query: string; wholeDestination?: boolean; signal?: AbortSignal},
  port: BrowserSearchPort = eastChinaTripTransport.run,
): Promise<PublicGuideResult> {
  input.signal?.throwIfAborted();
  const [first,...terms] = personalGuidePlaces(input.query);
  if (isCloudMode() || !first || !/^[\p{L}·-]{2,40}$/u.test(first)) return {sources:[]};
  const city = placeKey(first);
  const focus = terms.map(term => {
    const key = landmarkKey(term);
    return key.startsWith(city) && key.length > city.length + 1 ? key.slice(city.length) : key;
  }).filter(term => term !== city && !/^(?:旅游|游玩|景点|步行|骑行|自驾|公交|地铁|交通|线路|路线|攻略)$/u.test(term));
  if (!input.wholeDestination && !focus.length) return {sources:[]};
  return withPublicGuideTab("EastChinaTrip", port, 42_000, input.signal, async tab => {
    const index = indexSchema.safeParse(await tab.read(directory, readDirectory));
    if (!index.success || index.data.url !== directory) return {sources:[]};
    if (index.data.blocked) return {sources:[],notice:"EastChinaTrip 城市目录需要安全验证，已停止读取。"};
    const links = new Set(index.data.links.filter(link => placeKey(link.label) === city &&
      link.url.startsWith(directory) && isSafePublicTravelGuideUrl(link.url)).map(link => link.url));
    if (links.size !== 1) return {sources:[]};
    const [url] = links;
    const page = articleSchema.safeParse(await tab.read(url, readArticle));
    if (!page.success || page.data.url !== url) return {sources:[]};
    if (page.data.blocked) return {sources:[],notice:"EastChinaTrip 攻略页面需要安全验证，已停止读取。"};
    if (placeKey(page.data.city) !== city) return {sources:[]};
    const rows = [...new Set(page.data.rows)].filter(text => route.test(text) || transit.test(text));
    const matched = rows.filter(text => focus.some(term => landmarkKey(text).includes(term)));
    const selected = input.wholeDestination ? [...new Set([...matched,...rows])] : matched;
    if (!selected.length) return {sources:[]};
    const excerpts = new Set(selected.slice(0,3));
    const snippet = rows.filter(text=>excerpts.has(text)).map(text=>text.slice(0,185)).join(" ｜ ");
    return {sources:[{kind:"travel_guide", source:"EastChinaTrip", title:page.data.city + "旅遊攻略", url, snippet}]};
  });
}

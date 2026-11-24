import "server-only";
import { z } from "zod";
import { isCloudMode } from "../cloud/mode";
import { personalGuidePlaces } from "../personal/search-query";
import type { TravelResearch } from "../travel-research";
import { parseXhsCount, parseXhsPublishedAt } from "../xhs-hotspot-ranking";
import { BrowserNavigationBlockedError, browserSearchTransport, type BrowserSearchPort } from "./browser-search";
import { cardsCode, detailCode, filterStateCode, guardCode, openFiltersCode, selectXhsFilterCode } from "./xhs-browser-dom";

export const xhsGuideSearchTransport: { run: BrowserSearchPort } = { run: browserSearchTransport.run };
const host = "www.xiaohongshu.com";
const sortLabel = "最多收藏";
const idSchema = z.string().regex(/^[a-f0-9]{24}$/u);
const cardsSchema = z.array(z.object({ id:idSchema, title:z.string(), likes:z.string(), own:z.boolean() }));
const detailSchema = z.object({
  id:idSchema, title:z.string(), body:z.string(), date:z.string(), likes:z.string().nullable(), collects:z.string().nullable(),
});
const routeClue = /第[一二三四五六七八九十\d]+天|[Dd](?:ay\s*)?[1-9]|[→➜➡]|出发|乘坐|打车|班车|接驳|步行|骑行|行程|线路|路线|入口|回程|建议住|停车场|公交站|导航到|导航至|涨潮|退潮/u;
const guideTitle = /攻略|怎么玩|避坑|日游|旅游|指南|交通/u;
const itineraryExcerpt = (body:string) => {
  const lines = body.split(/\n+|(?<=[。！？])/u).map(line=>line.trim()).filter(line=>line && !line.startsWith("#"));
  return lines.filter(line=>routeClue.test(line)).slice(0,8).map(line=>line.slice(0,140)).join("\n").slice(0,600);
};
const byCollections = (a:TravelResearch["sources"][number], b:TravelResearch["sources"][number]) =>
  (b.collects ?? 0)-(a.collects ?? 0) || (b.likes ?? 0)-(a.likes ?? 0);

type GuideNotes = {
  sources: TravelResearch["sources"];
  state: "found" | "none" | "login" | "blocked" | "unavailable";
  notice?: string;
};

/** Read a small sample of the visible search results. Separate from hotspot jobs and AI enrichment. */
export async function searchXhsGuide(
  input: {query:string; wholeDestination?:boolean; signal?:AbortSignal},
  port: BrowserSearchPort = xhsGuideSearchTransport.run,
): Promise<GuideNotes> {
  input.signal?.throwIfAborted();
  const [destination,...locations] = personalGuidePlaces(input.query);
  const sources: TravelResearch["sources"] = [];
  if (!destination || isCloudMode()) return {sources,state:"none"};
  const region = destination.replace(/(?:特别行政区|自治区|自治州|省|市|县|区)$/u,"") || destination;
  const keywords = input.wholeDestination ? [destination,"行程","路线","攻略"] : [destination,...locations,"攻略"];
  const keyword = keywords.join(" ");
  const url = new URL("https://"+host+"/search_result");
  url.searchParams.set("keyword",keyword);
  // Media can consume a full navigation timeout before the first card is usable.
  // Leave room for the sorted grid and several note bodies within the prompt deadline.
  const timeout = AbortSignal.timeout(70_000);
  const signal = input.signal ? AbortSignal.any([input.signal,timeout]) : timeout;
  let target:string|undefined;
  let leaveForLogin=false;
  const evaluate = async (code:string) => (await port(["evaluate","--target-id",target!,"--fn",code],signal)).result;
  const check = (state?:{host?:string;blocked?:boolean;login?:boolean}) => {
    if (state?.blocked || state?.login) leaveForLogin=true;
    return state?.host===host && !leaveForLogin;
  };
  try {
    await port(["start"],signal);
    signal.throwIfAborted();
    // Opening a blank tab first preserves its identity even if the search is cancelled.
    target = (await port(["open","about:blank"],AbortSignal.timeout(8_000))).targetId;
    if (!target) return {sources,state:"unavailable"};
    signal.throwIfAborted();
    await port(["navigate",url.href,"--target-id",target],signal);
    const list = await evaluate(`async () => {
      const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(let i=0;i<12;i++){
        if(document.querySelector('section.note-item,.login-modal') || location.pathname.includes('captcha'))break;
        await pause(250);
      }
      const guard=(${guardCode}), cardsOnPage=(${cardsCode});
      const query=new URL(location.href).searchParams.get("keyword");
      const stopped=state=>state.blocked||state.login||state.host!==${JSON.stringify(host)}||
        location.pathname!=="/search_result"||new URL(location.href).searchParams.get("keyword")!==${JSON.stringify(keyword)};
      let state=guard();
      if(stopped(state)||!(${openFiltersCode})())return {state,query};
      const firstCover=document.querySelector('section.note-item a.cover');
      const beforeIds=cardsOnPage().slice(0,24).map(card=>card.id).join(",");
      let selection="missing",sort;
      for(let i=0;i<12 && selection==="missing";i++){
        await pause(200); state=guard(); if(stopped(state))return {state,query};
        selection=(${selectXhsFilterCode("排序依据",sortLabel)})();
      }
      let refreshed=selection==="selected"||!beforeIds;
      for(let i=0;i<32;i++){
        state=guard(); if(stopped(state))return {state,query};
        sort=(${filterStateCode})()["排序依据"];
        const cards=cardsOnPage().slice(0,24);
        if(!cards.length||firstCover?.isConnected===false||cards.map(card=>card.id).join(",")!==beforeIds)refreshed=true;
        const empty=!cards.length && /没有找到(?:相关|匹配)|暂无相关(?:笔记|结果|内容)|没有相关(?:笔记|结果|内容)|无搜索结果/u.test(document.body.innerText);
        if(selection!=="missing" && sort===${JSON.stringify(sortLabel)} && refreshed && (cards.some(card=>card.title.trim())||empty)){
          document.querySelector('.filter')?.dispatchEvent(new MouseEvent('mouseleave',{bubbles:true}));
          return {state,sort,query,cards,empty};
        }
        await pause(250);
      }
      return {state,sort,query};
    }`) as {state?:{host?:string;blocked?:boolean;login?:boolean};sort?:string;query?:string;cards?:unknown;empty?:boolean}|undefined;
    if (!check(list?.state)) return {sources,state:leaveForLogin?"login":"unavailable"};
    if (list?.sort!==sortLabel || list.query!==keyword) return {sources,state:"unavailable",notice:"小红书未确认本次关键词或“最多收藏”排序，请重试。"};
    if (!Array.isArray(list.cards)) return {sources,state:"unavailable",notice:"小红书已打开，排序后的搜索结果未能在时限内加载完成。"};
    if (list.empty) return {sources,state:"none",notice:"小红书搜索页显示本次关键词没有相关笔记。"};
    const cards = cardsSchema.parse(list.cards);
    const focus = input.wholeDestination || !locations.length ? [region] : locations;
    const specificFirst = /(?:寺|庙|宫|古城|古镇|公园|景区|博物馆|海岸|步道|码头)$/u.test(destination);
    const places = specificFirst && !focus.includes(region) ? [region,...focus] : focus;
    const priority = (title:string) => 2*Number(places.some(place=>title.includes(place))) + Number(routeClue.test(title)||guideTitle.test(title));
    const candidates = cards.filter((card,index,all)=>!card.own && all.findIndex(other=>other.id===card.id)===index)
      .sort((a,b)=>priority(b.title)-priority(a.title)).slice(0,5);
    let read = 0;
    for (const card of candidates) {
      const entry = await evaluate(`async () => {
        const stateBefore=(${guardCode})();
        if(stateBefore.blocked || stateBefore.login || stateBefore.host!==${JSON.stringify(host)})return {state:stateBefore};
        if(location.pathname!=="/search_result"||new URL(location.href).searchParams.get("keyword")!==${JSON.stringify(keyword)})return {state:stateBefore,missing:true};
        const note=Array.from(document.querySelectorAll('section.note-item')).find(item=>item.querySelector('a[href*="/explore/${card.id}"]'));
        const cover=note?.querySelector('a.cover[href*="/search_result/"]');
        if(!cover)return {state:stateBefore,missing:true};
        cover.scrollIntoView({block:"center"});cover.click();
        const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        let detail;
        for(let i=0;i<24;i++){
          await pause(250);
          const guard=(${guardCode})(); if(guard.blocked||guard.login||guard.host!==${JSON.stringify(host)})return {state:guard};
          detail=(${detailCode})();
          if(detail?.id==="${card.id}" && detail.body?.trim() && /[0-9]/.test(detail.collects||""))break;
        }
        const state=(${guardCode})();
        if(state.blocked || state.login || state.host!==${JSON.stringify(host)})return {state};
        const close=document.querySelector('.note-detail-mask .close-circle');
        if(close){close.click();await pause(300);}
        const selected=detail?.id==="${card.id}" ? {
          id:detail.id,title:detail.title,body:detail.body.slice(0,5000),date:detail.date,likes:detail.likes,collects:detail.collects
        } : null;
        return {state,closed:!!close,detail:selected};
      }`) as {state?:{host?:string;blocked?:boolean;login?:boolean};detail?:unknown;closed?:boolean;missing?:boolean}|undefined;
      if (!check(entry?.state)) break;
      if (entry?.missing) continue;
      const parsed=detailSchema.safeParse(entry?.detail);
      if (parsed.success && parsed.data.id === card.id) {
        const detail=parsed.data;
        if(detail.body.trim()) read++;
        const likes = parseXhsCount(detail.likes) ?? parseXhsCount(card.likes);
        const collects = parseXhsCount(detail.collects);
        const excerpt = itineraryExcerpt(detail.body);
        const noteText = [card.title,detail.title,detail.body.replace(/#[^\s#]+/gu,"")].join(" ");
        const matchesScope = places.some(place=>noteText.includes(place));
        if (matchesScope && excerpt.length >= 28 && collects !== null && collects > 0) {
          const publishedAt = parseXhsPublishedAt(detail.date,new Date().toISOString());
          sources.push({kind:"xiaohongshu",title:(detail.title.trim() || card.title).slice(0,180),
            url:`https://${host}/explore/${card.id}`,source:"小红书",snippet:excerpt,collects,
            ...(likes===null ? {} : {likes}), ...(publishedAt ? {publishedAt} : {})});
        }
      }
      if (sources.length >= 3 || !entry?.closed) break;
    }
    if (leaveForLogin || sources.length) return {sources,state:leaveForLogin?"login":"found"};
    return {sources,state:read?"none":"unavailable",notice:read
      ? `小红书已读到 ${read} 篇笔记正文，未找到与本次地点相符且能核对收藏数的攻略段落。`
      : "小红书搜索页已有结果，但本次没有读到可核对的笔记正文。"};
  } catch (error) {
    input.signal?.throwIfAborted();
    if (!sources.length && error instanceof BrowserNavigationBlockedError) return {sources,state:"blocked",notice:error.message};
    return {sources,state:sources.length?"found":"unavailable",notice:timeout.aborted
      ? "小红书搜索在读取结果或笔记时超时，请稍后重试。" : "本次未能完成小红书浏览器检索。"};
  } finally {
    sources.sort(byCollections);
    if (target && !leaveForLogin) await port(["close",target],AbortSignal.timeout(4000)).catch(()=>undefined);
  }
}

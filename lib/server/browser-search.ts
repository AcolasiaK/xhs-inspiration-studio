import "server-only";
import { z } from "zod";
import { isCloudMode } from "../cloud/mode";
import { safePersonalSearchQuery } from "../personal/search-query";
import { canonicalPublicGuideUrl, isSafeTravelSourceUrl, travelSourcesMayConflict, type TravelResearch } from "../travel-research";

import { BrowserNavigationBlockedError, runOpenClawBrowser, type BrowserSearchPort } from './openclaw-browser';
export { BrowserNavigationBlockedError, browserNavigationBlockedNotice, type BrowserSearchPort } from './openclaw-browser';
export const browserSearchTransport: { run: BrowserSearchPort } = { run: runOpenClawBrowser };

const pageSchema = z.object({
  url: z.string().url().max(4096), blocked: z.boolean(),
  state: z.enum(["results", "empty", "unrecognized"]).optional(),
  pages: z.array(z.object({ title: z.string().max(500), url: z.string().max(4096), snippet: z.string().max(1500) })).max(20),
});
// Read actual organic result cards, never an AI answer or page-wide text. The
// short wait runs inside this owned tab so CLI startup cost isn't multiplied.
const inspectBing = `async () => {
  const cardContainer = '#b_results .b_algo, #b_results > li:not(.b_ans,.b_ad,.b_pag):has(h2 a[href]), #b_results > div:not(.b_ans,.b_ad):has(h2 a[href])';
  const cards = () => [...new Set([...document.querySelectorAll('li.b_algo'), ...document.querySelectorAll(cardContainer)])];
  const readText = node => node?.innerText?.trim() || node?.textContent?.trim() || '';
  const readHeading = card => {
    const link = card.querySelector('h2 a') || card.querySelector('h3 a[href], a.b_title[href], a:has(h2)');
    return {title:readText(link), url:link?.href || ''};
  };
  const readyCard = card => { const {title,url} = readHeading(card); return title && url; };
  const isEmpty = () => {
    if (document.querySelector('.b_no, #b_results .b_noresults')) return true;
    const text = readText(document.querySelector('#b_results')).slice(0,1500);
    return /未找到与.{0,140}相关的(?:网页|结果)|没有与.{0,140}匹配的(?:搜索)?结果|there are no results for|no results found for/i.test(text);
  };
  const blocked = () => {
    const text = document.body?.innerText.slice(0, 3000) || '';
    if (document.querySelector('#b_captcha,iframe[src*="recaptcha"],iframe[src*="hcaptcha"]')) return true;
    if (/验证您是人类|请完成验证|访问频次异常|Verify you are human|unusual traffic/i.test(text)) return true;
    return !cards().some(readyCard) && !isEmpty() && /please solve the challenge below to continue/i.test(text);
  };
  for(let i=0;i<15;i++) {
    if(blocked() || cards().some(readyCard) || isEmpty()) break;
    await new Promise(r=>setTimeout(r,200));
  }
  const results = cards();
  return {url:location.href,blocked:blocked(),state:results.length ? 'results' : isEmpty() ? 'empty' : 'unrecognized',
    pages:results.map(e=>{
      const {title,url} = readHeading(e);
      const snippet = ['.b_caption p','.b_lineclamp2,.b_lineclamp3,.b_lineclamp4,.b_snippet','.b_caption'].map(s=>readText(e.querySelector(s))).find(Boolean);
      return {title:title.slice(0,500),url:url.slice(0,4096),snippet:(snippet||'').slice(0,1500)};
    }).filter(page=>page.title && page.url).slice(0,20)};
}`;

const inspectBaidu = `async () => {
  const text = node => node?.innerText?.trim() || node?.textContent?.trim() || '';
  const cards = () => Array.from(document.querySelectorAll('#content_left > .result, #content_left > .c-container'));
  const readCard = card => {
    const link = card.querySelector('h3 a[href]');
    const title = text(link) || text(card.querySelector('h3'));
    let url = card.getAttribute('mu') || link?.getAttribute?.('data-landurl') || '';
    if (!url) {
      const data = card.querySelector('[data-tools]')?.getAttribute('data-tools') || '';
      try { url = JSON.parse(data).url || ''; } catch {}
    }
    const snippet = ['[class*="summary-text"]', '.c-abstract, [class*="content-right"], [class*="abstract"]', '[class*="content-text"]'].map(s=>text(card.querySelector(s))).find(Boolean) || '';
    return {title:title.slice(0,500),url:String(url || link?.href || '').slice(0,4096),snippet:snippet.slice(0,1500)};
  };
  const blocked = () => location.hostname === 'wappass.baidu.com' || !!document.querySelector('#vcode, #verify-img, iframe[src*="captcha"]') ||
    /百度安全验证|请完成(?:安全|人机)?验证|请完成下方验证|请输入验证码/i.test(text(document.body).slice(0,1500));
  const empty = () => /没有找到.{0,100}相关(?:结果|的网页)|抱歉.{0,50}未找到相关结果/.test(text(document.querySelector('#content_left')).slice(0,1500));
  let found = [], organic = [], pages = [];
  for (let i=0; i<=15; i++) {
    if (blocked()) return {url:location.href,blocked:true,state:'unrecognized',pages:[]};
    found = cards();
    organic = found.filter(card=>card.getAttribute('tpl') === 'www_index');
    pages = organic.map(readCard).filter(page=>page.title && page.url).slice(0,20);
    if (pages.length || empty() || i===15) break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return {url:location.href,blocked:false,state:organic.length ? 'results' : found.length || empty() ? 'empty' : 'unrecognized',pages};
}`;

// Read a bounded excerpt from an article that was already accepted by the source filter.
const articleText = `() => {
  const regions = Array.from(document.querySelectorAll('.TRS_Editor,.trs_editor,#zoom,.article-content,.articleContent,article'));
  const root = regions.find(region=>region.innerText?.trim().length>=120) || document.querySelector('main') || document.body;
  const text = (root?.innerText?.trim() || root?.textContent?.trim() || '').slice(0,45000);
  const blocked = !!document.querySelector('#b_captcha,iframe[src*="recaptcha"],iframe[src*="hcaptcha"]') ||
    (text.length < 2500 && /请完成(?:安全|人机)?验证|验证您是人类|Verify you are human|please solve the challenge below to continue/i.test(text));
  return {url:location.href, text, blocked};
}`;
// Match common travel terms and landmarks across Chinese editions while keeping
// the source's original spelling in citations.
const travelCharacters = new Map([
  "開开 門门 遊游 覽览 線线 車车 轉转 換换 達达 從从 發发 點点 鐵铁 機机 場场",
  "導导 灣湾 橋桥 龍龙 鎮镇 區区 縣县 閩闽 廣广 東东 臺台 鄉乡 島岛 樓楼 傳传",
  "統统 萬万 國国 來来 經经 過过 聖圣 舊旧 園园 廟庙 宮宫 遺遗 觀观 風风 華华",
  "蘭兰 嶼屿 專专 碼码 頭头 遠远 歷历 騎骑 駁驳 體体 驛驿 續续 閱阅 讀读 薦荐",
  "順顺 鐘钟 終终 館馆 廳厅 資资 訊讯 臨临 聯联 貴贵 陽阳 瀋沈 寧宁 烏乌 蘇苏",
  "雲云 慶庆 濟济 長长 齊齐 靈灵 樹树 祕秘 廈厦 張张 漢汉 滬沪 遼辽 鹽盐 溫温",
  "實实 閣阁 嶺岭 帶带 紹绍 鶴鹤 撫抚 項项 澤泽 濱滨 豐丰 銀银 義义 臥卧 圖图",
  "樂乐 錦锦 錫锡 豔艳 樺桦 橫横 麗丽 緯纬",
].join(" ").split(" ").map(pair => [pair[0], pair[1]]));
export function guideKey(value: string) {
  return value.normalize("NFKC").replace(/[\u3400-\u9fff]/gu, char => travelCharacters.get(char) ?? char);
}
function itineraryExcerpt(body:string, topics:string[], overview = false) {
  const segments = body.split(/(?<=[。！？；])|[\r\n]+/u)
    .map(line=>clean(line,450)).filter(Boolean).map(line=>({line, key:guideKey(line)}));
  const mentionsPlace = (line: string) => topics.some(word=>line.includes(word));
  const ranked = segments.flatMap(({line,key},index) => {
    if (line.length < 10 || /责任编辑|主办单位|ICP备|上一篇|下一篇|相关阅读/u.test(key)) return [];
    // A place in the article's footer must not authorize an unrelated city's route.
    const previous = segments[index-1]?.key ?? "";
    const followsPlaceHeading = previous.length <= 40 && mentionsPlace(previous) &&
      (topics.includes(previous) || /(?:攻略|指南|路线|线路|交通|玩法)[：:]?$/u.test(previous));
    if (!mentionsPlace(key) && !followsPlaceHeading) return [];
    const score = 3*Number(overview && /^(?:路线|线路)(?:推荐|安排)|^(?:游览|游玩)路线/u.test(key)) +
      2*Number(/→|—.{1,25}—|从.{1,24}(?:到|至|出发)|沿.{1,18}(?:到|至|步行)|乘坐|换乘|起点站|终点站|码头|入口/u.test(key)) +
      Number(/游览|骑行|步行|公交|接驳|街巷|步行街/u.test(key)) + Number(mentionsPlace(key));
    return score >= 2 ? [{line,index,score}] : [];
  }).sort((a,b)=>b.score-a.score || a.index-b.index).slice(0,overview ? 5 : 4).sort((a,b)=>a.index-b.index);
  return clean([...new Set(ranked.map(item=>item.line))].join(" … "),520);
}

function sourceUrl(value: string, allowGuide: boolean): string | null {
  try {
    let url = new URL(value);
    if (url.protocol === "https:" && ["www.bing.com", "cn.bing.com"].includes(url.hostname) && url.pathname === "/ck/a" && !url.username && !url.password) {
      const encoded = url.searchParams.get("u") ?? "";
      if (!/^a1[A-Za-z0-9_=-]+$/u.test(encoded)) return null;
      url = new URL(Buffer.from(encoded.slice(2), "base64url").toString("utf8"));
    }
    url.hash = "";
    if (url.href.length > 2048) return null;
    if (isSafeTravelSourceUrl(url.href)) return url.href;
    return allowGuide ? canonicalPublicGuideUrl(url.href) : null;
  } catch { return null; }
}
function clean(value: string, max: number) {
  return value.replace(/<[^>]{0,500}>/gu, " ").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

/** Local only. A fresh owned tab, bounded duration, no paid/provider fallback. */
export async function searchBrowserBackground(
  input: { place: string; enabled: boolean; signal?: AbortSignal; background?: boolean; guide?: boolean; wholeDestination?: boolean; followUp?: "route"|"transit"|"sources" },
  options: { port?: BrowserSearchPort; timeoutMs?: number } = {},
): Promise<TravelResearch> {
  input.signal?.throwIfAborted();
  let retrievedAt: string | null = null;
  const empty = (status: TravelResearch["status"], notice: string): TravelResearch => ({ status, retrievedAt, sources: [], notice, provider: "browser", summaryKind: "source_excerpt" });
  if (!input.enabled) return empty("disabled", "本次未联网检索，未核实的外部信息不会作为确定事实。");
  if (isCloudMode()) return empty("not_configured", "本机浏览器检索仅在这台电脑的工作台可用，云端不能访问本机浏览器。");
  const query = safePersonalSearchQuery(input.place);
  if (!query) return empty("missing_place", "未能确定安全、明确的公开检索主题，可选填地点或关键词后重试。");
  const [destination, ...words] = query.split(" ");
  const keywords = words.filter(k=>!/^(交通|旅游|景点|行程|路线|接驳|步行|游览|攻略|公交|骑行)$/u.test(k));
  const key = input.guide ? guideKey : (value:string) => value;
  const destinationKey = key(destination);
  // A single public place may already contain a city and an attraction ("泉州开元寺").
  const cityLandmark = input.guide && /^(.{1,6}?(?:州|市|县|区))(.{1,12}(?:寺|庙|公园|博物馆|古镇|景区|码头))$/u.exec(destinationKey);
  const area = cityLandmark ? cityLandmark[1] : destinationKey;
  const term = area.replace(/(?:特别行政区|自治区|自治州|省|市|县|区)$/u, "") || area;
  const focusKey = (word:string) => {
    const full = key(word);
    const short = full.startsWith(term) ? full.slice(term.length).replace(/^[市县区]/u,"") : full;
    const place = short.length >= 2 ? short : full;
    const name = place.replace(/(?:传统村落|历史文化街区|旅游景区|风景区)$/u, "");
    return name.length >= 2 ? name : place;
  };
  const focusKeys = (terms:string[]) => [...new Set([...(cityLandmark ? [cityLandmark[2]] : []), ...terms.map(focusKey)])];
  const wholeDestination = input.guide && input.wholeDestination;
  const routeTerms = keywords.slice(0, wholeDestination ? 2 : 1);
  const transitTerms = keywords.slice(routeTerms.length);
  const transitFocus = transitTerms.length ? transitTerms : routeTerms;
  const followUp = input.guide ? input.followUp : undefined;
  const followUpTerms = wholeDestination ? [] : (followUp === "transit" ? transitFocus : keywords).slice(0,1);
  const followUpIntent = wholeDestination
    ? { route: "步行 游览路线 攻略", transit: "旅游攻略 路线 公交", sources: "一日游 路线 攻略" }
    : { route: "旅游攻略 游览顺序", transit: "怎么去 公交站", sources: "一日游 攻略" };
  const engine = followUp ? "百度" : "必应";
  const searches = input.guide ? [
    {query: [destination, ...routeTerms, "游览线路", "步行攻略"].join(" "), terms:routeTerms, kind:"route" as const},
    {query: [destination, ...(wholeDestination ? transitFocus.slice(-1) : transitFocus), "游玩", "路线", "交通"].join(" "), terms:transitFocus, kind:"transit" as const},
  ] : [{query: query + (input.background ? "" : " 旅游攻略"), terms:[], kind:"background" as const}];
  const plans: {query:string; terms:string[]; kind:"overview"|"route"|"transit"|"fallback"|"background"}[] = followUp
    ? [{query:[destination, ...followUpTerms, followUpIntent[followUp]].join(" "), terms:followUpTerms, kind:followUp==="transit" ? "transit" : "route"}]
    : wholeDestination
    ? [{query: `${destination} 旅游 精品线路 推荐 景点 攻略`, terms:[], kind:"overview"}, ...searches]
    : searches;
  const waypoint = /步行(?!街区管理|街区是|为主)|骑行|古渡|码头|游线|游览线路|游览路线|旅游线路|游玩路线|游览顺序|→|途经|经停/u;
  const transit = /乘坐|乘车|发车|上车|下车|途经|经停|终点站|始发|接驳车|公交.{0,8}(?:路|站)|[0-9]+路/u;
  const namedPath = /(?:→|—.{1,18}—|沿.{1,16}(?:到|至|走|行)|从.{2,24}(?:出发|前往|抵达|到|至)|码头|入口|古渡|步道|换乘)/u;
  const needsArticle = new Set<string>();
  const verifiedSnippets = new Map<string, TravelResearch["sources"][number]>();
  const articleFocus = new Map<string, string[]>();
  const groups: TravelResearch["sources"][] = [];
  let cardCount = 0, readableLinks = 0, eligibleUrls = 0, unreadable = false, interruption = "";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? (input.guide ? 55_000 : 40_000));
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const port = options.port ?? browserSearchTransport.run;
  const failureNotice = (error: unknown) => error instanceof BrowserNavigationBlockedError ? error.message :
    timeout.aborted ? "浏览器检索超时。" : "浏览器检索暂时不可用，请确认 OpenClaw 网关与浏览器可用后重试。";
  let target: string | undefined, keepOpen = false;
  let abort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("检索已中断", "AbortError"));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  const call = async (args: string[]) => {
    signal.throwIfAborted();
    const result = await Promise.race([port(args, signal), aborted]);
    signal.throwIfAborted();
    return result;
  };
  try {
    retrievedAt = new Date().toISOString();
    await call(["start"]);
    // Acquire ownership independently of caller cancellation. Opening a blank
    // page avoids losing the target ID while waiting for a remote navigation.
    signal.throwIfAborted();
    const opened = port(["open", "about:blank"], AbortSignal.timeout(10_000)).then(reply => {
      target = reply.targetId;
      if (signal.aborted && target) void port(["close", target], AbortSignal.timeout(5000)).catch(() => undefined);
      return reply;
    });
    await Promise.race([opened, aborted]);
    signal.throwIfAborted();
    if (!target) throw new Error("NO_TAB");
    for (const plan of plans) {
      const search = new URL(followUp ? "https://www.baidu.com/s" : "https://cn.bing.com/search");
      const queryParam = followUp ? "wd" : "q";
      const allowGuide = Boolean(followUp) || plan.kind === "overview" || plan.kind === "route";
      search.searchParams.set(queryParam, allowGuide ? plan.query : `${plan.query} (site:gov.cn OR site:12306.cn OR site:news.cn OR site:people.com.cn)`);
      if (!followUp) search.searchParams.set("ensearch", "1");
      let page: z.infer<typeof pageSchema>;
      try {
        await call(["navigate", search.href, "--target-id", target]);
        page = pageSchema.parse((await call(["evaluate", "--target-id", target, "--fn", followUp ? inspectBaidu : inspectBing])).result);
      } catch (error) {
        input.signal?.throwIfAborted();
        interruption = failureNotice(error);
        break;
      }
      if (page.blocked) {
        keepOpen = true;
        interruption = engine+"需要安全验证。请在已保留的 OpenClaw 浏览器标签页完成验证，然后回到工作台重试。";
        break;
      }
      const actual = new URL(page.url);
      const engineHosts = followUp ? ["www.baidu.com"] : ["cn.bing.com","www.bing.com"];
      if (actual.protocol !== "https:" || !engineHosts.includes(actual.hostname) || actual.pathname !== search.pathname || actual.searchParams.get(queryParam) !== search.searchParams.get(queryParam)) {
        interruption = "浏览器没有返回本次关键词的搜索页面，请重试。";
        break;
      }
      cardCount += page.pages.length || Number(page.state === "results");
      if (page.state === "unrecognized") unreadable = true;
      const focusWords = plan.terms;
      const focus = focusKeys(focusWords);
      const guideTitle = /路线|线路|走法|游线|攻略|指南|行程|交通指引|经典景点|景点推荐/u;
      const candidates: TravelResearch["sources"] = [];
      for (const item of page.pages) {
        const url = sourceUrl(item.url, allowGuide), title = clean(item.title, 180), snippet = clean(item.snippet, 600);
        if (item.url && title) readableLinks++;
        if (!url || !title) continue;
        eligibleUrls++;
        const titleKey = key(title), snippetKey = key(snippet);
        const preview = titleKey + " " + snippetKey;
        const hasDestination = preview.includes(term);
        const hasFocus = !focus.length || focus.some(word=>preview.includes(word));
        // A route title may name the attraction while its parent city appears only in the article.
        if (!hasDestination && !(input.guide && focus.length && hasFocus && guideTitle.test(titleKey))) continue;
        if (!hasFocus && !(input.guide && hasDestination && guideTitle.test(titleKey))) continue;
        if (!snippet && !input.guide) continue;
        if (input.guide && /政策解读|管理办法|总体概况|统计公报|工作报告/u.test(titleKey)) continue;
        const coversOverview = plan.kind==="overview" && guideTitle.test(titleKey);
        if (plan.kind==="overview" && !coversOverview && keywords.filter(word=>preview.includes(focusKey(word))).length<2) continue;
        const source: TravelResearch["sources"][number] = {title, url, snippet, source:new URL(url).hostname};
        if (!isSafeTravelSourceUrl(url)) source.kind = "travel_guide";
        if (input.guide && (!hasDestination || !hasFocus || (!waypoint.test(snippetKey) && !transit.test(snippetKey) && !namedPath.test(snippetKey)))) {
          // Official destination guides sometimes show only a weather teaser or footer in Bing.
          const pageName = titleKey.split(/\s[-_|]\s/u)[0].replace(/[（(][1-5]A[）)]/iu,"").trim();
          const places = focus.length ? focus : [term];
          const isAttractionPage = places.some(word=>pageName===word ||
            (pageName.includes(word) && /廊道|游览|步道|景区|攻略|古镇|小镇|出游|接驳/u.test(pageName)));
          if (!guideTitle.test(titleKey) && !isAttractionPage) continue;
          if (!verifiedSnippets.has(url)) {
            needsArticle.add(url);
            articleFocus.set(url, [...new Set([...(articleFocus.get(url) ?? []), ...focus])]);
          }
        } else {
          needsArticle.delete(url);
          verifiedSnippets.set(url,source);
        }
        candidates.push(source);
      }
      if (input.guide) {
        const intent = plan.kind==="transit" || plan.kind==="fallback" ? transit : waypoint;
        const detail = (s: TravelResearch["sources"][number]) => {
          const title = key(s.title), snippet = key(s.snippet);
          return 2 * Number(/廊道|游览|步道/u.test(title) && focus.some(k=>title.startsWith(k))) +
            2 * Number(plan.kind==="overview" && guideTitle.test(title)) +
            (wholeDestination && plan.kind!=="overview" ? 3 * Number(focus.some(word=>title.includes(word))) : 0) +
            Number(intent.test(snippet)) + 2 * Number(namedPath.test(snippet)) +
            keywords.filter(k=>(title+snippet).includes(focusKey(k))).length;
        };
        candidates.sort((a,b)=>detail(b)-detail(a));
      }
      if (!followUp && plan.kind==="transit" && !wholeDestination && !candidates.some(source=>!needsArticle.has(source.url) && focus.some(word=>key(source.title).includes(word)))) {
        // A busy transit query can miss the destination entirely. Simplify it in the same tab.
        plans.push({query:[destination,...focusWords,"交通","入口","步行"].join(" "),terms:focusWords,kind:"fallback"});
      }
      if (plan.kind==="fallback") groups[1].push(...candidates);
      else groups.push(candidates);
    }
    // Take turns so that itinerary and transport evidence both fit in the five source limit.
    const ordered: TravelResearch["sources"] = [], seen = new Set<string>();
    const longestGroup = Math.max(0, ...groups.map(group=>group.length));
    for (let i=0; i<longestGroup; i++) {
      for (const group of groups) {
        const source=group[i];
        if (source && !seen.has(source.url)) {
          seen.add(source.url);
          ordered.push(verifiedSnippets.get(source.url) ?? source);
        }
      }
    }
    if (!ordered.length) {
      if (interruption) return {...empty("error", interruption), query};
      if (!cardCount && unreadable) return {...empty("error", engine+"搜索页已打开，但未能读取结果列表。请稍后重试。"), query};
      if (!cardCount) return {...empty("no_results", engine+"没有返回与本次关键词匹配的搜索结果。"), query};
      if (!readableLinks) return {...empty("error", engine+"已显示结果列表，但未能读取条目的标题和链接。"), query};
      const notice = !eligibleUrls ? engine+"返回了搜索条目，但没有可引用的来源链接。"
        : input.guide ? "已读取搜索结果，本轮没有找到与所查地点相符的攻略、路线或交通资料。"
          : "本次浏览器搜索未找到可用的政府、铁路或权威媒体资料，可换更具体的关键词重试。";
      return {...empty("no_results", notice), query};
    }
    let excerptCount = 0;
    if (input.guide && !interruption && !signal.aborted) {
      const pending = ordered.filter(source=>needsArticle.has(source.url));
      const verified = ordered.filter(source=>!needsArticle.has(source.url));
      const followUpCovered = verified.some(source => {
        const snippet = key(source.snippet);
        return followUp === "transit" ? transit.test(snippet) : followUp === "route" ? namedPath.test(snippet) : true;
      });
      // A targeted second round is done as soon as its result cards answer the missing question.
      const toRead = followUp ? (followUpCovered ? [] : pending.slice(0,2)) : [...pending, ...verified].slice(0,3);
      for (const source of toRead) {
        try {
          await call(["navigate",source.url,"--target-id",target]);
          const reply = await call(["evaluate","--target-id",target,"--fn",articleText]);
          const article = z.object({url:z.string().max(4096),text:z.string().max(45000),blocked:z.boolean().optional()}).safeParse(reply.result);
          if (!article.success) continue;
          if (article.data.blocked) {
            keepOpen = true;
            interruption = "攻略来源需要安全验证。请在已保留的 OpenClaw 浏览器标签页完成验证后重试。";
            break;
          }
          if (sourceUrl(article.data.url, source.kind === "travel_guide")!==source.url) continue;
          const focus = articleFocus.get(source.url) ?? [];
          if (needsArticle.has(source.url)) {
            const body = key(article.data.text);
            const scoped = key(source.title) + " " + body;
            if (!scoped.includes(term) || (focus.length && !focus.some(word=>scoped.includes(word)))) continue;
            if (![term,...focus].some(word=>body.includes(word))) continue;
          }
          const isOverview = !followUp && wholeDestination && groups[0].some(candidate=>candidate.url===source.url);
          const excerpt = itineraryExcerpt(article.data.text, focus.length ? focus : [term,...focusKeys(keywords)], isOverview);
          const excerptKey = key(excerpt);
          if (excerpt.length >= 20 && (waypoint.test(excerptKey) || transit.test(excerptKey) || namedPath.test(excerptKey))) {
            source.snippet = clean([source.snippet.slice(0,135),"网页节选："+excerpt].filter(Boolean).join(" ｜ "),600);
            needsArticle.delete(source.url);
            excerptCount++;
          }
        } catch (error) {
          input.signal?.throwIfAborted();
          if (signal.aborted) { interruption = failureNotice(error); break; }
        }
      }
    }
    const sources = ordered.filter(source=>!needsArticle.has(source.url)).slice(0,5);
    if (!sources.length) {
      if (interruption || timeout.aborted) return {...empty("error",interruption || failureNotice(null)),query};
      return {...empty("no_results","找到相关页面，但未取得可用的路线或接驳段落。"),query};
    }
    const secondFocus = transitTerms.filter(word=>!routeTerms.includes(word));
    const coverageGap = input.guide && (groups.some(group=>!group.some(result=>sources.some(source=>source.url===result.url))) ||
      (secondFocus.length > 0 && !sources.some(source=>secondFocus.some(word=>key(source.title).includes(focusKey(word))))) ||
      !sources.some(s=>namedPath.test(key(s.snippet))) || !sources.some(s=>transit.test(key(s.snippet))) ||
      focusKeys(keywords).some(k=>!sources.some(s=>key(s.title+s.snippet).includes(k))));
    const potentialConflict = travelSourcesMayConflict(sources);
    return {
      status: interruption || unreadable || sources.length < 3 || coverageGap || potentialConflict ? "partial" : "success", retrievedAt, sources, query,
      provider: "browser", summaryKind: "source_excerpt", potentialConflict,
      notice: interruption ? interruption + " 已保留先前取得的来源。" : unreadable ? "部分查询未能读取搜索结果列表，已保留本轮可引用的资料。"
        : potentialConflict ? "搜索摘要中的票价或时间可能有差异，请打开来源核实；本次没有阅读全文核验。" : coverageGap ? "取得了部分游览资料，有些点位或交通衔接仍缺少依据。" : excerptCount ? "已搜路线和交通，并摘取相关来源正文。班次与票价请按出行日期核对。" : "已通过本机浏览器取得搜索结果摘要，未阅读全文核验。票价、班次与开放时间请以最新官方公告为准。",
    };
  } catch (error) {
    input.signal?.throwIfAborted();
    return {...empty("error", failureNotice(error)), query};
  } finally {
    signal.removeEventListener("abort", abort);
    if (target && !keepOpen) {
      const cleanup = AbortSignal.timeout(5000);
      await new Promise<void>(resolve => {
        const done = () => { cleanup.removeEventListener("abort", done); resolve(); };
        cleanup.addEventListener("abort", done, { once: true });
        void port(["close", target!], cleanup).then(done, done);
      });
    }
  }
}

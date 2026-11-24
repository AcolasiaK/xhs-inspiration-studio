import "server-only";
import { travelSourcesMayConflict, type TravelResearch } from "../travel-research";
import { guideKey, searchBrowserBackground } from "./browser-search";
import { searchEastChinaTripGuide } from "./eastchinatrip-guide";
import { searchWikivoyageGuide } from "./wikivoyage-guide";

type Source = TravelResearch["sources"][number];
type Input = { query: string; wholeDestination: boolean; signal?: AbortSignal };
type Options = {
  browser?: typeof searchBrowserBackground;
  wiki?: typeof searchWikivoyageGuide;
  cityGuide?: typeof searchEastChinaTripGuide;
  timeoutMs?: number;
};

const minimumPages = 3;
const totalBudgetMs = 90_000;
// Require an actual sequence and a concrete transport detail in the excerpts. A title such
// as "泉州交通攻略" or a search result listing the headings cannot fill either gap.
const itineraryEvidence = [
  /[\p{L}）)]\s*(?:→|➡|➜|->|—{1,2}|-{1,2})\s*[（(\p{L}]/u,
  /(?:从|沿|由|自)[^。！？｜]{1,30}(?:步行|骑行|徒步)[^。！？｜]{0,18}(?:到|至|经|前往)/u,
  /(?:先游|先到|先去|先逛|先[参參]观)[^。！？｜]{2,35}(?:再|然[后後])/u,
  /(?:第一站|首站)[^。！？｜]{2,45}(?:第二站|下一站|再到)/u,
];
const transportEvidence = [
  /[\p{L}]{1,12}(?:站|机场|码头)[，,。\s]*(?:地址|位[于於])[：:\s]*[\p{L}]{2,25}[路街道巷]\d+\s*[号號]/u,
  /[A-Z]?\d{1,4}\s*(?:路|[号號]线)/iu,
  /(?:[\p{L}\d]{1,15}站|[\p{L}]{2,12}(?:机场|码头))[^。！？｜]{0,20}(?:乘坐|搭乘|转乘|换乘|下车|上车|出站|公交|公车)/u,
  /(?:乘坐|搭乘|乘|转乘|换乘)[^。！？｜]{0,12}(?:公交|公共汽车|巴士|地铁|接驳车|公车|高铁)[^。！？｜]{0,20}(?:到|至|在|下车|抵达)/u,
  /接驳车[^。！？｜]{0,12}(?:到|至|[连連]接)/u,
];
const placeDetail = /地址[：:\s]+[\p{L}]{3,}|位[于於][\p{L}]{2,}|[\p{L}]{2,}[东西南北]岸|[\p{L}]{2,}(?:出入口|[东西南北]门)|[街路巷]\s*\d+\s*[号號]|[\p{L}]{2,}(?:火车站|机场|客[运運]站)/u;
const hasRoute = (s: Source) => itineraryEvidence.some(pattern => pattern.test(guideKey(s.snippet)));
const hasTransit = (s: Source) => transportEvidence.some(pattern => pattern.test(guideKey(s.snippet)));
const usable = (s: Source) => hasRoute(s) || hasTransit(s) || placeDetail.test(guideKey(s.snippet));
const cleanExcerpt = (s: string) => guideKey(s).replace(/\s+/gu, "").trim();

function requestedLandmarks(input: Input) {
  if (input.wholeDestination) return [];
  const [destination, ...words] = guideKey(input.query).split(" ");
  return words.filter(word => !/^(?:旅游|游玩|景点|步行|骑行|自驾|公交|地铁|接驳|交通|线路|路线|攻略)$/u.test(word))
    .map(word => {
      const name = word.replace(/(?:传统村落|历史文化街区|旅游景区|风景区)$/u, "");
      const short = name.startsWith(destination) ? name.slice(destination.length) : name;
      return { word, match: short.length >= 2 ? short : word };
    });
}

function pageKey(source: Source) {
  const url = new URL(source.url);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|from$|spm$)/iu.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href.replace(/\/$/u,"");
}

function selectSources(candidates: Source[], input: Input) {
  const seenPages = new Map<string, Source>();
  const score = (s: Source) => Number(hasRoute(s)) + Number(hasTransit(s)) + Number(usable(s));
  for (const s of candidates) {
    if (!s.snippet.trim()) continue;
    const key = pageKey(s), previous = seenPages.get(key);
    if (!previous || score(s) > score(previous) || (score(s) === score(previous) && s.snippet.length > previous.snippet.length)) seenPages.set(key,s);
  }
  const excerpts = new Set<string>();
  const unique = [...seenPages.values()].filter(s => {
    const key = cleanExcerpt(s.snippet);
    if (excerpts.has(key)) return false;
    excerpts.add(key);
    return true;
  });
  // Reserve space for each type of evidence before applying the saved-draft limit of five.
  const usefulPages = unique.filter(usable);
  const forLandmarks = requestedLandmarks(input).map(({match}) =>
    usefulPages.find(s => guideKey(s.title + " " + s.snippet).includes(match)));
  const preferred = [unique.find(hasRoute), unique.find(hasTransit), ...forLandmarks]
    .filter((source): source is Source => source !== undefined);
  return [...new Set([...preferred, ...usefulPages, ...unique])].slice(0, 5);
}

function coverage(sources: Source[], input: Input) {
  const usableSources = travelSourcesMayConflict(sources) ? sources.filter(s=>s.kind) : sources;
  const count = usableSources.filter(usable).length;
  const route = usableSources.some(hasRoute);
  const transit = usableSources.some(hasTransit);
  const evidence = guideKey(usableSources.filter(usable).map(s => s.title + " " + s.snippet).join(" "));
  const missingPlaces = requestedLandmarks(input).filter(({match}) => !evidence.includes(match)).map(({word}) => word);
  const missing = [
    count < minimumPages ? `还差 ${minimumPages - count} 个有具体内容的页面` : "",
    !route ? "缺少具体游览顺序" : "",
    !transit ? "缺少可用的站点、乘车或接驳信息" : "",
    missingPlaces.length ? "缺少" + missingPlaces.join("、") + "的资料" : "",
  ].filter(Boolean);
  return {
    missing,
    nextQuery: missingPlaces.length ? [input.query.split(" ")[0], ...missingPlaces].join(" ") : input.query,
    followUp: !route ? "route" as const : !transit ? "transit" as const : "sources" as const,
  };
}

export async function researchPersonalGuide(input: Input, options: Options = {}): Promise<TravelResearch> {
  input.signal?.throwIfAborted();
  const budget = options.timeoutMs ?? totalBudgetMs;
  const deadline = performance.now() + budget;
  const timeout = AbortSignal.timeout(budget);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, timeout, ...(input.signal ? [input.signal] : [])]);
  const candidates: Source[] = [];
  const reports: TravelResearch[] = [];
  let rounds = 1;
  const accept = (sources: Source[]) => {
    if (signal.aborted) return;
    candidates.push(...sources);
    if (!coverage(selectSources(candidates, input), input).missing.length) stop.abort();
  };
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  signal.addEventListener("abort", finish, {once:true});
  const browser = options.browser ?? searchBrowserBackground;
  const search = async (followUp?: "route" | "transit" | "sources", place = input.query) => {
    // Reserve a second-round budget and leave time for the browser to return its partial results.
    const timeoutMs = Math.max(1, Math.min(followUp ? totalBudgetMs : 32_000, Math.floor(deadline - performance.now() - 4500)));
    const result = await browser({ place, enabled:true, background:true, guide:true, wholeDestination:input.wholeDestination, signal, followUp }, {timeoutMs});
    if (!signal.aborted) {reports.push(result); accept(result.sources);}
  };
  const wiki = options.wiki ?? searchWikivoyageGuide;
  const cityGuide = options.cityGuide ?? searchEastChinaTripGuide;
  const requiresUser = () => reports.find(r=>/安全验证|导航保护/u.test(r.notice));
  const retrievedAt = new Date().toISOString();
  try {
    const guideInput = {...input, signal};
    const first = Promise.allSettled([
      search(),
      wiki(guideInput).then(result => accept(result.sources)),
    ]);
    await Promise.race([first,stopped]);
    if (!signal.aborted && !requiresUser()) {
      rounds = 2;
      const gap = coverage(selectSources(candidates, input), input);
      const followUp = Promise.allSettled([
        search(gap.followUp, gap.nextQuery),
        cityGuide({...guideInput, query: gap.nextQuery}).then(result => accept(result.sources)),
      ]);
      await Promise.race([followUp, stopped]);
    }
    input.signal?.throwIfAborted();
    const sources = selectSources(candidates, input);
    const { missing } = coverage(sources, input);
    const completed = missing.length === 0;
    const failure = requiresUser() ?? reports.findLast(r=>r.status==="error");
    const status = completed ? "success" : sources.length ? "partial" : timeout.aborted || failure ? "error" : "no_results";
    const reason = timeout.aborted ? "已到本次检索时间上限。" : failure?.notice ?? (!sources.length ? reports.at(-1)?.notice ?? "" : "");
    const notice = completed ? `已取得 ${sources.length} 个不同页面，含具体游览顺序和交通信息。班次与票价请按出行日期核实。`
      : `${reason}本次已查 ${rounds} 轮，保留 ${sources.length} 个页面，${missing.join("，")}。已停止自动检索。`;
    return {status, sources, notice, query:input.query, guideScope:input.wholeDestination ? "destination" : "segment",
      retrievedAt, provider:"browser", summaryKind:"source_excerpt", potentialConflict:travelSourcesMayConflict(sources)};
  } finally {
    signal.removeEventListener("abort",finish);
    stop.abort();
  }
}

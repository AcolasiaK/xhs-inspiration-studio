import { z } from "zod";

/** Public publishers eligible for the official browser-search and fetch paths. */
const PUBLISHER_DOMAINS = ["gov.cn", "12306.cn", "news.cn", "people.com.cn"] as const;
const PUBLIC_GUIDE_ARTICLE_PATHS = new Map([
  ["post.smzdm.com", /^\/p\/[a-z0-9]{6,20}\/?$/iu],
  ["you.ctrip.com", /^\/(?:sight|travels)\/[a-z0-9-]+\/\d+\.html$/iu],
  ["zhuanlan.zhihu.com", /^\/p\/\d+\/?$/u],
  ["www.sohu.com", /^\/a\/\d+_\d+\/?$/u],
  ["www.eastchinatrip.com", /^\/(?:zh(?:-(?:hans|hant|cn|tw))?\/)?china-city-guides\/(?:[a-z0-9]+-)+travel-guide\/?$/u],
]);

export function isSafeTravelSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      PUBLISHER_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

/** Note references are canonical public links. Never store browser session tokens. */
export function isSafeXhsTravelNoteUrl(value: string): boolean {
  return /^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{24}$/u.test(value);
}

/** Canonical public guide articles are useful for itinerary evidence. */
export function isSafePublicTravelGuideUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    if (url.hostname === "baijiahao.baidu.com") return url.pathname === "/s" && /^\?id=\d{15,20}$/u.test(url.search);
    if (url.search) return false;
    const articlePath = PUBLIC_GUIDE_ARTICLE_PATHS.get(url.hostname);
    if (articlePath) return articlePath.test(url.pathname);
    if (url.hostname !== "zh.wikivoyage.org") return false;
    const article = /^\/(?:wiki|zh(?:-(?:hans|hant|cn|hk|mo|my|sg|tw))?)\/(.+)$/u.exec(url.pathname);
    if (!article) return false;
    const title = decodeURIComponent(article[1]);
    return !/[\\:?#%]/u.test(title) && !/^(?:首页|首頁|Main[ _]Page)$/iu.test(title) &&
      title.split("/").every(segment => /[\p{L}\p{N}]/u.test(segment) && !/\p{Cc}/u.test(segment));
  } catch { return false; }
}

/** Search cards sometimes attach distribution parameters to a public article ID. */
export function canonicalPublicGuideUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && !url.username && !url.password && !url.port) url.protocol = "https:";
    if (url.hostname === "baijiahao.baidu.com" && url.pathname === "/s" &&
        url.searchParams.getAll("id").length === 1 && /^\d{15,20}$/u.test(url.searchParams.get("id") ?? "")) {
      url.search = "?id=" + url.searchParams.get("id");
    }
    return isSafePublicTravelGuideUrl(url.href) ? url.href : null;
  } catch { return null; }
}

const sourceKind = z.enum(["xiaohongshu", "travel_guide"]);
export function isSafeTravelReferenceUrl(source: { url: string; kind?: z.infer<typeof sourceKind> }): boolean {
  if (source.kind === "travel_guide") return isSafePublicTravelGuideUrl(source.url);
  if (source.kind === "xiaohongshu") return isSafeXhsTravelNoteUrl(source.url);
  return isSafeTravelSourceUrl(source.url);
}

export const travelSourceSchema = z.object({
  title: z.string().min(1).max(180),
  url: z.string().max(2048),
  source: z.string().min(1).max(100),
  snippet: z.string().max(600),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  kind: sourceKind.optional(),
  likes: z.number().int().nonnegative().optional(),
  collects: z.number().int().nonnegative().optional(),
}).refine(isSafeTravelReferenceUrl, { path: ["url"], message: "不符合检索来源链接规则" });
export const travelResearchSchema = z.object({
  status: z.enum(["disabled", "missing_place", "not_configured", "success", "partial", "no_results", "error"]),
  retrievedAt: z.string().datetime({ offset: true }).nullable(),
  sources: z.array(travelSourceSchema).max(5),
  notice: z.string().max(300),
  potentialConflict: z.boolean().optional(),
  provider: z.enum(["bocha", "chatgpt", "browser"]).optional(),
  query: z.string().max(100).optional(),
  guideScope: z.enum(["destination", "segment"]).optional(),
  summaryKind: z.enum(["source_excerpt", "search_summary"]).optional(),
});
export type TravelResearch = z.infer<typeof travelResearchSchema>;

/** A conservative warning, not a determination that different ticket categories are equivalent. */
export function travelSourcesMayConflict(sources: TravelResearch["sources"]): boolean {
  const prices = new Set<string>(), hours = new Set<string>();
  for (const item of sources) {
    if (item.kind) continue; // Only authoritative sources are compared for prices and hours.
    for (const match of item.snippet.matchAll(/(?:门票|票价)(?:价格|费用)?(?:为|是|[:：])?\s*(?:人民币)?\s*(\d+(?:\.\d+)?)\s*元/gu)) prices.add(match[1]);
    for (const match of item.snippet.matchAll(/(?:营业|开放)时间(?:为|是|[:：])?\s*(\d{1,2}[:：]\d{2})\s*[—–~～至-]\s*(\d{1,2}[:：]\d{2})/gu)) hours.add(`${match[1].replace("：", ":")}-${match[2].replace("：", ":")}`);
  }
  return prices.size > 1 || hours.size > 1;
}


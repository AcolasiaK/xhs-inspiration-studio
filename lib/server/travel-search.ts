import "server-only";
import { isCloudMode } from "../cloud/mode";
import { searchBrowserBackground } from "./browser-search";
import { isSafeTravelSourceUrl, travelSourcesMayConflict, type TravelResearch } from "../travel-research";

// A fixed endpoint prevents user input, retrieved links or redirects becoming SSRF targets.
export const TRAVEL_SEARCH_ENDPOINT = "https://api.bochaai.com/v1/web-search";
export const TRAVEL_SEARCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULTS = 5;

type SearchOptions = { fetcher?: typeof fetch; apiKey?: string; now?: () => Date; timeoutMs?: number };
type SearchPage = { name?: unknown; url?: unknown; snippet?: unknown; datePublished?: unknown };

export function isBochaSearchConfigured(apiKey = process.env.BOCHA_API_KEY ?? ""): boolean {
  return Boolean(apiKey.trim()) && !/^(?:your[-_ ]|请填写|placeholder)/iu.test(apiKey.trim());
}

function serviceFailure(status: number): string {
  if (status === 401 || status === 403) return "博查搜索密钥无效或无访问权限，请检查服务端 BOCHA_API_KEY；可关闭检索继续创作。";
  if (status === 402) return "博查搜索账户余额不足，请在搜索服务控制台检查；可不使用检索资料继续创作。";
  if (status === 429) return "博查搜索调用受限，可能是频率或额度限制，请稍后重试或检查搜索账户；可继续创作。";
  return "博查搜索服务暂时异常，未取得可用资料；可关闭检索或不使用检索资料继续创作。";
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]{0,500}>/gu, " ").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
}

async function boundedJSON(response: Response): Promise<unknown> {
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(combined));
}

/**
 * Search only the explicitly supplied place, never the user's images, notes or full brief.
 * Search pages are untrusted excerpts; we never fetch the returned links.
 * One request per operation, no automatic retries and no logging of input or responses.
 */
export async function searchBochaTravelInfo(
  input: { place: string; enabled: boolean; signal?: AbortSignal; background?: boolean },
  options: SearchOptions = {},
): Promise<TravelResearch> {
  const empty = (status: TravelResearch["status"], notice: string, retrievedAt: string | null = null): TravelResearch => ({ status, retrievedAt, sources: [], notice, provider:"bocha", summaryKind:"source_excerpt" });
  if (!input.enabled) return empty("disabled", "本次未联网检索；具体开放时间、门票与交通等信息请以官方最新公告为准。");
  const place = text(input.place, 100);
  if (!place) return empty("missing_place", "未填写检索地点，无法可靠检索；可以继续创作，具体信息请自行核实。");
  // A location is not a URL or a prompt. Avoid sending arbitrary/long private input as a query.
  if (/(?:https?:\/\/|www\.|[\r\n])/iu.test(input.place)) return empty("missing_place", "请填写地点名称，不要填写网址或多行内容；本次未联网检索。");
  const apiKey = (options.apiKey ?? process.env.BOCHA_API_KEY ?? "").trim();
  if (!isBochaSearchConfigured(apiKey)) return empty("not_configured", "博查联网检索尚未配置：请在本机 .env.local 或云托管服务端环境变量中设置 BOCHA_API_KEY 并重启或发布。仍可关闭检索继续创作，不能把未核实信息写成事实。");
  if (input.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  const retrievedAt = (options.now?.() ?? new Date()).toISOString();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TRAVEL_SEARCH_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("检索已中断", "AbortError"));
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const response = await Promise.race([(options.fetcher ?? fetch)(TRAVEL_SEARCH_ENDPOINT, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `${place} ${input.background ? "背景信息 官方资料" : "旅游 景区 交通 门票 开放时间 官方公告"}`, freshness: "noLimit", summary: false, count: 10 }),
    }), aborted]);
    if (!response.ok) return empty("error", serviceFailure(response.status), retrievedAt);
    const payload = await Promise.race([boundedJSON(response), aborted]) as { code?: unknown; data?: { webPages?: { value?: unknown } } };
    if (payload?.code !== undefined && payload.code !== 200) return empty("error", serviceFailure(typeof payload.code === "number" ? payload.code : 500), retrievedAt);
    const pages = payload?.data?.webPages?.value;
    if (!Array.isArray(pages)) return empty("error", "旅行检索返回的数据不完整；已继续创作，请自行核实具体信息。", retrievedAt);
    const sources: TravelResearch["sources"] = [];
    const seen = new Set<string>();
    for (const page of pages.slice(0, 10) as SearchPage[]) {
      if (!page || typeof page.url !== "string" || page.url.length > 2048 || !isSafeTravelSourceUrl(page.url)) continue;
      const title = text(page.name, 180), snippet = text(page.snippet, 600);
      if (!title || !snippet) continue;
      // Search ranking alone is not evidence of relevance; conservatively require the supplied location.
      const primaryTerm = place.split(/\s+/u)[0];
      const placeTerm = primaryTerm.replace(/(?:特别行政区|自治区|自治州|省|市|县|区)$/u, "").trim() || primaryTerm;
      if (!(title + snippet).includes(placeTerm)) continue;
      const url = new URL(page.url); url.hash = "";
      const cleanUrl = url.toString();
      if (seen.has(cleanUrl)) continue;
      seen.add(cleanUrl);
      const source = url.hostname.toLowerCase();
      const date = typeof page.datePublished === "string" && Number.isFinite(Date.parse(page.datePublished)) ? new Date(page.datePublished).toISOString() : undefined;
      sources.push({ title, url: cleanUrl, source, snippet, ...(date ? { publishedAt: date } : {}) });
      if (sources.length >= MAX_RESULTS) break;
    }
    if (!sources.length) return empty("no_results", "未找到可用的政府、铁路或权威媒体来源；仍可创作，具体信息请自行核实。", retrievedAt);
    const potentialConflict = travelSourcesMayConflict(sources);
    const partial = sources.length < 3 || potentialConflict;
    return {
      status: partial ? "partial" : "success", retrievedAt, sources, potentialConflict, provider:"bocha", query:place, summaryKind:"source_excerpt",
      notice: potentialConflict
        ? "来源摘要中的时间或票价可能有差异，请以最新官方公告核实，不要把冲突数据当作确定事实。"
        : partial
        ? "可靠来源较少，可能缺少相关信息；如来源互相矛盾或数据有变化，请以最新官方公告核实。"
        : "检索摘要仅供参考；如来源互相矛盾或数据有变化，请以最新官方公告核实。",
    };
  } catch (error) {
    if (input.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    void error;
    return empty("error", "旅行检索超时或网络不可用；已继续创作，请自行核实具体信息。", retrievedAt);
  } finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/** Local deployments use the browser even when a legacy Bocha key exists. */
export async function searchTravelInfo(input: { place: string; enabled: boolean; signal?: AbortSignal; background?: boolean; guide?: boolean; wholeDestination?: boolean }): Promise<TravelResearch> {
  return isCloudMode() ? searchBochaTravelInfo(input) : searchBrowserBackground(input);
}

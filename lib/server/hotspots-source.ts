import 'server-only';
import { createHash } from 'node:crypto';
import { HOTSPOT_BOARD, HOTSPOT_SOURCE } from '../hotspot-metadata';
import { selectRelevantHotspots } from '../hotspot-relevance';
import type { Hotspot, HotspotCollection } from './hotspots-types';
import { fetchHotspotSource, HotspotNetworkError } from './hotspots-network';

const MAX_BYTES = 1_000_000;
type SourceCode = 'RESTRICTED' | 'RATE_LIMIT' | 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'FORMAT' | 'EMPTY' | 'TOO_LARGE' | 'DNS' | 'UNSAFE_ADDRESS' | 'TLS' | 'NETWORK_CONFIG';
export class HotspotSourceError extends Error {
  constructor(readonly code: SourceCode, readonly status?: number) { super(code); }
}
export function hotspotSourceErrorMessage(error: unknown): string {
  if (!(error instanceof HotspotSourceError)) return '无法连接百度热搜来源，请稍后重试。';
  switch (error.code) {
    case 'RESTRICTED': return '百度热搜访问受限或要求验证，本工具未绕过限制；请稍后重试。';
    case 'RATE_LIMIT': return '百度热搜暂时限制访问频率，请稍后重试。';
    case 'TIMEOUT': return '等待百度热搜响应超时（12 秒），请稍后重试。';
    case 'HTTP': return `百度热搜返回 HTTP ${error.status}，本次采集未完成。`;
    case 'FORMAT': return '百度热搜页面结构无法识别，需检查来源解析后再更新。';
    case 'EMPTY': return '百度热搜未返回有效条目，本次没有新数据。';
    case 'TOO_LARGE': return '百度热搜响应超出安全大小限制，本次未采用。';
    case 'DNS': return '百度热搜域名解析失败，请检查热点采集的后端 DNS 网络；尚未连接到来源站点。';
    case 'UNSAFE_ADDRESS': return '百度热搜地址解析到了非公网地址，已在网络校验阶段停止请求；请检查热点采集的 DNS／Fake-IP 设置。';
    case 'TLS': return '与百度热搜建立 HTTPS 安全连接失败，请检查热点采集的网络路由或代理；未关闭证书校验。';
    case 'NETWORK_CONFIG': return '热点采集网络配置不可用，请检查所配置的物理网卡是否已连接；未自动改用其他路由。';
    default: return '无法连接百度热搜来源，请检查服务所在环境的网络后重试。';
  }
}
function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim() : '';
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Only accept the source's actual Baidu search link; never follow arbitrary URLs. */
function resultUrl(value: unknown): string | null {
  try {
    const url = new URL(clean(value));
    return url.protocol === 'https:' && url.hostname === 'www.baidu.com' && !url.username && !url.password && !url.port && url.pathname === '/s' && Boolean(url.searchParams.get('wd')) && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export function parseBaiduHotspots(html: string, collectedAt: string): Hotspot[] {
  if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) throw new HotspotSourceError('TOO_LARGE');
  const embedded = html.match(/<!--s-data:\s*([\s\S]*?)\s*-->/u)?.[1];
  if (!embedded) {
    if (/百度安全验证|访问验证|验证码|passport\.baidu\.com/iu.test(html)) throw new HotspotSourceError('RESTRICTED');
    throw new HotspotSourceError('FORMAT');
  }
  let root: Record<string, unknown> | null;
  try { root = record(JSON.parse(embedded)); } catch { throw new HotspotSourceError('FORMAT'); }
  const data = record(root?.data);
  if (root?.tab !== 'realtime' || !Array.isArray(data?.cards)) throw new HotspotSourceError('FORMAT');
  const card = data.cards.map(record).find(value => value?.component === 'hotList');
  if (!Array.isArray(card?.content)) throw new HotspotSourceError('FORMAT');
  const candidates: Hotspot[] = [];
  for (const value of card.content) {
    const row = record(value);
    // Pinned entries are not ordinary ranked results. Missing ranks are never guessed.
    if (!row || row.isTop || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) > 999) continue;
    const title = clean(row.word);
    if (!title || title.length > 180) continue;
    const key = title.normalize('NFKC').toLocaleLowerCase('und');
    candidates.push({
      id: createHash('sha256').update(`baidu:${key}`).digest('hex').slice(0, 24),
      title, description: clean(row.desc).slice(0, 1200),
      url: resultUrl(row.rawUrl) ?? resultUrl(row.url) ?? HOTSPOT_BOARD,
      source: HOTSPOT_SOURCE, publishedAt: null, collectedAt, rank: (row.index as number) + 1,
    });
  }
  const seen = new Set<string>(), ranks = new Set<number>();
  const unique = candidates.sort((a, b) => a.rank - b.rank).filter(item => {
    if (seen.has(item.id) || ranks.has(item.rank)) return false;
    seen.add(item.id); ranks.add(item.rank); return true;
  });
  return unique;
}
/** One fixed public URL, bounded response/time, no cookies, login, retries or redirects. */
export async function fetchBaiduHotspots(now: string, request: typeof fetch = fetchHotspotSource): Promise<Hotspot[]> {
  const signal = AbortSignal.timeout(12_000);
  try {
    const response = await request(HOTSPOT_BOARD, { cache: 'no-store', redirect: 'manual', signal, headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' } });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new HotspotSourceError('RESTRICTED');
    if (response.status === 429) throw new HotspotSourceError('RATE_LIMIT');
    if (!response.ok) throw new HotspotSourceError('HTTP', response.status);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new HotspotSourceError('TOO_LARGE');
    if (!response.body) throw new HotspotSourceError('EMPTY');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) { await reader.cancel(); throw new HotspotSourceError('TOO_LARGE'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let html: string;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new HotspotSourceError('FORMAT'); }
    const items = parseBaiduHotspots(html, now);
    if (!items.length) throw new HotspotSourceError('EMPTY');
    return items;
  } catch (error) {
    if (error instanceof HotspotSourceError) throw error;
    if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) throw new HotspotSourceError('TIMEOUT');
    if (error instanceof HotspotNetworkError) throw new HotspotSourceError(error.code);
    if (error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause && error.cause.code === 'UND_ERR_CONNECT_TIMEOUT') throw new HotspotSourceError('TIMEOUT');
    throw new HotspotSourceError('NETWORK');
  }
}

/** Separate an accessible-but-irrelevant board from a failed/empty source. */
export async function collectBaiduHotspots(now: string, request: typeof fetch = fetchHotspotSource): Promise<HotspotCollection> {
  const candidates=await fetchBaiduHotspots(now,request);
  const items=selectRelevantHotspots(candidates,now);
  return {items,sourceCount:candidates.length,filteredCount:candidates.length-items.length};
}
export function normalizeHotspotCollection(value: Hotspot[] | HotspotCollection): HotspotCollection {
  if (Array.isArray(value)) {
    if (!value.length) throw new HotspotSourceError('EMPTY');
    return {items:value,sourceCount:value.length,filteredCount:0};
  }
  if (!value.sourceCount) throw new HotspotSourceError('EMPTY');
  return value;
}

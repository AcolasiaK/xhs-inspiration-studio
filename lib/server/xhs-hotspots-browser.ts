import { DEFAULT_XHS_RULES, XHS_SORTS, enabledCategoryIds, effectiveRules, type XhsRules } from '../xhs-hotspot-rules';
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { AppError } from '../errors';
import { xhsNoteSchema, type XhsCategory, type XhsCategoryResult, type XhsNote, type XhsProgress } from '../xhs-hotspots';
import { matchesCategory, parseXhsCount, parseXhsPublishedAt, withinWindow } from '../xhs-hotspot-ranking';

import { collectCategory, type CollectionPort } from './xhs-collection-engine';
import { createTopicEnricher } from './xhs-topic-ai';
import { createXhsSearchCursor } from '../xhs-search-cursor';
import { applySearchFiltersCode, cardsCode, guardCode, readSearchCardCode } from './xhs-browser-dom';
export { selectXhsFilterCode } from './xhs-browser-dom';
import { BrowserNavigationBlockedError, BrowserPageTimeoutError, runOpenClawBrowser } from './openclaw-browser';
import { xhsDataDirectory } from './xhs-data-directory';
export { xhsDataDirectory } from './xhs-data-directory';
const actionSignal = new AsyncLocalStorage<AbortSignal>();
const pause = (ms: number) => delay(ms, undefined, { signal: actionSignal.getStore() });
export const xhsCoverDirectory = () => join(xhsDataDirectory(), 'xhs-covers');
async function browser(args: string[]) {
  const signal = actionSignal.getStore() ?? AbortSignal.timeout(45_000);
  try {
    return await runOpenClawBrowser(args, signal);
  } catch (error) {
    actionSignal.getStore()?.throwIfAborted();
    if (error instanceof BrowserNavigationBlockedError) throw new AppError('XHS_NAVIGATION_BLOCKED', error.message, 503);
    if (error instanceof BrowserPageTimeoutError) throw new AppError('XHS_QUERY_TIMEOUT', error.message, 504);
    throw new AppError('XHS_BROWSER', 'OpenClaw 浏览器连接失败。请确认 OpenClaw 网关正在运行，再点击立即更新。', 503);
  }
}
async function evaluate<T>(target: string, code: string): Promise<T> {
  return (await browser(['evaluate', '--target-id', target, '--fn', code])).result as T;
}
type PageState = { blocked: boolean; login: boolean; host: string };
function assertPage(state: PageState) {
  if (state.host !== 'www.xiaohongshu.com') throw new AppError('XHS_BROWSER', '小红书搜索页尚未打开，请检查当前网络后重试。', 503);
  if (state.blocked || state.login) throw new AppError('XHS_LOGIN', '小红书需要登录或安全验证。请在 OpenClaw Chrome 窗口完成后，再点击立即更新；已有结果保留。', 409);
}
async function guard(target: string) { assertPage(await evaluate<PageState>(target, guardCode)); }
type Card = { id: string; title: string; date: string; likes: string; own: boolean; authorId: string | null; top: number };
type Detail = { id: string; title: string; body: string; author: string; authorId: string | null; date: string; tags: string[]; likes: string | null; collects: string | null; comments: string | null; cover: boolean };
async function cover(target: string, id: string, fingerprint: string): Promise<string | null> {
  try {
    const output = await browser(['screenshot', target, '--element', '#noteContainer .swiper-slide-active']);
    const root = resolve(homedir(), '.openclaw/media/browser') + sep;
    if (!output.path || !resolve(output.path).startsWith(root)) return null;
    const image = await readFile(output.path);
    if (image.length > 20_000_000) return null;
    const filename = `${id}-${fingerprint.slice(0, 16)}.jpg`;
    await mkdir(xhsCoverDirectory(), { recursive: true });
    await writeFile(join(xhsCoverDirectory(), filename), await sharp(image).resize({ width: 800, height: 1000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
    return filename;
  } catch { return null; }
}
export type XhsRunContext = { signal?: AbortSignal; cachedNotes?: XhsNote[]; preview?: (category: string, result: XhsCategoryResult) => void };
export type XhsCollector = (now: string, progress: (value: XhsProgress) => void, saveCategory: (category: XhsCategory, result: XhsCategoryResult) => Promise<void>, categories?: XhsCategory[], rules?: XhsRules, context?: XhsRunContext) => Promise<void>;

export function xhsPublicationFilter(days: number) { return days === 1 ? '一天内' : days <= 7 ? '一周内' : '半年内'; }
async function setFilters(target: string, sort: keyof typeof XHS_SORTS, days: number) {
  const wanted = { '排序依据': XHS_SORTS[sort], '发布时间': xhsPublicationFilter(days), '笔记类型': '不限', '搜索范围': '不限', '位置距离': '不限' };
  const result = await evaluate<{ state: PageState; applied?: boolean }>(target, applySearchFiltersCode(wanted));
  assertPage(result.state);
  if (!result.applied) throw new AppError('XHS_FILTER', '小红书排序或时间筛选未能确认生效，本次结果未采用；请重试。', 502);
}

/** Only OpenClaw visible UI; every search verifies the selected high-engagement sort. */
export const collectXhsHotspots: XhsCollector = async (now, progress, saveCategory, requested, config = DEFAULT_XHS_RULES, context = {}) => {
  const categories = requested ?? enabledCategoryIds(config);
  if (!categories.length) return;
  context.signal?.throwIfAborted();
  await actionSignal.run(context.signal ?? new AbortController().signal, () => browser(['start']));
  context.signal?.throwIfAborted();
  const opened = await browser(['open', 'about:blank']);
  const target = opened.targetId;
  if (!target) throw new AppError('XHS_BROWSER', '无法打开小红书采集页面，请检查 OpenClaw。', 503);
  let keepOpen = false;
  try {
    context.signal?.throwIfAborted();
    for (const category of categories) {
      const rules = effectiveRules(config, category);
      let incompleteDetails = 0, openedDetails = 0, attempted = 0, needsRecoveryCheck = false;
      const port: CollectionPort = {
        async *search(task, signal) {
          signal.throwIfAborted();
          try {
          if (needsRecoveryCheck) { await guard(target); needsRecoveryCheck = false; }
          await browser(['navigate', 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(task.query), '--target-id', target]);
          await setFilters(target, task.sort, task.windowDays ?? rules.windowDays);
          const cursor = createXhsSearchCursor(task.offset, task.processedIds), maxScrolls = Math.ceil((task.offset || 0) / 5) + rules.scrollsPerQuery + 2;
          let firstAvailablePage: number | null = null, stalledPages = 0;
          for (let page = 0; page <= maxScrolls; page++) {
            signal.throwIfAborted();
            if (page) { await evaluate(target, `() => {window.scrollTo(0,document.documentElement.scrollHeight);return true;}`); await pause(1100); await guard(target); }
            let cards = await evaluate<Card[]>(target, cardsCode);
            if (!cards.length && page === 0) { await pause(2200); await guard(target); cards = await evaluate<Card[]>(target, cardsCode); }
            if (!cards.length && page === 0) {
              const empty = await evaluate<boolean>(target, `() => /没有找到|暂无相关|没有相关|无搜索结果/.test(document.body.innerText)`);
              if (!empty) throw new AppError('XHS_SEARCH_EMPTY_LOAD', '本关键词的搜索结果暂未加载，将在剩余预算内重试。', 502);
              yield []; return;
            }
            const next = cursor.take(cards);
            stalledPages = next.discovered ? 0 : stalledPages + 1;
            if (next.cards.length && firstAvailablePage === null) firstAvailablePage = page;
            for (let i = 0; i < next.cards.length; i += rules.cardsPerQuery) yield next.cards.slice(i, i + rules.cardsPerQuery);
            if (stalledPages >= 2 || (firstAvailablePage !== null && page - firstAvailablePage >= rules.scrollsPerQuery)) break;
          }
          // The iterator also closes when inspection fails. Check the existing page
          // before the next navigation so recovery cannot dismiss a security checkpoint.
          } finally { needsRecoveryCheck = true; }
        },
        async inspect(card, task, signal) {
          signal.throwIfAborted(); attempted++;
          const entry = await evaluate<{ state: PageState; clicked?: boolean; detail?: Detail }>(target, readSearchCardCode(card.id));
          assertPage(entry.state);
          if (!entry.clicked) return { reason: 'unavailable' };
          openedDetails++;
          try {
            signal.throwIfAborted();
            const detail = entry.detail;
            if (detail && !detail.title) detail.title = card.title;
            if (!detail || detail.id !== card.id || !detail.title || !detail.date || detail.likes === null || detail.collects === null || detail.comments === null) {
              incompleteDetails++;
              if (incompleteDetails >= 3) throw new AppError('XHS_LAYOUT', '连续多篇笔记详情未完整加载，已停止；上次结果保留。', 502);
              return { reason: 'unavailable' };
            }
            incompleteDetails = 0;
            const publishedAt = parseXhsPublishedAt(detail.date, now);
            const likes = parseXhsCount(detail.likes), collects = parseXhsCount(detail.collects), comments = parseXhsCount(detail.comments);
            if (!publishedAt) return { reason: 'unknownDate' };
            if (!withinWindow(publishedAt, now, rules.windowDays)) return { reason: 'outsideWindow' };
            if (likes === null || collects === null || comments === null) return { reason: 'invalidCounts' };
            if (!matchesCategory(detail, category, rules)) return { reason: 'irrelevant' };
            const body = detail.body.slice(0, 14000), tags = detail.tags.map(t => t.slice(0, 80));
            const fingerprint = createHash('sha256').update(JSON.stringify([detail.title, body, tags, likes, collects, comments])).digest('hex');
            const previous = context.cachedNotes?.find(n => n.id === card.id && n.fingerprint === fingerprint);
            const coverFile = previous?.coverFile || (detail.cover && likes + collects + comments >= rules.categories[category].minInteractions ? await cover(target, card.id, fingerprint) : null);
            return { note: xhsNoteSchema.parse({ id: card.id, title: detail.title.slice(0, 300), author: detail.author.slice(0, 100), authorId: detail.authorId || card.authorId || null, url: `https://www.xiaohongshu.com/explore/${card.id}`, category, query: task.query, body, tags, publishedAt, dateLabel: detail.date.slice(0, 100), collectedAt: new Date().toISOString(), likes, collects, comments, coverUrl: null, coverFile, fingerprint }) };
          } finally {
            // Do not dismiss or work around a login/security checkpoint.
            // A timed-out keyword is recovered by the next task's fresh navigation.
            if (signal.aborted) needsRecoveryCheck = true;
            else {
              const result = await evaluate<{ state: PageState; closed?: boolean }>(target, `() => {
                const state=(${guardCode})(); if(state.host!=='www.xiaohongshu.com'||state.blocked||state.login)return {state};
                const close=document.querySelector('.note-detail-mask .close-circle'); close?.click(); return {state,closed:!!close}; }`);
              assertPage(result.state);
              if (!result.closed) throw new AppError('XHS_LAYOUT', '笔记详情无法返回搜索列表，请重试；已有结果保留。', 502);
              await pause(350);
            }
          }
        },
      };
      const cancellablePort: CollectionPort = {
        async *search(task, signal) { const iterator = port.search(task, signal); try { while (true) { const next = await actionSignal.run(signal, () => iterator.next()); if (next.done) break; yield next.value; } } finally { await iterator.return(undefined); } },
        inspect: (card, task, signal) => actionSignal.run(signal, () => port.inspect(card, task, signal)),
      };
      const result = await collectCategory(category, config, now, cancellablePort, progress, { ...context, enrich: createTopicEnricher(config, category, join(xhsDataDirectory(), 'xhs-topic-cache')) });
      if (attempted && !openedDetails) throw new AppError('XHS_LAYOUT', '候选笔记均无法进入详情，本次采集未完成；已有结果保留。', 502);
      await saveCategory(category, result);
    }
  } catch (error) { keepOpen = error instanceof AppError && error.code === 'XHS_LOGIN'; throw error; }
  finally { if (!keepOpen) await browser(['close', target]).catch(() => undefined); }
};

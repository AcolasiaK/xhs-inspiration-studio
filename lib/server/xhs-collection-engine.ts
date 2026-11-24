import { themeSearchRules, categoryName, XHS_MIN_THEME_TARGET, type XhsRules } from '../xhs-hotspot-rules';
import { matchesCategory, rankQualifiedXhsThemes, withinWindow } from '../xhs-hotspot-ranking';
import type { XhsCategoryResult, XhsCollectionStats, XhsKeywordCoverage, XhsNote, XhsProgress, XhsSearchCoverage } from '../xhs-hotspots';
import type { SemanticResult } from './xhs-topic-ai';
export type XhsCandidate = { id: string; title: string; date: string; likes: string; own: boolean; authorId: string | null; top: number };
export type SearchTask = { query: string; sort: XhsRules['searchSorts'][number]; supplemental: boolean; windowDays?: number; offset?: number; processedIds?: string[] };
type Exclusion = 'unavailable' | 'unknownDate' | 'outsideWindow' | 'irrelevant' | 'invalidCounts';
export type Inspection = { note: XhsNote } | { reason: Exclusion };
export type CollectionPort = { search(task: SearchTask, signal: AbortSignal): AsyncGenerator<XhsCandidate[]>; inspect(card: XhsCandidate, task: SearchTask, signal: AbortSignal): Promise<Inspection> };
type Enricher = ((notes: XhsNote[], signal: AbortSignal) => Promise<SemanticResult>) & { getStatus?: () => { calls: number; warnings: string[] } };
export type CollectionContext = {
 signal?: AbortSignal; cachedNotes?: XhsNote[];
 preview?: (category: string, result: XhsCategoryResult) => void;
 enrich?: Enricher;
 /** Optional lower limits for tests/hosts; these never extend the category deadline. */
 scheduler?: { taskTimeoutMs?: number; groupingTimeoutMs?: number; groupingBudgetMs?: number };
};
type Source = SearchTask & { offset: number; consumed: Set<string>; exhausted: boolean; failures: number };
type Keyword = { coverage: XhsKeywordCoverage; sources: Source[]; nextSort: number; candidateIds: Set<string>; gain: number; gainIds: Set<string>; baselineThemeIds: Set<string>; supplementalCount: number; failures: number };
const normalizedQuery = (query: string) => query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('und');
const bounded = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? Math.min(value!, fallback) : fallback;
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
 return new Promise((resolve, reject) => {
  const abort = () => { cleanup(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener('abort', abort);
  promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
 });
}
/** Rotate small slices across keywords before deeper searches; every budget belongs to the whole run. */
export async function collectCategory(category: string, config: XhsRules, now: string, port: CollectionPort, progress: (p: XhsProgress) => void, context: CollectionContext = {}): Promise<XhsCategoryResult> {
 const rules = themeSearchRules(config, category), gate = rules.categories[category];
 const started = Date.now(), totalMs = (rules.maxMinutes ?? 20) * 60_000, deadline = AbortSignal.timeout(totalMs);
 const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
 const cached = new Map((context.cachedNotes || []).map(note => [note.id, note]));
 const seen = new Set<string>(), handled = new Set<string>(), notes = new Map<string, XhsNote>(), authors = new Set<string>();
 const ownerById = new Map<string, Keyword>();
 const stats: XhsCollectionStats = { detailsAttempted: 0, own: 0, unavailable: 0, unknownDate: 0, outsideWindow: 0, irrelevant: 0, invalidCounts: 0, uncheckedCandidates: 0 };
 const queries = new Set<string>(), uniqueQueries = new Map<string, string>(), supplementUses = new Map<string, number>();
 for (const query of gate.queries) if (!uniqueQueries.has(normalizedQuery(query))) uniqueQueries.set(normalizedQuery(query), query.trim().replace(/\s+/g, ' '));
 const makeSource = (query: string, sort: SearchTask['sort'], supplemental = false, windowDays = rules.windowDays): Source => ({ query, sort, supplemental, windowDays, offset: 0, consumed: new Set(), exhausted: false, failures: 0 });
 const initialSources = (query: string) => {
  const sources = [makeSource(query, rules.searchSorts[0], false, Math.min(7, rules.windowDays)), makeSource(query, 'latest'), ...rules.searchSorts.map(sort => makeSource(query, sort))];
  return sources.filter((source, index) => sources.findIndex(other => other.sort === source.sort && other.windowDays === source.windowDays) === index);
 };
 const keywords: Keyword[] = [...uniqueQueries.values()].map(query => ({
  coverage: { query, status: 'pending', basicCovered: false, searches: 0, completedSearches: 0, candidates: 0, inspected: 0, newNotes: 0, newAuthors: 0, matchedNotes: 0, elapsedMs: 0, reason: null, sorts: [] },
  sources: initialSources(query), nextSort: 0, candidateIds: new Set(), gain: 0, gainIds: new Set(), baselineThemeIds: new Set(), supplementalCount: 0, failures: 0,
 }));
 let phase: XhsSearchCoverage['phase'] = 'basic', searches = 0, cacheHits = 0, firstResultMs: number | null = null, aiCalls = 0;
 let warnings: string[] = [], stopReason = '已完成搜索覆盖', noNewRounds = 0, expansionRounds = 0, browserRecoveries = 0, closed = false;
 let aiJob: Promise<void> | null = null, aiAbort: AbortController | null = null, aiElapsedMs = 0;
 const cancelEnrichment = () => aiAbort?.abort();
 const finishEnrichment = async () => { cancelEnrichment(); if (aiJob) await aiJob; };
 const aiHandled = new Set<string>();
 const remainingMs = () => Math.max(0, totalMs - (Date.now() - started));
 const detailCount = () => stats.detailsAttempted + cacheHits;
 const reached = () => detailCount() >= rules.detailBudget || seen.size >= rules.candidateBudget || signal.aborted || remainingMs() <= 0;
 const rank = () => rankQualifiedXhsThemes([...notes.values()], category, now, rules);
 const effectiveNotes = () => [...notes.values()].filter(note => withinWindow(note.publishedAt, now, rules.windowDays) && matchesCategory(note, category, rules));
 // AI scope decisions can revoke a contribution without deleting its source record.
 const refreshContributions = (themes = rank().themes) => {
  const valid = effectiveNotes(), validIds = new Set(valid.map(note => note.id)); authors.clear();
  for (const keyword of keywords) { keyword.coverage.newNotes = 0; keyword.coverage.newAuthors = 0; keyword.gain = 0; }
  for (const note of valid) {
   const owner = ownerById.get(note.id);
   if (owner) { owner.coverage.newNotes++; if (owner.gainIds.has(note.id)) owner.gain++; }
   if (note.authorId && !authors.has(note.authorId)) {
    authors.add(note.authorId);
    if (owner) { owner.coverage.newAuthors++; if (owner.gainIds.has(note.id)) owner.gain += 2; }
   }
  }
  for (const keyword of keywords) {
   keyword.coverage.matchedNotes = [...keyword.candidateIds].filter(id => validIds.has(id)).length;
   keyword.gain += 3 * themes.filter(theme => !keyword.baselineThemeIds.has(theme.id) && theme.noteIds.some(id => validIds.has(id) && keyword.gainIds.has(id))).length;
  }
  return validIds;
 };
 const semanticStatus = () => { const status = context.enrich?.getStatus?.(); if (status) { aiCalls = Math.max(aiCalls, status.calls); warnings = [...new Set([...warnings, ...status.warnings])]; } };
 const result = (finished: boolean): XhsCategoryResult => {
  semanticStatus();
  const ranking = rank();
  refreshContributions(ranking.themes);
  if (firstResultMs === null && (ranking.themes.length || ranking.singleNoteIds.length)) firstResultMs = Date.now() - started;
  const coverage: XhsSearchCoverage = { version: 1, phase: finished ? 'finished' : phase, completed: keywords.filter(k => k.coverage.basicCovered).length, total: keywords.length, keywords: keywords.map(k => ({ ...k.coverage, sorts: [...k.coverage.sorts] })) };
  const found = ranking.themes.length + ranking.candidateThemes.length, met = found >= XHS_MIN_THEME_TARGET;
  return { ...ranking, rankingVersion: 3, notes: [...notes.values()], candidateCount: seen.size, excludedCount: stats.own + stats.unavailable + stats.unknownDate + stats.outsideWindow + stats.irrelevant + stats.invalidCounts, collectionStats: { ...stats, uncheckedCandidates: seen.size - handled.size }, queries: [...queries].slice(0, 60), collectedAt: now, attemptedAt: now, error: null,
   run: { startedAt: new Date(started).toISOString(), finishedAt: finished ? new Date().toISOString() : null, firstResultMs, elapsedMs: Date.now() - started, stopReason: finished ? `${!met ? `选题不足 ${XHS_MIN_THEME_TARGET} 个（已找到 ${found} 个）；` : ''}${ranking.candidateThemes.length ? `含 ${ranking.candidateThemes.length} 个待验证选题；` : ''}${stopReason}` : phase === 'basic' ? '首轮关键词覆盖中，排名暂定' : phase === 'grouping' ? '有限等待主题归并，排名暂定' : '轮询追加中，排名暂定', searches, cacheHits, aiCalls, warnings: warnings.slice(0, 20), coverage,
    themeTarget: { minimum: XHS_MIN_THEME_TARGET, found, status: met ? 'met' : finished ? 'shortfall' : 'searching' } } };
 };
 const publish = () => { if (!closed) context.preview?.(category, result(false)); };
 const addMatch = (id: string, query: string) => {
  const note = notes.get(id);
  if (note) notes.set(id, { ...note, matchedQueries: [...new Set([...(note.matchedQueries || [note.query]), query])].slice(0, 40) });
 };
 const accept = (note: XhsNote, keyword: Keyword, task: SearchTask) => {
  const first = !notes.has(note.id), original = notes.get(note.id);
  notes.set(note.id, { ...note, category, query: original?.query || note.query || task.query, matchedQueries: [...new Set([...(original?.matchedQueries || []), ...(note.matchedQueries || []), original?.query || note.query || task.query, task.query, keyword.coverage.query])].slice(0, 40) });
  if (first) {
   ownerById.set(note.id, keyword); keyword.gainIds.add(note.id);
  }
  refreshContributions();
 };
 // Balanced sampling prevents the earliest keyword from monopolizing semantic calls.
 const scheduleEnrichment = () => {
  if (!context.enrich || phase === 'basic' || aiJob || signal.aborted) return;
  const budget = bounded(context.scheduler?.groupingBudgetMs, Math.min(180_000, totalMs * .2));
  const allowance = Math.min(budget - aiElapsedMs, bounded(context.scheduler?.groupingTimeoutMs, 90_000), remainingMs() * .2);
  if (allowance < 1) return;
  const chosen: XhsNote[] = [], selected = new Set<string>();
  const pools = keywords.map(k => [...k.candidateIds].map(id => notes.get(id)).filter((n): n is XhsNote => Boolean(n && !aiHandled.has(n.id) && n.likes + n.collects + n.comments > 0)));
  for (let at = 0; chosen.length < 16 && pools.some(pool => pool.length > at); at++) for (const pool of pools) {
   const note = pool[at]; if (note && !selected.has(note.id) && chosen.length < 16) { selected.add(note.id); chosen.push(note); }
  }
  if (!chosen.length) return;
  chosen.forEach(note => aiHandled.add(note.id));
  const controller = new AbortController(), jobStarted = Date.now(); aiAbort = controller;
  const jobSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(allowance)))]);
  aiJob = (async () => {
   try {
    const enriched = await abortable(context.enrich!(chosen, jobSignal), jobSignal);
    if (closed || jobSignal.aborted) return;
    for (const note of enriched.notes) {
     const current = notes.get(note.id);
     if (current && selected.has(note.id)) notes.set(note.id, { ...current, ...note, query: current.query, matchedQueries: current.matchedQueries });
    }
    refreshContributions();
    aiCalls = Math.max(aiCalls, enriched.calls); warnings = [...new Set([...warnings, ...enriched.warnings])];
   } catch {
    if (!signal.aborted) warnings = [...new Set([...warnings, 'AI 归并未在本轮分配的时间内完成或暂不可用；已保留词表结果，搜索继续。'])];
   } finally { aiElapsedMs += Date.now() - jobStarted; semanticStatus(); aiJob = null; aiAbort = null; publish(); }
  })();
 };
 const runSlice = async (keyword: Keyword, source: Source) => {
  const coverage = keyword.coverage, taskStarted = Date.now(), unseen = keywords.filter(k => !k.coverage.basicCovered && k !== keyword).length;
  const reserve = unseen;
  const detailQuota = Math.max(1, Math.min(3, rules.detailBudget - detailCount() - reserve));
  const candidateQuota = Math.max(1, Math.min(rules.cardsPerQuery, Math.floor((rules.candidateBudget - seen.size) / Math.max(1, reserve + 1))));
  const sliceMs = Math.max(1, Math.floor(Math.min(bounded(context.scheduler?.taskTimeoutMs, 120_000), remainingMs() / Math.max(1, reserve + 1))));
  const sliceDeadline = AbortSignal.timeout(sliceMs), sliceSignal = AbortSignal.any([signal, sliceDeadline]);
  const task: SearchTask = { query: source.query, sort: source.sort, supplemental: source.supplemental, windowDays: source.windowDays, offset: source.offset, processedIds: [...source.consumed] };
  keyword.gainIds = new Set(); keyword.baselineThemeIds = new Set(rank().themes.map(theme => theme.id)); refreshContributions();
  let localDetails = 0, localCandidates = 0, processed = 0, completedProcessing = 0, received = false, sawCards = false, stoppedEarly = false;
  coverage.status = 'searching'; coverage.reason = null; coverage.searches++; searches++; queries.add(task.query);
  if (!coverage.sorts.includes(task.sort)) coverage.sorts.push(task.sort);
  progress({ category, current: keywords.filter(k => k.coverage.basicCovered).length, total: keywords.length, message: `${categoryName(config, category)}：${phase === 'basic' ? '首轮搜索' : task.supplemental ? '定向补搜' : '轮询追加'} ${task.query} · 已覆盖 ${keywords.filter(k => k.coverage.basicCovered).length}/${keywords.length} 个关键词` });
  publish();
  try {
   scan: for await (const cards of port.search(task, sliceSignal)) {
    sliceSignal.throwIfAborted(); received = true; sawCards ||= cards.length > 0;
    for (const card of cards) {
     sliceSignal.throwIfAborted();
     // Once a slow first item has completed, hand off before starting another one.
     if (completedProcessing > 0 && Date.now() - taskStarted >= sliceMs / 2) { stoppedEarly = true; break scan; }
     if (source.consumed.has(card.id)) continue;
     if (localDetails >= detailQuota || localCandidates >= candidateQuota || reached()) { stoppedEarly = true; break scan; }
     source.consumed.add(card.id); source.offset++; processed++;
     keyword.candidateIds.add(card.id); coverage.candidates = keyword.candidateIds.size;
     if (!seen.has(card.id)) { seen.add(card.id); localCandidates++; }
     addMatch(card.id, coverage.query); addMatch(card.id, task.query);
     if (handled.has(card.id)) { completedProcessing++; continue; }
     handled.add(card.id);
     if (card.own) { stats.own++; completedProcessing++; continue; }
     localDetails++; coverage.inspected++;
     const old = cached.get(card.id), age = old ? Date.parse(now) - Date.parse(old.collectedAt) : Infinity;
     if (old && age >= 0 && age < (rules.cacheMinutes ?? 60) * 60_000 && withinWindow(old.publishedAt, now, rules.windowDays) && matchesCategory(old, category, rules)) {
      cacheHits++; accept(old, keyword, task);
     } else {
      stats.detailsAttempted++;
      try {
       const inspection = await port.inspect(card, task, sliceSignal);
       sliceSignal.throwIfAborted();
       if ('reason' in inspection) stats[inspection.reason]++; else accept(inspection.note, keyword, task);
      } catch (error) {
       stats.unavailable++;
       if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'XHS_BROWSER' && browserRecoveries < 2 && !signal.aborted && !notes.has(card.id)) {
        // Keep the failed attempt in the budget, but permit evidence to be read
        // on the next healthy search instead of marking it permanently handled.
        handled.delete(card.id); source.consumed.delete(card.id); source.offset--;
       }
       throw error;
      }
     }
     completedProcessing++;
     publish();
    }
   }
   sliceSignal.throwIfAborted();
   if (!stoppedEarly) source.exhausted = true;
   coverage.completedSearches++;
   if (processed || (received && !sawCards && !stoppedEarly)) coverage.basicCovered = true;
   coverage.status = coverage.basicCovered ? keyword.candidateIds.size ? 'covered' : 'empty' : 'partial';
   coverage.reason = coverage.status === 'empty' ? '已确认本次搜索无结果' : coverage.basicCovered ? null : '未取得可检查的搜索结果';
   source.failures = 0;
  } catch (error) {
   source.failures++; keyword.failures++;
   const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
   const retryConnection = code === 'XHS_BROWSER' && !signal.aborted && browserRecoveries < 2;
   if (retryConnection) { browserRecoveries++; warnings = [...new Set([...warnings, '浏览器连接暂时失败，保留已核验内容并有限重试（本轮最多 2 次）；登录或安全验证仍立即停止。'])]; }
   const fatal = ['XHS_LOGIN', 'XHS_LAYOUT', 'XHS_FILTER'].includes(String(code)) || code === 'XHS_BROWSER' && !retryConnection;
   const recoverable = !signal.aborted && !fatal && (retryConnection || sliceDeadline.aborted || code === 'XHS_QUERY_TIMEOUT' || code === 'XHS_SEARCH_EMPTY_LOAD');
   coverage.status = coverage.basicCovered || processed ? 'partial' : 'interrupted';
   coverage.reason = signal.aborted ? '本轮已中止，未完成当前搜索' : retryConnection ? '浏览器连接暂时失败，下一次搜索先复核页面状态再重试' : recoverable ? keyword.failures >= 3 ? '本词局部失败已达重试上限，保留已有结果' : '本词超时或暂未加载，先搜索其他词，之后有限重试' : '本轮遇到浏览器或页面异常，搜索已停止';
   if (source.failures >= 3) source.exhausted = true;
   if (!recoverable) { publish(); throw error; }
  } finally {
   coverage.elapsedMs += Date.now() - taskStarted;
   refreshContributions();
   publish();
  }
 };
 const nextSource = (keyword: Keyword): Source | undefined => {
  if (keyword.failures >= 3) return undefined;
  if (!keyword.coverage.basicCovered && !keyword.sources[0].exhausted) return keyword.sources[0];
  for (let tries = 0; tries < keyword.sources.length; tries++) {
   const index = keyword.nextSort++ % keyword.sources.length, source = keyword.sources[index];
   if (!source.exhausted) return source;
  }
  return undefined;
 };
 const addSupplement = (keyword: Keyword): Source | undefined => {
  if (!keyword.coverage.basicCovered || keyword.failures >= 3 || keyword.supplementalCount >= XHS_MIN_THEME_TARGET) return undefined;
  const directions = [...new Set([...rank().diagnostics.rejectedThemes.sort((a, b) => b.authors - a.authors || b.notes - a.notes).map(t => t.title), ...gate.topics.map(t => t.name)])]
   .sort((a, b) => (supplementUses.get(normalizedQuery(a)) || 0) - (supplementUses.get(normalizedQuery(b)) || 0));
  for (const direction of directions) {
   const query = `${keyword.coverage.query} ${direction.replace(/ · /g, ' ')}`.slice(0, 80);
   if (keyword.sources.some(s => normalizedQuery(s.query) === normalizedQuery(query))) continue;
   const source = makeSource(query, keyword.supplementalCount % 2 ? 'latest' : rules.searchSorts[0], true);
   supplementUses.set(normalizedQuery(direction), (supplementUses.get(normalizedQuery(direction)) || 0) + 1);
   keyword.supplementalCount++; keyword.sources.push(source); return source;
  }
  return undefined;
 };
 const settleStatuses = (reason: string) => {
  for (const { coverage } of keywords) {
   if (coverage.status === 'searching') coverage.status = coverage.basicCovered ? 'partial' : 'interrupted';
   if (!coverage.basicCovered && !coverage.reason) coverage.reason = reason;
  }
 };
 try {
  // A single sorting method per keyword comes before any second sorting pass.
  for (const keyword of keywords) {
   signal.throwIfAborted(); if (reached()) break;
   await runSlice(keyword, keyword.sources[0]); keyword.nextSort = 1;
  }
  phase = 'expand'; publish(); scheduleEnrichment();
  while (!reached()) {
   expansionRounds++;
   const beforeNotes = refreshContributions(), beforeAuthors = new Set(authors), beforeThemes = new Set(rank().themes.map(t => t.id));
   const order = [...keywords].sort((a, b) => Number(a.coverage.basicCovered) - Number(b.coverage.basicCovered) || b.gain - a.gain);
   let attempted = 0, wholeRound = true;
   for (const keyword of order) {
    signal.throwIfAborted(); if (reached()) { wholeRound = false; break; }
    const needsThemes = rank().themes.length < XHS_MIN_THEME_TARGET;
    // Targeted searches must get a turn even when broad result pools are never exhausted.
    const source = (needsThemes && expansionRounds % 2 === 0 ? addSupplement(keyword) : undefined) || nextSource(keyword) || addSupplement(keyword); if (!source) continue;
    attempted++; await runSlice(keyword, source); scheduleEnrichment();
   }
   if (!attempted) {
    // A pending batch may discover new supplemental directions or revoke provisional themes.
    if (aiJob) { phase = 'grouping'; publish(); await aiJob; phase = 'expand'; noNewRounds = 0; continue; }
    stopReason = '当前范围已无可用追加或补搜方向'; break;
   }
   if (!wholeRound || reached()) break;
   const afterNotes = refreshContributions();
   const gained = [...afterNotes].some(id => !beforeNotes.has(id)) || [...authors].some(id => !beforeAuthors.has(id)) || rank().themes.some(t => !beforeThemes.has(t.id));
   noNewRounds = gained ? 0 : noNewRounds + 1;
   if (!aiJob && rank().themes.length >= XHS_MIN_THEME_TARGET && noNewRounds >= (rules.noNewRounds ?? 2)) { stopReason = '已达到至少 5 个主题，连续整轮搜索未增加有效笔记、作者或主题'; break; }
  }
  if (signal.aborted) signal.throwIfAborted();
 } catch (error) {
  if (context.signal?.aborted || !deadline.aborted) {
   stopReason = context.signal?.aborted ? '用户已停止本轮搜索' : '浏览器或页面异常，搜索未完成';
   settleStatuses(stopReason); await finishEnrichment(); phase = 'finished'; publish(); closed = true;
   if (context.signal?.aborted) throw context.signal.reason;
   throw error;
  }
 }
 if (deadline.aborted || remainingMs() <= 0) stopReason = '已达到本类最长检索时间';
 else if (detailCount() >= rules.detailBudget) stopReason = '已达到详情核验预算';
 else if (seen.size >= rules.candidateBudget) stopReason = '已达到候选预算';
 settleStatuses(stopReason);
 // Finish an already-running semantic batch only within a small explicit grace period.
 if (!signal.aborted) scheduleEnrichment();
 if (aiJob) {
  phase = 'grouping'; publish();
  const grace = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(Math.min(remainingMs(), bounded(context.scheduler?.groupingTimeoutMs, 5_000)))))]);
  await abortable(aiJob, grace).catch(() => undefined); await finishEnrichment();
 }
 semanticStatus();
 if (context.signal?.aborted) {
  stopReason = '用户已停止本轮搜索'; settleStatuses(stopReason); phase = 'finished'; publish(); closed = true;
  throw context.signal.reason;
 }
 if (deadline.aborted || remainingMs() <= 0) stopReason = '已达到本类最长检索时间';
 phase = 'finished'; publish(); closed = true;
 return result(true);
}

import { defaultRulesVersion, getXhsRulesStore } from './xhs-hotspot-rules-store';
import { describeXhsRules, enabledCategoryIds, effectiveRules, themeSearchRules, xhsCategoryIdSchema, type XhsRulesVersion } from '../xhs-hotspot-rules';
import 'server-only';
import { mkdir, open, readFile, rename, unlink, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { beijingDate, blankCategory, categoryResultSchema, isoDate, savedAnalysisSchema, XHS_CATEGORY_KEYS, type XhsAnalysis, type XhsCategoryResult, type XhsCategory, type XhsHotspotState, type XhsNote, type XhsProgress } from '../xhs-hotspots';
import { collectXhsHotspots, xhsDataDirectory, type XhsCollector } from './xhs-hotspots-browser';
import { analyzeXhsNote } from './xhs-hotspots-ai';
import type { AiSource } from './ai-source';
import { rankQualifiedXhsThemes } from '../xhs-hotspot-ranking';

const savedSchema = z.object({ version: z.literal(2), categories: z.record(xhsCategoryIdSchema, categoryResultSchema), previews: z.record(xhsCategoryIdSchema, categoryResultSchema).optional(), analyses: z.record(z.string(), savedAnalysisSchema), lastAttemptAt: isoDate.nullable(), lastSuccessAt: isoDate.nullable(), error: z.string().max(500).nullable() });
type Saved = z.infer<typeof savedSchema>;
const blank = (): Saved => ({ version: 2, categories: { travel: blankCategory(), wedding: blankCategory(), daily: blankCategory() }, analyses: {}, lastAttemptAt: null, lastSuccessAt: null, error: null });
type Dependencies = { readRules?: () => Promise<XhsRulesVersion>; file: string; now: () => Date; collect: XhsCollector; analyze: (note: XhsNote, source: AiSource, signal?: AbortSignal) => Promise<XhsAnalysis> };
type Lease = { pid: number; token: string; kind: 'update' | 'analyze'; noteId?: string; categories?: XhsCategory[] };
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
export class XhsHotspotsStore {
  private saved: Saved = blank();
  private progress: XhsProgress | null = null;
  private pending: Promise<void> | null = null;
  private updatingCategories: XhsCategory[] = [];
  private analyzing = new Set<string>();
  private starting = false;
  private previews: Record<string, XhsCategoryResult> = {};
  private collecting = false;
  private cancelUpdate: AbortController | null = null;
  private writes: Promise<void> = Promise.resolve();
  private runtimeError: string | null = null;
  scheduler = false;
  constructor(private deps: Dependencies) {}
  private async load() {
    try { const text = await readFile(this.deps.file, 'utf8'); if (text.length > 15_000_000) throw new Error(); this.saved = savedSchema.parse(JSON.parse(text)); this.previews = this.saved.previews || {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('XHS_CACHE', '热点缓存无法读取，原文件保留且不会覆盖。请检查本机存储后重试。', 503); }
  }
  private async persist() {
    const operation = this.writes.then(async () => {
      const previews = Object.fromEntries(Object.entries(this.previews).filter(([, result]) => result.error || result.run?.finishedAt));
      const value = savedSchema.parse({ ...this.saved, previews }), serialized = JSON.stringify(value);
      if (serialized.length > 15_000_000) throw new AppError('XHS_STORAGE_LIMIT', '热点与拆解缓存已达到容量上限，本次结果未覆盖原文件。', 503);
      await mkdir(dirname(this.deps.file), { recursive: true });
      const temporary = `${this.deps.file}.${randomUUID()}.tmp`;
      try {
        await copyFile(this.deps.file, this.deps.file + '.before-dynamic', 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e; });
        await writeFile(temporary, serialized, { mode: 0o600 }); await rename(temporary, this.deps.file);
      } catch { await unlink(temporary).catch(() => undefined); throw new AppError('XHS_STORAGE', '热点结果无法保存，请检查本机存储。上次已保存结果保留。', 503); }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private async lease(): Promise<Lease | null> {
    try { const data = JSON.parse(await readFile(`${this.deps.file}.lock`, 'utf8')) as Lease; return Number.isInteger(data.pid) && alive(data.pid) ? data : null; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AppError('XHS_LOCK', '热点任务锁无法读取，请检查服务状态后重试。', 503); }
  }
  private async acquire(kind: Lease['kind'], noteId?: string, categories?: XhsCategory[]): Promise<() => Promise<void>> {
    await mkdir(dirname(this.deps.file), { recursive: true });
    const path = `${this.deps.file}.lock`, value = { pid: process.pid, token: randomUUID(), kind, noteId, categories };
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value)); } finally { await handle.close(); } return async () => { if ((await this.lease())?.token === value.token) await unlink(path); }; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (await this.lease()) throw new AppError('XHS_BUSY', '热点任务正在运行，请等待采集或拆解完成后重试。', 409);
        await unlink(path).catch(() => undefined);
      }
    }
    throw new AppError('XHS_BUSY', '热点任务正在启动，请稍后重试。', 409);
  }
  private rules() { return this.deps.readRules?.() ?? Promise.resolve(defaultRulesVersion()); }
  async state(): Promise<XhsHotspotState> {
    if (!this.pending && !this.starting && !this.analyzing.size) await this.load();
    const lease = await this.lease(), configuredRules = await this.rules();
    for (const id of Object.keys(configuredRules.rules.categories)) this.saved.categories[id] ??= blankCategory();
    return { ...structuredClone(this.saved), previews: structuredClone(this.previews), error: this.runtimeError || this.saved.error, updating: Boolean(this.pending || this.starting || lease?.kind === 'update'), updatingCategories: [...(this.updatingCategories.length ? this.updatingCategories : lease?.kind === 'update' ? lease.categories || XHS_CATEGORY_KEYS : [])], progress: this.progress, analyzing: [...new Set([...this.analyzing, ...(lease?.kind === 'analyze' && lease.noteId ? [lease.noteId] : [])])], scheduler: this.scheduler && enabledCategoryIds(configuredRules.rules).some(id => effectiveRules(configuredRules.rules, id).autoUpdate), storage: 'disk', ordering: describeXhsRules(configuredRules.rules), configuredRules };
  }
  /** Return immediately; collection outlives the HTTP request, with read-only progress polling. */
  async regroup(requested?: XhsCategory[]): Promise<XhsHotspotState> {
    if (this.pending || this.starting || this.analyzing.size) throw new AppError('XHS_BUSY', '热点采集或拆解正在运行，请完成后重新归纳。', 409);
    this.starting = true;
    let release: (() => Promise<void>) | undefined;
    try {
      const ruleSnapshot = structuredClone(await this.rules()), enabled = enabledCategoryIds(ruleSnapshot.rules);
      const categories = [...new Set(requested ?? enabled)];
      if (!categories.length || categories.some(id => !enabled.includes(id))) throw new AppError('INVALID_FORM', '请选择有效的热点分类。', 400);
      release = await this.acquire('update', undefined, categories); await this.load();
      const previous = structuredClone(this.saved), now = this.deps.now().toISOString();
      await copyFile(this.deps.file, this.deps.file + '.before-topics-v3', 1).catch(e => { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e; });
      try {
        for (const id of categories) {
          const current = this.saved.categories[id];
          if (!current?.collectedAt) continue;
          const rules = current.run?.themeTarget ? themeSearchRules(ruleSnapshot.rules, id) : ruleSnapshot.rules;
          const ranked = rankQualifiedXhsThemes(current.notes, id, now, rules);
          const target = current.run?.themeTarget;
          const found = ranked.themes.length + ranked.candidateThemes.length;
          const run = current.run && target ? { ...current.run, themeTarget: { ...target, found, status: found >= target.minimum ? 'met' : 'shortfall' },
            stopReason: found >= target.minimum ? `已有笔记重新归纳后达到选题目标（${ranked.themes.length} 个达标热点、${ranked.candidateThemes.length} 个待验证选题），未重新采集` : `已有笔记重新归纳后选题不足 ${target.minimum} 个（已找到 ${found} 个），需要重新检索补充证据` } : current.run;
          this.saved.categories[id] = categoryResultSchema.parse({ ...current, ...ranked, run,
            rankingVersion: 3, regroupedAt: now, collectionRuleSnapshot: current.collectionRuleSnapshot || current.ruleSnapshot, ruleSnapshot });
        }
        await this.persist();
      } catch (error) { this.saved = previous; throw error; }
    } finally { this.starting = false; await release?.(); }
    return this.state();
  }

  async update(force = false, requested?: XhsCategory[]): Promise<XhsHotspotState> {
    const ruleSnapshot = structuredClone(await this.rules()), enabled = enabledCategoryIds(ruleSnapshot.rules);
    const selection = [...new Set(requested ?? enabled)];
    if (!requested && !selection.length) return this.state();
    if (!selection.length || selection.some(c => !enabled.includes(c))) throw new AppError('INVALID_FORM', '请选择有效的热点分类。', 400);
    if (this.pending || this.starting) {
      if (force && selection.some(c => !this.updatingCategories.includes(c))) throw new AppError('XHS_BUSY', '另一个分类正在采集，请完成后再更新所选分类。', 409);
      return this.state();
    }
    if (this.analyzing.size) { if (force) throw new AppError('XHS_BUSY', '笔记正在拆解，请完成后更新。', 409); return this.state(); }
    this.starting = true;
    this.updatingCategories = selection;
    let release: (() => Promise<void>) | undefined;
    try {
      await this.load(); const now = this.deps.now();
      for (const id of selection) this.saved.categories[id] ??= blankCategory();
      const due = () => selection.filter(category => {
        if (force) return true;
        if (!effectiveRules(ruleSnapshot.rules, category).autoUpdate) return false;
        const c = this.saved.categories[category];
        if (c.error?.startsWith('小红书需要登录或安全验证。')) return false;
        if (!c.error && c.collectedAt && beijingDate(c.collectedAt) === beijingDate(now)) return false;
        return !c.attemptedAt || now.getTime() - Date.parse(c.attemptedAt) >= effectiveRules(ruleSnapshot.rules, category).retryMinutes * 60_000;
      });
      if (!due().length) { this.starting = false; this.updatingCategories = []; return this.state(); }
      release = await this.acquire('update', undefined, due()); await this.load();
      for (const id of selection) this.saved.categories[id] ??= blankCategory();
      const categories = due();
      if (!categories.length) { await release(); release = undefined; this.starting = false; this.updatingCategories = []; return this.state(); }
      this.updatingCategories = categories;
      this.saved.lastAttemptAt = now.toISOString(); this.runtimeError = null;
      this.cancelUpdate = new AbortController(); this.collecting = true;
      for (const category of categories) { delete this.previews[category]; this.saved.categories[category] = { ...this.saved.categories[category], attemptedAt: now.toISOString() }; }
      await this.persist();
      const unlock = release; release = undefined;
      this.pending = this.performUpdate(now.toISOString(), categories, ruleSnapshot).catch(error => { this.runtimeError = error instanceof AppError ? error.message : '采集结果未能保存，请检查本机存储。'; }).finally(async () => { this.collecting = false; try { while (this.analyzing.size) await new Promise(resolve => setTimeout(resolve, 50)); await unlock(); } finally { this.pending = null; this.progress = null; this.updatingCategories = []; this.cancelUpdate = null; } });
      void this.pending.catch(() => undefined);
      this.starting = false;
      return this.state();
    } catch (error) { this.starting = false; this.collecting = false; this.cancelUpdate = null; this.updatingCategories = []; await release?.(); throw error; }
  }
  private async performUpdate(now: string, categories: XhsCategory[], ruleSnapshot: XhsRulesVersion) {
    const completed = new Set<string>(), signal = this.cancelUpdate?.signal;
    const enabled = enabledCategoryIds(ruleSnapshot.rules);
    try {
      await this.deps.collect(now, value => { this.progress = value; }, async (category, result) => {
        if (!categories.includes(category)) throw new AppError('XHS_SCOPE', '采集返回了未选择的分类，已停止更新。', 502);
        const keywords = result.run?.coverage?.keywords;
        if (!result.notes.length && !result.candidateCount && keywords?.length &&
            keywords.every(word => !word.completedSearches && !word.basicCovered)) {
          delete this.previews[category];
          throw new AppError('XHS_SEARCH_UNAVAILABLE', '小红书搜索页未能返回本轮任何关键词的结果，已保留上次榜单。', 503);
        }
        this.saved.categories[category] = categoryResultSchema.parse({ ...result, error: null, ruleSnapshot }); completed.add(category); delete this.previews[category]; await this.persist();
      }, categories, structuredClone(ruleSnapshot.rules), { signal, cachedNotes: Object.values(this.saved.categories).flatMap(c => c.notes), preview: (category, result) => { if (categories.includes(category)) this.previews[category] = categoryResultSchema.parse({ ...result, ruleSnapshot }); } });
      if (categories.some(category => !completed.has(category))) throw new AppError('XHS_INCOMPLETE', '本次采集未完成全部分类，未完成分类保留上次结果。', 502);
      if (enabled.every(c => this.saved.categories[c]?.collectedAt && !this.saved.categories[c].error && this.saved.categories[c].run?.themeTarget?.status !== 'shortfall' && beijingDate(this.saved.categories[c].collectedAt!) === beijingDate(now))) this.saved.lastSuccessAt = now;
    } catch (error) {
      const message = error instanceof AppError ? error.message : '小红书采集暂时失败，请稍后重试；已有结果保留。';
      this.saved.error = message.slice(0, 500);
      for (const category of categories) if (!completed.has(category)) {
        this.saved.categories[category] = { ...this.saved.categories[category], attemptedAt: now, error: message.slice(0, 500) };
        const partial = this.previews[category];
        if (partial) {
          partial.error = message.slice(0, 500);
          if (partial.run) {
            const found = partial.themes.length + (partial.candidateThemes?.length || 0);
            partial.run.finishedAt = this.deps.now().toISOString();
            partial.run.stopReason = `${partial.run.themeTarget && found < partial.run.themeTarget.minimum ? `选题不足 ${partial.run.themeTarget.minimum} 个（已找到 ${found} 个）；` : ''}${message}`.slice(0, 300);
            if (partial.run.coverage) partial.run.coverage.phase = 'finished';
            if (partial.run.themeTarget) partial.run.themeTarget = { ...partial.run.themeTarget, found, status: found >= partial.run.themeTarget.minimum ? 'met' : 'shortfall' };
          }
        }
      }
    }
    this.saved.error = [...new Set(Object.values(this.saved.categories).map(c => c.error).filter(Boolean))].join('；').slice(0, 500) || null;
    await this.persist();
  }
  async cancel() { this.cancelUpdate?.abort(new AppError('XHS_CANCELLED', '本次检索已停止，上次榜单和已核验的临时结果保留。', 409)); return this.state(); }
  async waitForUpdate() { await this.pending; }
  async analyze(noteId: string, source: AiSource, force = false, signal?: AbortSignal): Promise<XhsAnalysis> {
    if (!this.pending && !this.starting && !this.analyzing.size) await this.load();
    const find = () => [...Object.values(this.previews), ...Object.values(this.saved.categories)].flatMap(category => category.notes).find(note => note.id === noteId);
    let note = find();
    if (!note) throw new AppError('XHS_NOTE_MISSING', '这篇笔记已不在当前候选中，请刷新热点列表。', 404);
    const cached = this.saved.analyses[noteId];
    if (!force && cached?.fingerprint === note.fingerprint) return cached;
    if (this.analyzing.has(noteId)) throw new AppError('XHS_BUSY', '这篇笔记正在拆解，请稍候。', 409);
    const release = this.collecting ? async () => undefined : await this.acquire('analyze', noteId);
    this.analyzing.add(noteId);
    try {
      if (!this.pending && !this.starting) await this.load(); note = find();
      if (!note) throw new AppError('XHS_NOTE_MISSING', '热点已更新，请重新选择笔记。', 409);
      const latest = this.saved.analyses[noteId];
      if (!force && latest?.fingerprint === note.fingerprint) return latest;
      const value = savedAnalysisSchema.parse(await this.deps.analyze(structuredClone(note), source, signal));
      if (value.noteId !== note.id || value.fingerprint !== note.fingerprint) throw new AppError('INVALID_RESULT', '拆解结果未对应当前笔记，已有拆解保留。', 502);
      const old = this.saved.analyses;
      this.saved.analyses = { ...old, [noteId]: value };
      try { await this.persist(); } catch (error) { this.saved.analyses = old; throw error; }
      return value;
    } finally { this.analyzing.delete(noteId); await release(); }
  }
}
type GlobalXhs = typeof globalThis & { __xhsHotspotsV2?: XhsHotspotsStore; __xhsHotspotsTimer?: ReturnType<typeof setInterval> };
export function getXhsHotspotsStore() {
  const root = globalThis as GlobalXhs;
  return root.__xhsHotspotsV2 ??= new XhsHotspotsStore({ file: join(xhsDataDirectory(), 'xhs-hotspots-v2.json'), now: () => new Date(), collect: collectXhsHotspots, analyze: analyzeXhsNote, readRules: () => getXhsRulesStore().read() });
}
export function startXhsHotspotsScheduler() {
  const root = globalThis as GlobalXhs;
  if (root.__xhsHotspotsTimer || process.env.APP_LOCAL_ONLY !== '1' || process.env.XHS_HOTSPOTS_SCHEDULER === '0') return;
  const store = getXhsHotspotsStore(); store.scheduler = true;
  const tick = () => { void store.update(false).catch(() => undefined); };
  root.__xhsHotspotsTimer = setInterval(tick, 60_000); root.__xhsHotspotsTimer.unref(); tick();
}

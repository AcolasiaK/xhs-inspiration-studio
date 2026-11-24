import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppError } from '../errors';
import { isCloudMode } from '../cloud/mode';
import { styleAnalysisSchema, styleLearningRequestSchema, validateStyleAnalysis, type StyleLearningRequest } from '../personal/style-learning';
import { styleImageBatches, styleJobIdSchema, styleJobSettingsSchema, styleJobSnapshotSchema, startStyleIntegrationSchema, type StartStyleIntegration, type StyleJobSettings, type StyleJobSnapshot } from '../personal/style-learning-job';
import { ruleContentSchema } from '../personal/style-rules';
import { integrationContextParts, styleIntegrationProposalSchema, resolvedIntegrationSections, adoptStyleLearningSchema, type StyleIntegrationContext, type IntegrationSource } from '../personal/style-integration';
import { learningSelectionSchema, styleLearningReviewSchema, type LearningSelection, type StyleLearningRound } from '../personal/style-learning-memory';
import { adoptStyleLearningResult, resolveStyleLearningTarget } from './personal-style-store';
import { integrateWritingStyle } from './style-integration';
import { selectProfile, type Snapshot } from './ai/selection';
import { OutputBudgetError } from './ai/output-budget';
import { styleLearningRecovery } from './style-learning-recovery';
import { analyzeStyleImageBatch, synthesizeWritingStyle } from './style-learning-steps';

const integrationContextSchema = z.object({
  target: integrationContextParts.target, baseline: ruleContentSchema, sourceJobId: z.string().uuid(), selection: integrationContextParts.selection,
  current: z.object({ references: z.array(z.object({ id: z.string(), title: z.string().max(300), text: z.string().max(12000), url: z.string().max(1000), images: z.array(z.object({ id: z.string(), caption: z.string().max(2000) }).strict()) }).strict()), analysis: styleAnalysisSchema, preferences: z.string().max(2000) }).strict(),
  sources: z.array(integrationContextParts.source), currentReferenceMap: z.record(z.string(), z.string()), history: z.array(integrationContextParts.round), sourceJobIds: z.array(z.string().uuid()),
}).strict();
const storedJobSchema = z.object({
  version: z.literal(1), owner: z.string(), inputHash: z.string(), input: styleLearningRequestSchema,
  snapshot: styleJobSnapshotSchema, observations: styleAnalysisSchema.shape.imageAnalyses, integrationContext: integrationContextSchema.optional(), resultHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
type StoredJob = z.infer<typeof storedJobSchema>;
type Worker = { token: string; controller: AbortController; record: StoredJob; promise?: Promise<void> };
type Registry = { workers: Map<string, Worker>; locks: Map<string, Promise<void>>; processToken: string };
const registryKey = Symbol.for('xhs.style-learning-jobs.v1');
const globals = globalThis as typeof globalThis & { [registryKey]?: Registry };
const registry = globals[registryKey] ??= { workers: new Map(), locks: new Map(), processToken: randomUUID() };
// This boundary also permits deterministic fault injection without making paid requests.
export const styleLearningJobRuntime = { analyzeImages: analyzeStyleImageBatch, synthesize: synthesizeWritingStyle, integrate: integrateWritingStyle, selectProfile };
const root = () => join(process.env.PERSONAL_STYLES_DIR || join(process.cwd(), '.local-data', 'personal-styles'), 'learning-jobs');
const ownerDirectory = (owner: string) => join(root(), createHash('sha256').update(owner).digest('hex'));
const ownerKey = (owner: string) => ownerDirectory(owner);
const workerKey = (owner: string, id: string) => join(ownerDirectory(owner), id);
const fileFor = (owner: string, id: string) => join(ownerDirectory(owner), styleJobIdSchema.parse(id) + '.json');
const timestamp = (previous?: string) => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
function assertLocalJobs() {
  if (isCloudMode()) throw new AppError('LOCAL_ONLY', '分步后台分析请在本机工作台使用。', 400);
}
function aliveProcess(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
// A separate process (e.g. a temporary dev server) must not revive a live worker.
const leaseSchema = z.object({ pid: z.number().int().positive(), processToken: z.string().uuid(), jobId: styleJobIdSchema, token: z.string().uuid() }).strict();
const leaseFile = (owner: string) => join(ownerDirectory(owner), 'running.json');
async function liveLease(owner: string) {
  let raw: string;
  try { raw = await readFile(leaseFile(owner), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AppError('STYLE_JOB_STORAGE', '无法核对后台任务状态，请检查本机存储。', 503); }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AppError('STYLE_JOB_STORAGE', '后台任务状态异常，已停止重复调用，请检查本机存储。', 503); }
  const parsed = leaseSchema.safeParse(value);
  if (!parsed.success) throw new AppError('STYLE_JOB_STORAGE', '后台任务状态异常，已停止重复调用，请检查本机存储。', 503);
  const lease = parsed.data;
  const ownWorker = registry.workers.get(workerKey(owner, lease.jobId));
  const ownStale = lease.pid === process.pid && (lease.processToken !== registry.processToken || ownWorker?.token !== lease.token);
  if (!aliveProcess(lease.pid) || ownStale) { await unlink(leaseFile(owner)); return null; }
  return lease;
}
async function acquireDiskMutex(owner: string) {
  const path = join(ownerDirectory(owner), '.transaction-lock'), marker = `owner-${process.pid}-${randomUUID()}`;
  await mkdir(ownerDirectory(owner), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 }); created = true;
      await writeFile(join(path, marker), '', { flag: 'wx', mode: 0o600 });
      return async () => { await unlink(join(path, marker)).catch(() => undefined); await rmdir(path).catch(() => undefined); };
    } catch (error) {
      if (created) { await unlink(join(path, marker)).catch(() => undefined); await rmdir(path).catch(() => undefined); }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new AppError('STYLE_JOB_STORAGE', '暂时无法锁定本机分析记录，后续调用已停止。', 503);
      try {
        const entries = await readdir(path), match = entries.length === 1 ? entries[0].match(/^owner-(\d+)-[a-f0-9-]+$/) : null;
        if (match && !aliveProcess(Number(match[1]))) { await unlink(join(path, entries[0])); await rmdir(path); }
        else if (entries.length === 0 && Date.now() - (await stat(path)).mtimeMs > 30_000) await rmdir(path);
      } catch { /* Another process may have released the lock. */ }
      await delay(10);
    }
  }
  throw new AppError('STYLE_JOB_BUSY', '另一进程正在更新分析记录，请稍后重新读取。', 409);
}
async function locked<T>(owner: string, action: () => Promise<T>): Promise<T> {
  const key = ownerKey(owner), previous = registry.locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  registry.locks.set(key, queued);
  await previous.catch(() => undefined);
  let releaseDisk: (() => Promise<void>) | undefined;
  try { releaseDisk = await acquireDiskMutex(owner); return await action(); }
  finally { await releaseDisk?.(); release(); if (registry.locks.get(key) === queued) registry.locks.delete(key); }
}
async function persist(record: StoredJob) {
  const directory = ownerDirectory(record.owner), file = fileFor(record.owner, record.snapshot.id);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new AppError('STYLE_JOB_STORAGE', '分析进度暂时无法写入本机。已停止后续调用，请检查本机存储后再继续。', 503);
  }
}
async function load(owner: string, id: string): Promise<StoredJob | null> {
  const active = registry.workers.get(workerKey(owner, id));
  if (active) return structuredClone(active.record);
  let raw: string;
  try { raw = await readFile(fileFor(owner, id), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AppError('STYLE_JOB_STORAGE', '暂时无法读取本机分析进度，原数据保留。', 503); }
  let record: StoredJob;
  try { record = storedJobSchema.parse(JSON.parse(raw)); }
  catch { throw new AppError('STYLE_JOB_STORAGE', '本机分析进度格式异常，原数据保留。', 503); }
  if (record.owner !== owner || record.snapshot.id !== id) throw new AppError('NOT_FOUND', '没有找到这次分析。', 404);
  // A service restart must never silently restart a paid request.
  if (record.snapshot.status === 'running' && (await liveLease(owner))?.jobId !== id) {
    record.snapshot = { ...record.snapshot, status: 'paused', updatedAt: timestamp(record.snapshot.updatedAt), error: { code: 'INTERRUPTED', message: '本机服务曾中断。已完成步骤已保留，确认后可继续未完成步骤。' } };
    await persist(record);
  }
  return record;
}
async function required(owner: string, id: string) {
  const record = await load(owner, id);
  if (!record) throw new AppError('NOT_FOUND', '没有找到这次分析。', 404);
  return record;
}
function snapshot(record: StoredJob): StyleJobSnapshot { return structuredClone(record.snapshot); }
function label(input: StyleLearningRequest, step: number) {
  const batches = styleImageBatches(input);
  if (step >= batches.length) return step > batches.length ? '风格提炼已完成' : '汇总标题、正文和配文风格';
  const before = batches.slice(0, step).reduce((sum, batch) => sum + batch.length, 0);
  return `观察参考图 ${before + 1}–${before + batches[step].length}`;
}
async function assertNoOtherWorker(owner: string, id: string) {
  const lease = await liveLease(owner);
  if (lease && (lease.pid !== process.pid || lease.processToken !== registry.processToken || lease.jobId !== id)) throw new AppError('STYLE_JOB_RUNNING', '已有风格分析在另一个工作台进程中运行，请先在原页面查看或暂停。', 409);
  for (const [key, worker] of registry.workers) {
    if (key.startsWith(ownerKey(owner) + '/') && worker.record.snapshot.id !== id && !worker.controller.signal.aborted && worker.record.snapshot.status === 'running') {
      throw new AppError('STYLE_JOB_RUNNING', '已有一项风格分析正在进行，请先查看或暂停它。', 409);
    }
  }
}
function current(owner: string, id: string, worker: Worker) {
  return registry.workers.get(workerKey(owner, id))?.token === worker.token && !worker.controller.signal.aborted;
}
async function checkpoint(worker: Worker, next: StoredJob): Promise<boolean> {
  return locked(next.owner, async () => {
    if (!current(next.owner, next.snapshot.id, worker)) return false;
    await persist(next); worker.record = next; return true;
  });
}
async function withDeadline<T>(worker: Worker, seconds: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.any([worker.controller.signal, AbortSignal.timeout(seconds * 1000)]);
  let onAbort: () => void = () => undefined;
  const interrupted = () => new AppError(worker.controller.signal.aborted ? 'CANCELLED' : 'TIMEOUT', worker.controller.signal.aborted ? '本次分析已暂停。' : '当前步骤达到等待时限。', worker.controller.signal.aborted ? 499 : 504);
  try {
    signal.throwIfAborted();
    const stop = new Promise<never>((_, reject) => { onAbort = () => reject(interrupted()); signal.addEventListener('abort', onAbort, { once: true }); });
    const value = await Promise.race([action(signal), stop]);
    if (signal.aborted) throw interrupted();
    return value;
  } finally { signal.removeEventListener('abort', onAbort); }
}
async function run(worker: Worker, source: Snapshot) {
  const owner = worker.record.owner, id = worker.record.snapshot.id;
  try {
    const batches = styleImageBatches(worker.record.input);
    while (current(owner, id, worker) && worker.record.snapshot.status === 'running') {
      const record = worker.record, step = record.snapshot.completedSteps, next = structuredClone(record);
      if (record.integrationContext) {
        const proposal = await withDeadline(worker, record.snapshot.settings.timeoutSeconds, signal => styleLearningJobRuntime.integrate(record.integrationContext!, source, signal, record.snapshot.settings));
        next.snapshot.integration = { ...record.snapshot.integration!, proposal: styleIntegrationProposalSchema.parse(proposal) };
        next.snapshot.status = 'completed';
      } else if (step < batches.length) {
        const observations = await withDeadline(worker, record.snapshot.settings.timeoutSeconds, signal => styleLearningJobRuntime.analyzeImages(record.input, batches[step], source, signal, record.snapshot.settings));
        const expected = new Set(batches[step].map(k => `${k.referenceId}/${k.imageId}`));
        const parsed = styleAnalysisSchema.shape.imageAnalyses.parse(observations);
        if (parsed.length !== expected.size || new Set(parsed.map(k => `${k.referenceId}/${k.imageId}`)).size !== expected.size || parsed.some(k => !expected.has(`${k.referenceId}/${k.imageId}`))) throw new AppError('INVALID_RESULT', '当前图片观察不完整，请继续重试此步骤。', 502);
        next.observations.push(...parsed);
      } else {
        const analysis = await withDeadline(worker, record.snapshot.settings.timeoutSeconds, signal => styleLearningJobRuntime.synthesize(record.input, record.observations, source, signal, record.snapshot.settings));
        next.snapshot.analysis = validateStyleAnalysis(analysis, record.input.references);
        next.resultHash = createHash('sha256').update(JSON.stringify({ input: next.input, analysis: next.snapshot.analysis })).digest('hex');
        next.snapshot.status = 'completed';
      }
      next.snapshot.completedSteps++; next.snapshot.stageLabel = record.integrationContext ? '新旧风格综合已完成，等待审阅' : label(next.input, next.snapshot.completedSteps); next.snapshot.updatedAt = timestamp(record.snapshot.updatedAt);
      delete next.snapshot.error; delete next.snapshot.recovery;
      if (!await checkpoint(worker, next)) return;
    }
  } catch (error) {
    await locked(owner, async () => {
      if (!current(owner, id, worker)) return;
      const next = structuredClone(worker.record), known = error instanceof AppError ? error : null;
      next.snapshot.status = 'failed'; next.snapshot.updatedAt = timestamp(next.snapshot.updatedAt);
      next.snapshot.error = { code: known?.code ?? 'STYLE_JOB_FAILED', message: known?.code === 'TIMEOUT'
        ? `「${next.snapshot.stageLabel}」在 ${next.snapshot.settings.timeoutSeconds} 秒内未完成。已完成的 ${next.snapshot.completedSteps} 步已保存，可延长本次等待后继续。`
        : known?.message ?? '当前步骤未完成。已完成步骤已保留，可以继续未完成步骤。' };
      if (error instanceof OutputBudgetError) {
        const recovery = styleLearningRecovery(error);
        if (!recovery.partial.length && next.snapshot.recovery?.partial.length) recovery.partial = next.snapshot.recovery.partial;
        next.snapshot.recovery = recovery;
      }
      try { await persist(next); }
      catch { next.snapshot.error = { code: 'STYLE_JOB_STORAGE', message: '分析进度暂时无法写入本机，后续调用已停止。已保存步骤仍在，请检查本机存储后重试。' }; }
      worker.record = next;
    });
  } finally {
    await locked(owner, async () => {
      if (registry.workers.get(workerKey(owner, id))?.token === worker.token) {
        const lease = await liveLease(owner);
        registry.workers.delete(workerKey(owner, id));
        if (lease?.token === worker.token) await unlink(leaseFile(owner));
      }
    });
  }
}
async function launch(record: StoredJob, source: Snapshot) {
  const worker: Worker = { token: randomUUID(), controller: new AbortController(), record };
  const lease = leaseFile(record.owner), temporary = lease + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, processToken: registry.processToken, jobId: record.snapshot.id, token: worker.token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, lease);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new AppError('STYLE_JOB_STORAGE', '后台任务状态暂时无法写入本机，尚未调用 AI，请恢复后继续。', 503);
  }
  registry.workers.set(workerKey(record.owner, record.snapshot.id), worker);
  // Every failure is caught in run. Keep a final guard for unexpected disk/runtime failures.
  worker.promise = run(worker, source).catch(() => {
    worker.controller.abort();
    if (registry.workers.get(workerKey(record.owner, record.snapshot.id))?.token === worker.token) registry.workers.delete(workerKey(record.owner, record.snapshot.id));
  });
}
export async function startStyleLearningJob(owner: string, id: string, input: StyleLearningRequest, settings: StyleJobSettings, profileId?: string | null) {
  assertLocalJobs(); styleJobIdSchema.parse(id);
  input = styleLearningRequestSchema.parse(input); settings = styleJobSettingsSchema.parse(settings);
  return locked(owner, async () => {
    const inputHash = createHash('sha256').update(JSON.stringify({ input, settings, profileId: profileId || '' })).digest('hex');
    const existing = await load(owner, id);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new AppError('STYLE_JOB_CONFLICT', '这次分析编号已用于其他内容，请重新开始分析。', 409);
      return snapshot(existing);
    }
    await assertNoOtherWorker(owner, id);
    const source = await styleLearningJobRuntime.selectProfile(owner, profileId);
    if (!source.profile?.apiKey || !source.profile.model) throw new AppError('NOT_CONFIGURED', '请先选择可用的 AI 配置。', 503);
    const now = timestamp(), actualSettings = { ...settings, maxOutputTokens: settings.maxOutputTokens ?? input.maxOutputTokens ?? source.profile.maxOutputTokens };
    const record: StoredJob = { version: 1, owner, inputHash, input, observations: [], snapshot: {
      id, status: 'running', createdAt: now, updatedAt: now, completedSteps: 0, totalSteps: styleImageBatches(input).length + 1,
      stageLabel: label(input, 0), settings: actualSettings, profile: { id: source.profile.id, revision: source.profile.revision, name: source.profile.name },
    } };
    await persist(record); await launch(record, source); return snapshot(record);
  });
}
export async function getStyleLearningJob(owner: string, id: string, includeInput = false) {
  assertLocalJobs(); styleJobIdSchema.parse(id);
  return locked(owner, async () => { const record = await required(owner, id); return { job: snapshot(record), ...(includeInput ? { input: structuredClone(record.input) } : {}) }; });
}
export async function listStyleLearningJobs(owner: string) {
  assertLocalJobs();
  return locked(owner, async () => {
    let files: string[];
    try { files = await readdir(ownerDirectory(owner)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new AppError('STYLE_JOB_STORAGE', '暂时无法读取本机分析记录，原数据保留。', 503); }
    const jobs: StyleJobSnapshot[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || !styleJobIdSchema.safeParse(file.slice(0, -5)).success) continue;
      const record = await load(owner, file.slice(0, -5));
      if (record) jobs.push(snapshot(record));
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
  });
}
export async function pauseStyleLearningJob(owner: string, id: string) {
  assertLocalJobs(); styleJobIdSchema.parse(id);
  return locked(owner, async () => {
    const record = await required(owner, id);
    if (record.snapshot.status !== 'running') return snapshot(record);
    const worker = registry.workers.get(workerKey(owner, id));
    if (!worker && (await liveLease(owner))?.jobId === id) throw new AppError('STYLE_JOB_RUNNING', '这次分析在另一工作台进程中运行，请在启动它的页面暂停。', 409);
    worker?.controller.abort();
    record.snapshot = { ...record.snapshot, status: 'paused', updatedAt: timestamp(record.snapshot.updatedAt), error: { code: 'PAUSED', message: '已暂停，参考内容和已完成步骤已保存。确认后可继续未完成步骤。' } };
    await persist(record); if (worker) worker.record = record;
    return snapshot(record);
  });
}
export async function resumeStyleLearningJob(owner: string, id: string, settings: StyleJobSettings) {
  assertLocalJobs(); styleJobIdSchema.parse(id); settings = styleJobSettingsSchema.parse(settings);
  return locked(owner, async () => {
    const record = await required(owner, id);
    if (record.snapshot.status === 'running' || record.snapshot.status === 'completed') return snapshot(record);
    await assertNoOtherWorker(owner, id);
    const source = await styleLearningJobRuntime.selectProfile(owner, record.snapshot.profile.id);
    if (!source.profile || source.profile.revision !== record.snapshot.profile.revision) throw new AppError('STYLE_JOB_PROFILE_CHANGED', '这次分析使用的 AI 配置已修改。已完成内容仍保留；请恢复参考后用当前配置新建分析。', 409);
    record.snapshot = { ...record.snapshot, status: 'running', updatedAt: timestamp(record.snapshot.updatedAt), settings: { ...settings, maxOutputTokens: settings.maxOutputTokens ?? record.snapshot.settings.maxOutputTokens } };
    delete record.snapshot.error;
    await persist(record); await launch(record, source); return snapshot(record);
  });
}


function validateSelection(selection: LearningSelection, record: StoredJob) {
  const parsed = learningSelectionSchema.parse(selection), analysis = record.snapshot.analysis;
  if (!analysis || parsed.some(item => !analysis.traits[item.index])) throw new AppError('INVALID_FORM', '所选写法与这次分析不一致，请重新选择。', 400);
  return parsed;
}
function completedAnalysis(record: StoredJob) {
  if (record.snapshot.status !== 'completed' || !record.snapshot.analysis || record.integrationContext) throw new AppError('STYLE_SOURCE_INCOMPLETE', '请先完成新笔记分析并选择认可的写法。', 409);
  try {
    validateStyleAnalysis(record.snapshot.analysis, record.input.references);
    if (record.resultHash && record.resultHash !== createHash('sha256').update(JSON.stringify({ input: record.input, analysis: record.snapshot.analysis })).digest('hex')) throw new Error('SOURCE_HASH');
  } catch { throw new AppError('STYLE_SOURCE_INVALID', '历史参考与已保存分析不一致，原规则保留。请恢复完整来源后再综合。', 409); }
  return record.snapshot.analysis;
}
export function sourceFingerprint(reference: StyleLearningRequest['references'][number]) {
  const text = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(JSON.stringify([text(reference.title), text(reference.text), reference.images.map(image => [text(image.caption), createHash('sha256').update(image.dataUrl).digest('hex')])])).digest('hex');
}
/** Keep the complete original text and verified observations, without duplicate image bytes. */
async function integrationSources(owner: string, sourceJobIds: string[], currentId: string) {
  const sources: IntegrationSource[] = [], byFingerprint = new Map<string, IntegrationSource>(), currentReferenceMap: Record<string, string> = {};
  for (const jobId of sourceJobIds) {
    const record = await required(owner, jobId), analysis = completedAnalysis(record);
    for (const reference of record.input.references) {
      const fingerprint = sourceFingerprint(reference);
      const images: IntegrationSource['images'] = reference.images.map(image => {
        const observed = analysis.imageAnalyses.find(item => item.referenceId === reference.id && item.imageId === image.id);
        if (!observed) throw new AppError('STYLE_SOURCE_INCOMPLETE', '历史参考的图片观察不完整，原规则保留，请重新读取参考。', 409);
        return { id: image.id, caption: image.caption, visibleText: observed.visibleText, visualDescription: observed.visualDescription, captionAnalysis: observed.captionAnalysis, role: observed.role, limitations: observed.limitations };
      });
      let source = byFingerprint.get(fingerprint);
      if (!source) {
        source = { id: 'ref-' + fingerprint, fingerprint, jobIds: [], title: reference.title, text: reference.text, url: reference.url, images };
        byFingerprint.set(fingerprint, source); sources.push(source);
      } else {
        // Same image bytes can yield corrected OCR on a later confirmed read.
        // Preserve those observations separately without inflating the image count.
        const observationKey = (image: IntegrationSource['images'][number]) => JSON.stringify([image.caption, image.visibleText, image.visualDescription, image.captionAnalysis, image.role, image.limitations]);
        const known = new Set([...source.images, ...(source.observationVariants ?? [])].map(observationKey));
        for (const image of images) {
          const key = observationKey(image);
          if (!known.has(key)) { (source.observationVariants ??= []).push(image); known.add(key); }
        }
      }
      if (!source.jobIds.includes(jobId)) source.jobIds.push(jobId);
      if (jobId === currentId) currentReferenceMap[reference.id] = source.id;
    }
  }
  return { sources, currentReferenceMap };
}
export async function startStyleIntegrationJob(owner: string, raw: StartStyleIntegration, profileId?: string | null) {
  assertLocalJobs(); const input = startStyleIntegrationSchema.parse(raw);
  return locked(owner, async () => {
    const inputHash = createHash('sha256').update(JSON.stringify({ integration: input, profileId: profileId || '' })).digest('hex');
    const existing = await load(owner, input.id);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new AppError('STYLE_JOB_CONFLICT', '这次综合编号已用于其他内容，请重新开始。', 409);
      return snapshot(existing);
    }
    await assertNoOtherWorker(owner, input.id);
    const original = await required(owner, input.sourceJobId), analysis = completedAnalysis(original), selection = validateSelection(input.selection, original);
    const bound = await resolveStyleLearningTarget(owner, input.target);
    const sourceJobIds = [...new Set([...(bound.learningReview?.sourceJobIds ?? []), input.sourceJobId])];
    const sourceContext = await integrationSources(owner, sourceJobIds, input.sourceJobId);
    const context: StyleIntegrationContext = integrationContextSchema.parse({
      target: input.target, baseline: bound.baseline, sourceJobId: input.sourceJobId, selection,
      current: { references: original.input.references.map(reference => ({ ...reference, images: reference.images.map(({ id, caption }) => ({ id, caption })) })), analysis, preferences: original.input.preferences },
      ...sourceContext, history: bound.learningReview?.rounds ?? [], sourceJobIds,
    });
    const source = await styleLearningJobRuntime.selectProfile(owner, profileId);
    if (!source.profile?.apiKey || !source.profile.model) throw new AppError('NOT_CONFIGURED', '请先选择可用的 AI 配置。', 503);
    const now = timestamp(), settings = { ...input.settings, maxOutputTokens: input.settings.maxOutputTokens ?? original.snapshot.settings.maxOutputTokens ?? source.profile.maxOutputTokens };
    const record: StoredJob = { version: 1, owner, inputHash, input: original.input, observations: original.observations, integrationContext: context, snapshot: {
      id: input.id, status: 'running', createdAt: now, updatedAt: now, completedSteps: 0, totalSteps: 1, stageLabel: '结合旧参考、现有规则与本次选择重新综合', settings,
      profile: { id: source.profile.id, revision: source.profile.revision, name: source.profile.name }, analysis,
      integration: { target: input.target, sourceJobId: input.sourceJobId, selection, baseline: bound.baseline, historySourceCount: sourceContext.sources.filter(item => item.jobIds.some(id => bound.learningReview?.sourceJobIds.includes(id))).length },
    } };
    await persist(record); await launch(record, source); return snapshot(record);
  });
}
function learningRound(record: StoredJob, selection: LearningSelection, resolutions: z.infer<typeof adoptStyleLearningSchema>['resolutions']): StyleLearningRound {
  const analysis = record.snapshot.analysis!, proposal = record.snapshot.integration?.proposal;
  // A final keep-previous decision supersedes the earlier tentative checkbox.
  // Retain it as not adopted this round, without turning it into a permanent ban.
  const keptScopes = new Set(proposal?.conflicts.filter(conflict => resolutions.some(choice => choice.conflictId === conflict.id && choice.optionId === 'keep_previous')).map(conflict => conflict.scope) ?? []);
  const adopted = selection.filter(item => !keptScopes.has(analysis.traits[item.index].scope));
  const chosen = new Set(adopted.map(item => item.index)), editedRules = new Map(selection.map(item => [item.index, item.rule]));
  return {
    jobId: record.integrationContext?.sourceJobId ?? record.snapshot.id, preferences: record.input.preferences,
    selected: adopted.map(item => {
      const trait = analysis.traits[item.index];
      return { scope: trait.scope, label: trait.label, rule: item.rule, evidence: trait.evidence.map(evidence => ({ sourceId: record.integrationContext?.currentReferenceMap[evidence.referenceId] ?? 'ref-' + sourceFingerprint(record.input.references.find(reference => reference.id === evidence.referenceId)!), quote: evidence.quote })) };
    }),
    notAdopted: analysis.traits.flatMap((trait, index) => chosen.has(index) ? [] : [{ scope: trait.scope, label: trait.label, rule: editedRules.get(index) ?? trait.rule }]),
    conflictChoices: resolutions.map(choice => {
      const conflict = proposal!.conflicts.find(item => item.id === choice.conflictId)!, option = conflict.options.find(item => item.id === choice.optionId)!;
      return { scope: conflict.scope, question: conflict.question, choice: option.label, text: option.text };
    }),
  };
}
/** Explicit review/save is separate from model work. It never calls AI or activates rules. */
export async function adoptStyleLearningJob(owner: string, id: string, raw: z.infer<typeof adoptStyleLearningSchema>) {
  assertLocalJobs(); styleJobIdSchema.parse(id); const input = adoptStyleLearningSchema.parse(raw);
  return locked(owner, async () => {
    const record = await required(owner, id);
    if (record.snapshot.status !== 'completed' || !record.snapshot.analysis) throw new AppError('STYLE_SOURCE_INCOMPLETE', '请先完成分析或综合，再审阅保存。', 409);
    let selection: LearningSelection;
    if (record.integrationContext) {
      if (!record.snapshot.integration?.proposal) throw new AppError('STYLE_SOURCE_INCOMPLETE', '综合方案尚未完成。', 409);
      selection = record.integrationContext.selection;
      if (input.selection && JSON.stringify(input.selection) !== JSON.stringify(selection)) throw new AppError('STYLE_CONFLICT', '采用的写法在综合后发生变化，请重新综合。', 409);
      try { resolvedIntegrationSections(record.snapshot.integration.proposal, input.resolutions); }
      catch (error) { throw new AppError('STYLE_CONFLICT_UNRESOLVED', error instanceof Error ? error.message : '请先确认所有冲突的处理方式。', 400); }
    } else {
      completedAnalysis(record);
      if (!input.selection) throw new AppError('INVALID_FORM', '请选择要采用的写法。', 400);
      if (input.resolutions.length) throw new AppError('INVALID_FORM', '当前分析没有待处理的综合冲突。', 400);
      selection = validateSelection(input.selection, record);
    }
    const payloadHash = createHash('sha256').update(JSON.stringify({ jobId: id, target: record.integrationContext?.target ?? null, content: input.content, selection, resolutions: input.resolutions })).digest('hex');
    const review = styleLearningReviewSchema.parse({ adoptionId: input.adoptionId, payloadHash, jobId: id,
      sourceJobIds: record.integrationContext?.sourceJobIds ?? [id], rounds: [...(record.integrationContext?.history ?? []), learningRound(record, selection, input.resolutions)],
    });
    return adoptStyleLearningResult(owner, { adoptionId: input.adoptionId, jobId: id, payloadHash, content: input.content, target: record.integrationContext?.target, review });
  });
}

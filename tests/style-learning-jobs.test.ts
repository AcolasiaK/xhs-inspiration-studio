import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { AppError } from '../lib/errors';
import { type Profile } from '../lib/ai-config';
import { type StyleAnalysis, type StyleLearningRequest } from '../lib/personal/style-learning';
import { type StyleImageKey, type StyleJobSettings } from '../lib/personal/style-learning-job';
import type { AiSource } from '../lib/server/ai-source';
import { OutputBudgetError } from '../lib/server/ai/output-budget';
import { providerError } from '../lib/server/provider-errors';
import { getStyleLearningJob, listStyleLearningJobs, pauseStyleLearningJob, resumeStyleLearningJob, startStyleLearningJob, styleLearningJobRuntime } from '../lib/server/style-learning-jobs';
import { GET as list, POST as start } from '../app/api/personal/styles/learning-jobs/route';
import { GET as get, POST as action } from '../app/api/personal/styles/learning-jobs/[id]/route';

const owner = 'local-owner', settings = { timeoutSeconds: 600 };
const profile: Profile = { id: 'synthetic-profile', revision: 'revision-1', name: '合成配置', provider: 'custom', protocol: 'responses', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-secret-never-persist', model: 'synthetic-model', timeoutSeconds: 150, maxOutputTokens: 8000, jsonMode: 'schema', textTest: { status: 'passed', at: null, message: 'fixture' }, imageTest: { status: 'passed', at: null, message: 'fixture' } };
const input = (images = 0): StyleLearningRequest => ({ references: [{ id: 'primary', title: '', text: '清晨推开窗，看见雨后的树叶。轻轻落下的水珠让我想再站一会儿。', images: Array.from({ length: images }, (_, i) => ({ id: `image-${i + 1}`, dataUrl: 'data:image/png;base64,AAAA', caption: '' })), url: '' }], preferences: '' });
const observations = (keys: StyleImageKey[]): StyleAnalysis['imageAnalyses'] => keys.map(key => ({ ...key, visibleText: '', visualDescription: '雨后的树叶与水珠', captionAnalysis: '没有可读文字，可结合正文分析画面关系。', role: '提供树叶的观察细节。', limitations: '' }));
const report = (items: StyleAnalysis['imageAnalyses'] = []): StyleAnalysis => ({ name: '日常观察', summary: '以观察写日常感受。', portrait: { temperament: '从细节形成节奏。', titles: { available: false, expression: '', language: '', appeal: '', relation: '' }, body: '以细节推进。', captions: '根据画面说明。', imageText: '从画面细节出发。', transfer: '换题材后仍保持观察视角。' }, traits: [{ scope: 'body', label: '动作切入', observation: '从当下动作进入观察。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '清晨推开窗', imageIds: [] }], rule: '用一个真实的小动作开启现场观察。' }], differences: [], imageAnalyses: items, cautions: [] });
const env = { ...process.env }; let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-style-jobs-'));
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', PERSONAL_STYLES_DIR: directory };
  mock.method(styleLearningJobRuntime, 'selectProfile', async (owner: string) => ({ owner, profile: structuredClone(profile) }));
  mock.method(styleLearningJobRuntime, 'analyzeImages', async (_input: StyleLearningRequest, keys: StyleImageKey[]) => observations(keys));
  mock.method(styleLearningJobRuntime, 'synthesize', async (_input: StyleLearningRequest, items: StyleAnalysis['imageAnalyses']) => report(items));
});
afterEach(async () => { await delay(5); mock.restoreAll(); process.env = env; await rm(directory, { recursive: true, force: true }); });
async function stopped(id: string) {
  for (let i = 0; i < 250; i++) { const { job } = await getStyleLearningJob(owner, id); if (job.status !== 'running') return job; await delay(2); }
  throw new Error('Synthetic job did not finish');
}
const pathFor = (id: string) => join(directory, 'learning-jobs', createHash('sha256').update(owner).digest('hex'), id + '.json');
function request(path = '', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('http://localhost/api/personal/styles/learning-jobs' + path, { method: body ? 'POST' : 'GET', headers: { host: 'localhost', origin: 'http://localhost', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });

test('分批 checkpoint + 综合结果持久化；普通轮询不含输入，磁盘不含密钥', async () => {
  const id = randomUUID(); const started = await startStyleLearningJob(owner, id, input(3), settings, profile.id);
  assert.equal(started.totalSteps, 3); assert.equal(started.settings.maxOutputTokens, 8000);
  const done = await stopped(id); assert.equal(done.status, 'completed'); assert.equal(done.completedSteps, 3); assert.equal(done.analysis?.imageAnalyses.length, 3);
  const value = await getStyleLearningJob(owner, id); assert(!('input' in value)); assert(!JSON.stringify(value).includes('base64'));
  assert.deepEqual((await getStyleLearningJob(owner, id, true)).input, input(3));
  const bytes = await readFile(pathFor(id), 'utf8'); assert(!bytes.includes(profile.apiKey)); assert.equal((await stat(pathFor(id))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(bytes).observations.map((item: { imageId: string }) => item.imageId), ['image-1', 'image-2', 'image-3']);
});

test('SDK 超时保留前一批，明确继续只重做失败步骤', async () => {
  const id = randomUUID(), calls: string[][] = []; let fail = true;
  mock.method(styleLearningJobRuntime, 'analyzeImages', async (_input: StyleLearningRequest, keys: StyleImageKey[]) => {
    calls.push(keys.map(k => k.imageId));
    if (keys[0].imageId === 'image-3' && fail) throw providerError(new OpenAI.APIConnectionTimeoutError(), 'AI 服务');
    return observations(keys);
  });
  await startStyleLearningJob(owner, id, input(4), settings); const failed = await stopped(id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedSteps, 1); assert.equal(failed.error?.code, 'TIMEOUT'); assert.match(failed.error!.message, /600 秒/);
  await getStyleLearningJob(owner, id); await listStyleLearningJobs(owner); assert.equal(calls.length, 2);
  fail = false; await resumeStyleLearningJob(owner, id, { timeoutSeconds: 1200 });
  assert.equal((await stopped(id)).status, 'completed'); assert.deepEqual(calls, [['image-1', 'image-2'], ['image-3', 'image-4'], ['image-3', 'image-4']]);
});

test('每步业务截止会停止等待，即使上游忽略取消也不能写入迟到结果', async () => {
  const id = randomUUID(); let resolve!: (value: StyleAnalysis) => void; const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  mock.method(AbortSignal, 'timeout', () => originalTimeout(5));
  mock.method(styleLearningJobRuntime, 'synthesize', async () => new Promise<StyleAnalysis>(r => { resolve = r; }));
  await startStyleLearningJob(owner, id, input(), settings); const failed = await stopped(id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error?.code, 'TIMEOUT'); assert.equal(failed.completedSteps, 0);
  resolve(report()); await delay(10); assert.equal((await getStyleLearningJob(owner, id)).job.status, 'failed');
});

test('token 不足后提高额度、随后超时再继续，保留已批准额度及预览', async () => {
  const id = randomUUID(), budgets: number[] = []; let attempt = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async (_input: StyleLearningRequest, items: StyleAnalysis['imageAnalyses'], _source: AiSource, _signal: AbortSignal, options: StyleJobSettings) => {
    budgets.push(options.maxOutputTokens!);
    if (attempt++ === 0) throw new OutputBudgetError(8000, 'exhausted', '{"summary":"保留的完整概述","portrait":');
    if (attempt === 2) throw new AppError('TIMEOUT', '合成超时', 504);
    return report(items);
  });
  await startStyleLearningJob(owner, id, input(2), settings); const first = await stopped(id);
  assert.equal(first.completedSteps, 1); assert.equal(first.recovery?.partial[0]?.text, '保留的完整概述');
  await resumeStyleLearningJob(owner, id, { timeoutSeconds: 600, maxOutputTokens: 32768 }); const second = await stopped(id);
  assert.equal(second.settings.maxOutputTokens, 32768); assert.equal(second.recovery?.partial[0]?.text, '保留的完整概述'); assert.equal(second.error?.code, 'TIMEOUT');
  await resumeStyleLearningJob(owner, id, { timeoutSeconds: 1200 }); assert.equal((await stopped(id)).status, 'completed'); assert.deepEqual(budgets, [8000, 32768, 32768]);
});

test('相同 id 并发启动幂等，改输入冲突；同 owner 不能同时启动另一付费任务', async () => {
  const id = randomUUID(); let release!: (value: StyleAnalysis) => void; let calls = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { calls++; return new Promise<StyleAnalysis>(r => { release = r; }); });
  const [a, b] = await Promise.all([startStyleLearningJob(owner, id, input(), settings), startStyleLearningJob(owner, id, input(), settings)]);
  assert.equal(a.id, b.id); assert.equal(calls, 1);
  await assert.rejects(startStyleLearningJob(owner, id, { ...input(), preferences: '新的偏好' }, settings), (e: unknown) => e instanceof AppError && e.code === 'STYLE_JOB_CONFLICT');
  await assert.rejects(startStyleLearningJob(owner, randomUUID(), input(), settings), (e: unknown) => e instanceof AppError && e.code === 'STYLE_JOB_RUNNING');
  release(report()); await stopped(id); await startStyleLearningJob(owner, id, input(), settings); assert.equal(calls, 1);
});

test('暂停后能恢复，旧 run 的迟到结果不能覆盖新 run 或保存规则', async () => {
  const id = randomUUID(); let release!: (value: StyleAnalysis) => void; let calls = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { if (calls++ === 0) return new Promise<StyleAnalysis>(r => { release = r; }); return { ...report(), name: '恢复后的完整风格' }; });
  await startStyleLearningJob(owner, id, input(), settings); assert.equal((await pauseStyleLearningJob(owner, id)).status, 'paused');
  await resumeStyleLearningJob(owner, id, settings); assert.equal((await stopped(id)).analysis?.name, '恢复后的完整风格');
  release({ ...report(), name: '过期输出' }); await delay(10); assert.equal((await getStyleLearningJob(owner, id)).job.analysis?.name, '恢复后的完整风格');
});

test('页面请求中断不取消后台；恢复只读轮询不额外调用 AI', async () => {
  const id = randomUUID(), controller = new AbortController(); let release!: (value: StyleAnalysis) => void; let calls = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { calls++; return new Promise<StyleAnalysis>(r => { release = r; }); });
  const response = await start(request('', { id, input: input(), settings }, {}, controller.signal)); assert.equal(response.status, 202); controller.abort();
  assert.equal((await (await get(request('/' + id), context(id))).json()).job.status, 'running');
  assert.equal((await (await list(request())).json()).jobs.length, 1); assert.equal(calls, 1);
  release(report()); assert.equal((await stopped(id)).status, 'completed');
});

test('服务重启遗留 running 只转 paused，读取不恢复付费；用户确认后复用已完成批次', async () => {
  const id = randomUUID(); let calls = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { calls++; throw new AppError('TIMEOUT', 'fixture', 504); });
  await startStyleLearningJob(owner, id, input(2), settings); await stopped(id); await delay(5);
  const record = JSON.parse(await readFile(pathFor(id), 'utf8')); record.snapshot.status = 'running'; delete record.snapshot.error;
  await writeFile(pathFor(id), JSON.stringify(record));
  const orphan = (await getStyleLearningJob(owner, id)).job; assert.equal(orphan.status, 'paused'); assert.equal(orphan.completedSteps, 1); assert.equal(orphan.error?.code, 'INTERRUPTED'); assert.equal(calls, 1);
  const disk = JSON.parse(await readFile(pathFor(id), 'utf8')); assert.equal(disk.snapshot.status, 'paused');
});

test('配置修改后恢复必须明确重新开始，绝不悄悄改源', async () => {
  const id = randomUUID(); let calls = 0;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { calls++; throw new AppError('TIMEOUT', 'fixture', 504); });
  await startStyleLearningJob(owner, id, input(), settings); await stopped(id);
  mock.method(styleLearningJobRuntime, 'selectProfile', async () => ({ owner, profile: { ...profile, revision: 'revision-2' } }));
  await assert.rejects(resumeStyleLearningJob(owner, id, settings), (e: unknown) => e instanceof AppError && e.code === 'STYLE_JOB_PROFILE_CHANGED'); assert.equal(calls, 1);
});

test('路由同源保护、owner 隔离、云端关闭新本机接口；GET 不含密钥/图片字节', async () => {
  const id = randomUUID(); await startStyleLearningJob(owner, id, input(), settings); await stopped(id);
  const safe = await get(request('/' + id + '?input=1'), context(id)); assert.equal(safe.status, 200); assert(!((await safe.text()).includes(profile.apiKey)));
  assert.equal((await list(request('', undefined, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await start(request('', { id: randomUUID(), input: input(), settings }, { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.equal((await action(request('/' + id, { action: 'pause' }, { origin: 'https://evil.example' }), context(id))).status, 403);
  await assert.rejects(getStyleLearningJob('someone-else', id), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  assert.equal((await get(request('/invalid'), context('../unsafe'))).status, 404);
  process.env.APP_MODE = 'cloud'; assert.equal((await list(request())).status, 400); assert.equal((await start(request('', { id: randomUUID(), input: input(), settings }))).status, 400); assert.equal((await get(request('/' + id), context(id))).status, 400);
});

test('损坏存档保留原文并停止，不当作空任务覆盖', async () => {
  const id = randomUUID(); await startStyleLearningJob(owner, id, input(), settings); await stopped(id); await delay(5);
  await writeFile(pathFor(id), '{broken');
  await assert.rejects(getStyleLearningJob(owner, id), (e: unknown) => e instanceof AppError && e.code === 'STYLE_JOB_STORAGE');
  await assert.rejects(startStyleLearningJob(owner, id, input(), settings), (e: unknown) => e instanceof AppError && e.code === 'STYLE_JOB_STORAGE');
  assert.equal(await readFile(pathFor(id), 'utf8'), '{broken');
});


test('另一进程读取活任务不会标为中断，也不能并发重复付费或跨进程暂停', async () => {
  const id = randomUUID(); let release!: (value: StyleAnalysis) => void;
  mock.method(styleLearningJobRuntime, 'synthesize', async () => new Promise<StyleAnalysis>(r => { release = r; }));
  await startStyleLearningJob(owner, id, input(), settings);
  const script = `
    const {getStyleLearningJob,startStyleLearningJob,pauseStyleLearningJob,styleLearningJobRuntime} = await import('./lib/server/style-learning-jobs.ts');
    let calls=0;styleLearningJobRuntime.selectProfile=async()=>{calls++;throw Error('should not select profile');};
    const value=await getStyleLearningJob(${JSON.stringify(owner)},${JSON.stringify(id)});
    let startCode='',pauseCode='';
    try{await startStyleLearningJob(${JSON.stringify(owner)},${JSON.stringify(randomUUID())},${JSON.stringify(input())},${JSON.stringify(settings)});}catch(e){startCode=e.code;}
    try{await pauseStyleLearningJob(${JSON.stringify(owner)},${JSON.stringify(id)});}catch(e){pauseCode=e.code;}
    process.stdout.write(JSON.stringify({status:value.job.status,startCode,pauseCode,calls}));
  `;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: process.env, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), { status: 'running', startCode: 'STYLE_JOB_RUNNING', pauseCode: 'STYLE_JOB_RUNNING', calls: 0 });
    assert.equal((await getStyleLearningJob(owner, id)).job.status, 'running');
  } finally { release(report()); await stopped(id); }
});

test('状态时间单调递增，暂停和恢复回包乱序时客户端可识别旧版本', async () => {
  const id = randomUUID(); mock.method(Date, 'now', () => 1_800_000_000_000);
  mock.method(styleLearningJobRuntime, 'synthesize', async () => { throw new AppError('TIMEOUT', 'fixture', 504); });
  const first = await startStyleLearningJob(owner, id, input(), settings), failed = await stopped(id);
  assert(failed.updatedAt > first.updatedAt);
  const resumed = await resumeStyleLearningJob(owner, id, settings), failedAgain = await stopped(id);
  assert(resumed.updatedAt > failed.updatedAt); assert(failedAgain.updatedAt > resumed.updatedAt);
});


test('checkpoint 写盘故障停止后续调用，恢复存储后只继续未保存步骤', async () => {
  const id = randomUUID(), ownerPath = join(directory, 'learning-jobs', createHash('sha256').update(owner).digest('hex')), backup = ownerPath + '-backup';
  let calls = 0, broken = false;
  mock.method(styleLearningJobRuntime, 'analyzeImages', async (_input: StyleLearningRequest, keys: StyleImageKey[]) => {
    calls++;
    if (calls === 2) { await rename(ownerPath, backup); await writeFile(ownerPath, 'synthetic storage blockage'); broken = true; }
    return observations(keys);
  });
  await startStyleLearningJob(owner, id, input(4), settings);
  for (let i = 0; i < 100 && !broken; i++) await delay(2);
  assert(broken); await delay(30); assert.equal(calls, 2);
  await unlink(ownerPath); await rename(backup, ownerPath);
  // A lock marker moved during the synthetic failure may remain. Its owned marker
  // is removed by normal finalization; no external user's file is touched here.
  const stuck = join(ownerPath, '.transaction-lock'); await rm(stuck, { recursive: true, force: true });
  const saved = (await getStyleLearningJob(owner, id)).job; assert.equal(saved.status, 'paused'); assert.equal(saved.completedSteps, 1);
  await resumeStyleLearningJob(owner, id, settings); assert.equal((await stopped(id)).status, 'completed'); assert.equal(calls, 3);
});


test('崩溃遗留的陈旧空事务锁可恢复，不误清理新锁', async () => {
  const lock = join(directory, 'learning-jobs', createHash('sha256').update(owner).digest('hex'), '.transaction-lock');
  await mkdir(lock, { recursive: true });
  const old = new Date(Date.now() - 60000); await utimes(lock, old, old);
  assert.deepEqual(await listStyleLearningJobs(owner), []);
  await assert.rejects(stat(lock), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
});

import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, lstat, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalStyleStorage, ensureLocalAiStorage } from '../scripts/local-style-storage.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'xhs-job-migration-'));
  const project = join(base, 'project'), root = join(base, 'installed'), source = join(project, '.local-data', 'personal-styles');
  const owner = 'synthetic-owner', id = randomUUID(), relative = join('learning-jobs', hash(owner));
  await mkdir(join(source, relative), { recursive: true });
  const job = {
    version: 1, owner, inputHash: hash('synthetic-input'),
    input: { preferences: '', references: [{ id: 'first', title: '合成标题', text: '只用于存储迁移测试的合成文案，不是真实用户的经历或者任何生成内容。', url: '', images: [] as { id: string; dataUrl: string; caption: string }[] }] },
    observations: [], snapshot: { id, status: 'paused', createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', completedSteps: 0, totalSteps: 1,
      stageLabel: '汇总标题、正文和配文风格', settings: { timeoutSeconds: 600, maxOutputTokens: 32768 }, profile: { id: 'synthetic-profile', revision: 'synthetic-revision', name: '合成配置' } },
  };
  const jobPath = join(source, relative, id + '.json');
  await writeFile(jobPath, JSON.stringify(job, null, 2) + '\n');
  return { base, project, root, source, owner, id, relative, job, jobPath };
}
afterEach(() => mock.restoreAll());

test('首次迁移递归保留学习任务和标准风格记录，超过旧风格 8MB 上限的图文任务仍逐字节保留', async () => {
  const f = await fixture();
  try {
    f.job.input.references[0].images = Array.from({ length: 3 }, (_, i) => ({ id: `image-${i}`, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(2_800_000), caption: '' }));
    const bytes = Buffer.from(JSON.stringify(f.job, null, 2) + '\n');
    await writeFile(f.jobPath, bytes);
    const styleName = hash(f.owner) + '.json', style = Buffer.from('{"version":1,"styles":[],"trials":[]}\n');
    await writeFile(join(f.source, styleName), style);
    const emptyOwner = join('learning-jobs', hash('empty-owner'));
    await mkdir(join(f.source, emptyOwner));
    const migrated = await ensureLocalStyleStorage(f.project, f.root);
    for (const directory of [migrated.target, migrated.backup!]) {
      assert.deepEqual(await readFile(join(directory, f.relative, f.id + '.json')), bytes);
      assert.deepEqual(await readFile(join(directory, styleName)), style);
      assert((await lstat(join(directory, emptyOwner))).isDirectory());
    }
    assert.equal((await stat(join(migrated.target, f.relative))).mode & 0o777, 0o700);
    assert.equal((await stat(f.jobPath)).mode & 0o777, 0o600);
    assert.equal((await ensureLocalStyleStorage(f.project, f.root)).migrated, false);
    assert.deepEqual(await readFile(f.jobPath), bytes);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('确认进程已退出的租约与残余互斥锁原样保留，迁移不启动生成或重写任务状态', async () => {
  const f = await fixture(), deadPid = 999_999_999, originalKill = process.kill;
  mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === deadPid) throw Object.assign(new Error('Synthetic process is gone'), { code: 'ESRCH' });
    return originalKill(pid, signal);
  });
  try {
    f.job.snapshot.status = 'running';
    const job = Buffer.from(JSON.stringify(f.job) + '\n'); await writeFile(f.jobPath, job);
    const lease = Buffer.from(JSON.stringify({ pid: deadPid, processToken: randomUUID(), jobId: f.id, token: randomUUID() }) + '\n');
    await writeFile(join(f.source, f.relative, 'running.json'), lease);
    const lock = join(f.relative, '.transaction-lock'), marker = `owner-${deadPid}-${randomUUID()}`;
    await mkdir(join(f.source, lock)); await writeFile(join(f.source, lock, marker), '');
    const migrated = await ensureLocalStyleStorage(f.project, f.root);
    assert.deepEqual(await readFile(f.jobPath), job);
    for (const directory of [migrated.target, migrated.backup!]) {
      assert.deepEqual(await readFile(join(directory, f.relative, 'running.json')), lease);
      assert.equal((await readFile(join(directory, lock, marker))).length, 0);
    }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('活跃租约、活跃锁、临时文件与未知文件阻止迁移，原记录保持不变', async () => {
  for (const kind of ['lease', 'lock', 'temporary', 'unknown', 'bad-owner', 'bad-id', 'bad-json']) {
    const f = await fixture();
    try {
      if (kind === 'lease') await writeFile(join(f.source, f.relative, 'running.json'), JSON.stringify({ pid: process.pid, processToken: randomUUID(), jobId: f.id, token: randomUUID() }));
      if (kind === 'lock') { const lock = join(f.source, f.relative, '.transaction-lock'); await mkdir(lock); await writeFile(join(lock, `owner-${process.pid}-${randomUUID()}`), ''); }
      if (kind === 'temporary') await writeFile(f.jobPath + '.' + randomUUID() + '.tmp', '{}');
      if (kind === 'unknown') await writeFile(join(f.source, f.relative, 'notes.txt'), 'do not discard');
      if (kind === 'bad-owner') await writeFile(f.jobPath, JSON.stringify({ ...f.job, owner: 'another-owner' }));
      if (kind === 'bad-id') await writeFile(f.jobPath, JSON.stringify({ ...f.job, snapshot: { ...f.job.snapshot, id: randomUUID() } }));
      if (kind === 'bad-json') await writeFile(f.jobPath, '{bad');
      const before = await readFile(f.jobPath);
      await assert.rejects(ensureLocalStyleStorage(f.project, f.root));
      assert((await lstat(f.source)).isDirectory()); assert.deepEqual(await readFile(f.jobPath), before);
      await assert.rejects(lstat(join(f.root, 'data', 'personal-styles')), { code: 'ENOENT' });
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test('任务目录、owner 目录、任务文件和锁标记中的 symlink 均被拒绝', async () => {
  for (const level of ['jobs', 'owner', 'job', 'marker']) {
    const f = await fixture();
    try {
      let path = level === 'jobs' ? join(f.source, 'learning-jobs') : level === 'owner' ? join(f.source, f.relative) : f.jobPath;
      if (level === 'marker') { const lock = join(f.source, f.relative, '.transaction-lock'); await mkdir(lock); path = join(lock, `owner-999999999-${randomUUID()}`); }
      else await rm(path, { recursive: true });
      const external = join(f.base, 'external');
      if (['jobs', 'owner'].includes(level)) await mkdir(external); else await writeFile(external, level === 'job' ? JSON.stringify(f.job) : '');
      await symlink(external, path);
      await assert.rejects(ensureLocalStyleStorage(f.project, f.root));
      assert((await lstat(path)).isSymbolicLink());
    } finally { await rm(f.base, { recursive: true, force: true }); }
  }
});

test('AI 配置目录不能借新增任务目录放宽结构要求', async () => {
  const f = await fixture();
  try {
    const ai = join(f.project, '.local-data', 'ai-config');
    await mkdir(join(ai, 'learning-jobs'), { recursive: true });
    await writeFile(join(ai, 'master.key'), Buffer.alloc(32, 7));
    await assert.rejects(ensureLocalAiStorage(f.project, f.root));
    assert.deepEqual(await readFile(join(ai, 'master.key')), Buffer.alloc(32, 7));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

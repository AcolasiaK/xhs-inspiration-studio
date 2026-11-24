import { lstat, mkdir, readFile, writeFile, readdir, rename, symlink, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const info = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const ownerName = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unsafeRecords = () => new Error('本机记录目录仍有写入任务或未知文件，迁移已暂停，原记录保留。');
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function readJobJson(file) {
  try {
    const bytes = await readFile(file);
    // A learning job includes up to 12 MiB of image data plus input/result text.
    if (bytes.length > 16 * 1024 * 1024) throw new Error('SIZE');
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch { throw new Error('学习任务无法完整读取或校验，迁移已暂停，原记录保留。'); }
}
async function learningRecords(directory, result) {
  result.set('learning-jobs', null);
  for (const owner of await readdir(directory, { withFileTypes: true })) {
    if (!owner.isDirectory() || !ownerName.test(owner.name)) throw unsafeRecords();
    const relative = join('learning-jobs', owner.name), path = join(directory, owner.name);
    result.set(relative, null);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(relative, entry.name), file = join(path, entry.name);
      if (entry.name === '.transaction-lock' && entry.isDirectory()) {
        const markers = await readdir(file, { withFileTypes: true });
        const marker = markers.length === 1 ? markers[0] : null;
        const match = marker?.name.match(/^owner-(\d+)-([a-f0-9-]+)$/i);
        const pid = match ? Number(match[1]) : 0;
        if (!marker?.isFile() || !match || !uuid.test(match[2]) || !Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) throw unsafeRecords();
        const bytes = await readFile(join(file, marker.name));
        if (bytes.length) throw unsafeRecords();
        // A confirmed dead-process mutex is preserved; the job runtime can reclaim it.
        result.set(name, null); result.set(join(name, marker.name), bytes);
        continue;
      }
      if (!entry.isFile()) throw unsafeRecords();
      const jobId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (entry.name !== 'running.json' && !uuid.test(jobId)) throw unsafeRecords();
      const { bytes, value } = await readJobJson(file);
      if (entry.name === 'running.json') {
        if (!value || Object.keys(value).sort().join(',') !== 'jobId,pid,processToken,token' || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !uuid.test(value.processToken) || !uuid.test(value.jobId) || !uuid.test(value.token)) throw unsafeRecords();
        if (processIsAlive(value.pid)) throw new Error('仍有风格分析正在运行，请先暂停分析再更新；已完成步骤保留。');
      } else {
        const snapshot = value?.snapshot;
        if (value?.version !== 1 || typeof value.owner !== 'string' || createHash('sha256').update(value.owner).digest('hex') !== owner.name
          || !ownerName.test(value.inputHash) || snapshot?.id !== jobId || !['running', 'paused', 'failed', 'completed'].includes(snapshot.status)
          || !Array.isArray(value.input?.references) || !Array.isArray(value.observations)
          || !Number.isInteger(snapshot.completedSteps) || !Number.isInteger(snapshot.totalSteps) || snapshot.completedSteps < 0 || snapshot.totalSteps < 1 || snapshot.completedSteps > snapshot.totalSteps
          || typeof snapshot.profile?.id !== 'string' || typeof snapshot.settings?.timeoutSeconds !== 'number') throw new Error('学习任务格式需要检查，未迁移或覆盖原记录。');
      }
      result.set(name, bytes);
    }
  }
}
async function records(directory, kind) {
  const styles = kind === 'personal-styles';
  const entries = await readdir(directory, { withFileTypes: true });
  const result = new Map();
  for (const entry of entries) {
    if (styles && entry.name === 'learning-jobs' && entry.isDirectory()) {
      await learningRecords(join(directory, entry.name), result);
      continue;
    }
    // Locks mean another writer may still be active. Never copy a partial store.
    const expected = styles ? /^[a-f0-9]{64}\.json$/.test(entry.name) : entry.name === 'master.key' || /^[a-f0-9]{64}\.enc$/.test(entry.name);
    if (!entry.isFile() || !expected) throw unsafeRecords();
    let bytes, value;
    try {
      bytes = await readFile(join(directory, entry.name));
      if (bytes.length > 8_000_000) throw new Error('SIZE');
      if (styles) value = JSON.parse(bytes.toString('utf8'));
      else if (entry.name === 'master.key' ? bytes.length !== 32 : !bytes.length) throw new Error('SIZE');
    } catch { throw new Error('本机记录无法完整读取或校验，迁移已暂停，原记录保留。'); }
    if (styles && (value?.version !== 1 || !Array.isArray(value.styles) || !Array.isArray(value.trials))) throw new Error('风格数据格式需要检查，未迁移或覆盖原记录。');
    result.set(entry.name, bytes);
  }
  return result;
}
const equal = (a, b) => a.size === b.size && [...a].every(([name, bytes]) => bytes === null ? b.get(name) === null : b.get(name)?.equals(bytes));

/** Called only after the managed service stops. Preserve byte-for-byte data and
 * the original directory; both development and old/new releases use one link.
 * API files remain opaque bytes: no decryption, key rotation or logs. */
async function ensureLocalPrivateStorage(project, root, kind) {
  const label = kind === 'personal-styles' ? '风格' : 'AI 配置';
  const readRecords = directory => records(directory, kind);
  const source = join(project, '.local-data', kind);
  const target = join(root, 'data', kind);
  const sourceInfo = await info(source);
  if (sourceInfo?.isSymbolicLink()) {
    if (resolve(source, '..', await readlink(source)) !== target || !(await info(target))?.isDirectory()) throw new Error(`${label}存储链接需要检查，未创建空记录或覆盖已有目录。`);
    await realpath(source); // A broken link must never turn into a fresh library.
    return { migrated: false, target };
  }
  if (sourceInfo && !sourceInfo.isDirectory()) throw new Error(`${label}存储路径不是目录，原文件保留。`);
  await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.local-data'), { recursive: true, mode: 0o700 });
  const existing = await info(target);
  if (existing && !existing.isDirectory()) throw new Error(`${label}目标路径无效，未覆盖。`);
  if (!sourceInfo && !existing && (await readdir(join(project, '.local-data'))).some(name => name.startsWith(`${kind}.before-local-storage-`))) throw new Error(`${label}工作目录缺失但存在历史备份，未创建空记录；请先恢复备份。`);
  const before = sourceInfo ? await readRecords(source) : null;
  if (existing) {
    // Crash recovery can reconnect a completed copy; conflicting stores are
    // never merged by guessing which version is newest.
    const saved = await readRecords(target);
    if (before && !equal(before, saved)) throw new Error(`发现两份不同的${label}记录，迁移已停止，双方文件均保留。`);
  } else {
    const staging = join(root, 'data', `.${kind}-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    for (const [name, bytes] of before || []) {
      const path = join(staging, name);
      if (bytes === null) await mkdir(path, { recursive: true, mode: 0o700 });
      else { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    }
    if (!equal(before || new Map(), await readRecords(staging))) throw new Error(`${label}复制校验失败，原记录保留。`);
    await rename(staging, target);
  }
  if (before && !equal(before, await readRecords(source))) throw new Error(`${label}在迁移期间被修改，请先结束编辑再重试；原记录保留。`);
  const temporary = `${source}.link-${randomUUID()}`;
  const backup = `${source}.before-local-storage-${randomUUID()}`;
  await symlink(target, temporary);
  let moved = false;
  try {
    if (sourceInfo) { await rename(source, backup); moved = true; }
    await rename(temporary, source);
  } catch (error) {
    if (moved && !await info(source)) await rename(backup, source);
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { migrated: true, target, ...(moved ? { backup } : {}) };
}

export const ensureLocalStyleStorage = (project, root) => ensureLocalPrivateStorage(project, root, 'personal-styles');
export const ensureLocalAiStorage = (project, root) => ensureLocalPrivateStorage(project, root, 'ai-config');

import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const files = ['xhs-hotspots-rules.json', 'xhs-hotspots-v2.json'];
const directories = ['xhs-covers', 'xhs-topic-cache'];
const info = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function checkWriters(source) {
  for (const name of files) {
    const lock = join(source, name + '.lock');
    if (!await info(lock)) continue;
    const data = JSON.parse(await readFile(lock, 'utf8'));
    const pid = typeof data === 'number' ? data : data?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; }
    }
    throw new Error('热点采集或规则写入正在运行，请等待完成后再更新。');
  }
}

// Only the live hotspot files belong here. Credentials, backups and drafts use their own storage.
async function inventory(directory) {
  const entries = [];
  async function record(name) {
    const stat = await lstat(join(directory, name), { bigint: true });
    if (!stat?.isFile()) throw new Error('热点存储中有无法核对的文件，已保留原记录。');
    entries.push([name, [stat.ino, stat.size, stat.mtimeNs].join('/')]);
  }
  for (const name of files) if (await info(join(directory, name))) await record(name);
  for (const name of directories) {
    const path = join(directory, name), stat = await info(path);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new Error('热点素材目录需要检查，已保留原记录。');
    entries.push([name, null]);
    for (const file of (await readdir(path)).sort()) await record(join(name, file));
  }
  return entries;
}

/** Keep the legacy records for rollback. New releases and local development share the durable directory. */
export async function prepareLocalHotspotStorage(project, root) {
  const source = join(project, '.local-data'), link = join(source, 'xhs-hotspots');
  const parent = join(root, 'data'), target = join(parent, 'hotspots');
  const linked = await info(link), existing = await info(target);
  if (linked) {
    if (!linked.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== target || !existing?.isDirectory()) {
      throw new Error('热点存储链接需要检查，已有规则和榜单均已保留。');
    }
    return { activate: async () => target, discard: async () => {} };
  }
  await mkdir(source, { recursive: true, mode: 0o700 });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await checkWriters(source);
  const stage = await mkdtemp(join(parent, '.hotspots-'));
  const discard = () => rm(stage, { recursive: true, force: true });
  try {
    const entries = await inventory(source);
    if (existing) {
      const names = list => list.map(([name, stamp]) => [name, stamp !== null]);
      if (!existing.isDirectory() || JSON.stringify(names(await inventory(target))) !== JSON.stringify(names(entries))) {
        throw new Error('发现两份不同的热点数据，已保留双方记录。');
      }
    }
    const pending = [];
    for (const [name, stamp] of entries) {
      if (stamp === null) await mkdir(join(stage, name), { mode: 0o700 });
      else pending.push(name);
    }
    // Native copyfile can wait on FileProvider metadata for every cover. Read
    // the actual bytes in bounded batches and verify the local copy before use.
    for (let i = 0; i < pending.length; i += 12) {
      const batch = await Promise.allSettled(pending.slice(i, i + 12).map(async name => {
        const bytes = await readFile(join(source, name));
        if (!existing) await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o600 });
        if (!(await readFile(join(existing ? target : stage, name))).equals(bytes)) throw new Error('热点副本内容不一致，已有记录保留。');
      }));
      for (const item of batch) if (item.status === 'rejected') throw item.reason;
    }
    return { discard, activate: async () => {
      await checkWriters(source);
      if (JSON.stringify(await inventory(source)) !== JSON.stringify(entries)) throw new Error('复制期间热点记录已变动，原记录保留，请重新更新。');
      if (!existing) await rename(stage, target);
      await symlink(target, link);
      return target;
    } };
  } catch (error) { await discard(); throw error; }
}

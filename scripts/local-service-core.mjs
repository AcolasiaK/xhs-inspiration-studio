import { get } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export const APP = 'xhs-inspiration-studio';
export const tokenFor = project => createHash('sha256').update(project).digest('hex').slice(0, 16);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function switchRelease(root, release) {
  const temp = join(root, `current-${randomUUID()}`);
  await symlink(release, temp);
  await rename(temp, join(root, 'current'));
}
// Native HTTP to literal loopback: never use a proxy, redirect, API or model call.
export function probe(port = 3000, timeout = 5000, pathname = '/api/local-health') {
  return new Promise(resolve => {
    let completed = false;
    const finish = result => { if (!completed) { completed = true; clearTimeout(deadline); resolve(result); } };
    const req = get({ host: '127.0.0.1', port, path: pathname, agent: false }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        let body; try { body = JSON.parse(text); } catch { /* HTML/other service. */ }
        finish({ code: res.statusCode, body });
      });
      res.on('error', () => finish({ code: 0 }));
    });
    const deadline = setTimeout(() => { finish({ code: 0 }); req.destroy(); }, timeout);
    req.on('error', () => finish({ code: 0 }));
  });
}
export const healthy = (result, instance, release) => result.code === 200 &&
  result.body?.app === APP && result.body.status === 'ok' && result.body.instance === instance &&
  (!release || result.body.release === release);
export async function waitHealthy(instance, release, port = 3000, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (healthy(await probe(port), instance, release)) return true;
    await sleep(500);
  }
  return false;
}
export async function waitStopped(isRegistered, previousPid, timeout = 30_000, interval = 250) {
  const deadline = Date.now() + timeout;
  while (isRegistered() || pidAlive(previousPid)) {
    if (Date.now() > deadline) throw new Error('旧服务尚未完全退出，已暂停切换；未终止未知进程。');
    await sleep(interval);
  }
}
// Unique owner marker avoids deleting a new owner's lock during stale recovery.
export async function acquireLock(root) {
  const lock = join(root, 'operation.lock'), marker = `owner-${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, marker), '', { flag: 'wx', mode: 0o600 });
      return async () => { await unlink(join(lock, marker)).catch(() => {}); await rmdir(lock).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entries = await readdir(lock);
      const match = entries.length === 1 && /^owner-(\d+)-[a-f0-9-]+$/.exec(entries[0]);
      if (match && !pidAlive(Number(match[1]))) {
        try { await unlink(join(lock, entries[0])); await rmdir(lock); } catch { /* Another contender won. */ }
      } else if (entries.length === 0 && Date.now() - (await stat(lock)).mtimeMs > 30_000) {
        await rmdir(lock).catch(() => {});
      } else throw new Error('另一个启动或更新操作正在进行，请稍后重试。');
    }
  }
  throw new Error('启动锁正在使用中，请稍后重试。');
}
export const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
export function launchAgent({ root, label }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(join(root, 'bin/node'))}</string><string>${xml(join(root, 'tools/local-service-runner.mjs'))}</string><string>${xml(root)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Interactive</string><key>Umask</key><integer>63</integer>
<key>AbandonProcessGroup</key><false/>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>${xml(join(root, 'logs/launchd.log'))}</string>
</dict></plist>\n`;
}
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

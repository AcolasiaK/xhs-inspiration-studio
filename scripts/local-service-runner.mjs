import { spawn } from 'node:child_process';
import { readFile, realpath, appendFile, stat, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, healthy, probe } from './local-service-core.mjs';

const root = process.argv[2];
process.umask(0o077);
const release = await realpath(join(root, 'current'));
const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
const log = join(root, 'logs/service.log');
await mkdir(join(root, 'logs'), { recursive: true, mode: 0o700 });
if ((await stat(log).catch(() => ({ size: 0 }))).size > 2_000_000) await rename(log, `${log}.previous`);
const record = message => appendFile(log, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }).catch(() => {});
let stopping = false, failures = 0, checking = false;
const child = spawn(join(root, 'bin/node'), [join(release, 'server.js')], {
  cwd: release,
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...process.env,
    NODE_ENV: 'production', APP_MODE: 'local', APP_LOCAL_ONLY: '1',
    XHS_HOTSPOTS_SCHEDULER: process.env.XHS_HOTSPOTS_SCHEDULER || '1',
    XHS_HOTSPOTS_DIR: join(root, 'data', 'hotspots'),
    HOSTNAME: '127.0.0.1', PORT: '3000', NEXT_TELEMETRY_DISABLED: '1',
    XHS_LOCAL_INSTANCE: manifest.instance, XHS_LOCAL_RELEASE: manifest.release },
  // No raw upstream errors, request bodies or credentials in persistent service logs.
  stdio: ['ignore', 'ignore', 'ignore'],
});
void atomicJson(join(root, 'running.json'), { supervisorPid: process.pid, serverPid: child.pid, release: manifest.release });
void record(`服务启动 pid=${child.pid} release=${manifest.release}`);
let forceStop, timer;
const stop = reason => {
  if (stopping) return;
  stopping = true;
  void record(reason);
  child.kill('SIGTERM');
  forceStop = setTimeout(() => child.kill('SIGKILL'), 10_000);
};
process.on('SIGTERM', () => stop('服务正在停止'));
process.on('SIGINT', () => stop('服务正在停止'));
child.on('error', async () => { await record('服务进程无法启动；由系统稍后重试'); process.exit(1); });
child.on('exit', async (code, signal) => {
  clearInterval(timer); clearTimeout(forceStop);
  await record(`服务退出 code=${code} signal=${signal || 'none'}`);
  process.exit(stopping ? 0 : 1);
});
const started = Date.now();
timer = setInterval(async () => {
  if (stopping || checking || Date.now() - started < 30_000) return;
  checking = true;
  try {
    if (healthy(await probe(), manifest.instance, manifest.release)) failures = 0;
    else if (++failures >= 3) stop('连续三次健康检查未通过；重启当前版本');
  } finally { checking = false; }
}, 15_000);

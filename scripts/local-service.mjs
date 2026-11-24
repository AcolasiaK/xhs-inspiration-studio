import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, cp, copyFile, chmod, writeFile, readlink, realpath, symlink, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireLock, atomicJson, healthy, launchAgent, probe, readJson, sleep, switchRelease, tokenFor, waitHealthy, waitStopped } from './local-service-core.mjs';
import { ensureLocalStyleStorage, ensureLocalAiStorage } from './local-style-storage.mjs';
import { prepareLocalHotspotStorage } from './local-hotspot-storage.mjs';

process.umask(0o077);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const installed = existsSync(join(scriptDir, '../installation.json'));
const project = installed ? (await readJson(join(scriptDir, '../installation.json'))).project : await realpath(join(scriptDir, '..'));
const instance = tokenFor(project);
const root = join(homedir(), 'Library/Application Support/XHSWorkbench', instance);
const label = `com.acolasia.xhs-workbench.${instance}`;
const target = `gui/${process.getuid()}/${label}`;
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const command = process.argv[2] || 'start';
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', ...options });
const loaded = () => run('/bin/launchctl', ['print', target]).status === 0;
const current = () => readlink(join(root, 'current')).catch(() => null);
const serviceMessage = `本机工作台：http://127.0.0.1:3000/personal\n服务日志：${join(root, 'logs/service.log')}`;

async function ensureInstalled() {
  if (!await current()) throw new Error('尚未安装稳定版。请在项目目录执行 npm run local:install。');
}
async function start() {
  await ensureInstalled();
  const release = (await readJson(join(root, 'current/release.json'))).release;
  const status = await probe();
  if (healthy(status, instance, release)) { console.log(serviceMessage); return; }
  if (!loaded()) {
    // Refuse to adopt or kill an unrelated service, even if it returns HTTP 200.
    const listener = run('/usr/sbin/lsof', ['-nP', '-iTCP:3000', '-sTCP:LISTEN', '-t']);
    if (listener.status === 0) throw new Error('3000 端口已有其他服务。未停止它，也未切换端口；请先确认并关闭占用服务。');
    if (run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]).status !== 0 && !loaded()) {
      throw new Error('macOS 未能载入本机服务，请检查当前账号的后台项目设置。');
    }
  }
  // Do not kickstart -k on every double-click: that would interrupt active AI jobs.
  if (!await waitHealthy(instance, release)) throw new Error(`服务尚未就绪，后台会继续恢复。${serviceMessage}`);
  console.log(serviceMessage);
}
async function stop() {
  const wasLoaded = loaded();
  const previous = wasLoaded ? await readJson(join(root, 'running.json')).catch(() => null) : null;
  if (wasLoaded && run('/bin/launchctl', ['bootout', target]).status !== 0) throw new Error('未能停止服务，请稍后重试。');
  // bootout can return while the old process is still draining. A new start
  // must not mistake that dying registration for an already-running new job.
  await waitStopped(loaded, previous?.serverPid);
  console.log('本次登录期间服务已停止；再次双击启动文件或下次登录可重新启动。');
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function validateRelease(release, manifest) {
  const port = await freePort();
  const candidate = spawn(join(root, 'bin/node'), [join(release, 'server.js')], {
    cwd: release, stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production', APP_MODE: 'local', APP_LOCAL_ONLY: '1',
      HOSTNAME: '127.0.0.1', PORT: String(port), NEXT_TELEMETRY_DISABLED: '1',
      XHS_HOTSPOTS_SCHEDULER: '0',
      XHS_LOCAL_INSTANCE: instance, XHS_LOCAL_RELEASE: manifest.release },
  });
  let exited = false;
  candidate.once('error', () => { exited = true; });
  candidate.once('exit', () => { exited = true; });
  try {
    if (!await waitHealthy(instance, manifest.release, port)) throw new Error('新版本健康检查未通过，当前版本保持不变。');
    for (const path of ['/', '/personal', '/personal/styles', '/settings/ai', '/hotspots', '/video']) {
      if ((await probe(port, 15_000, path)).code !== 200) throw new Error(`新版本页面 ${path} 未通过检查，当前版本保持不变。`);
    }
  } finally {
    if (!exited) candidate.kill('SIGTERM');
    for (let i = 0; !exited && i < 20; i++) await sleep(100);
    if (!exited) candidate.kill('SIGKILL');
  }
}
async function prepare() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  for (const dir of ['bin', 'tools', 'releases', 'logs']) await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  if (!existsSync(join(root, 'bin/node'))) {
    await copyFile(process.execPath, join(root, 'bin/node'));
    await chmod(join(root, 'bin/node'), 0o700);
  }
  // Both compilation and serving stay outside Documents/FileProvider. Never clean
  // the checkout's .next or race its running dev server/type checker.
  const id = `${Date.now()}`, workspace = join(root, `build-${id}`);
  await mkdir(workspace, { mode: 0o700 });
  console.log('正在准备独立构建目录；已有服务继续运行…');
  for (const name of ['app', 'components', 'lib', 'public', 'vendor', 'package.json', 'package-lock.json',
    'next.config.ts', 'next-env.d.ts', 'tsconfig.json', 'postcss.config.mjs', 'instrumentation.ts',
    '.env', '.env.local', '.env.production', '.env.production.local']) {
    if (existsSync(join(project, name))) await cp(join(project, name), join(workspace, name), { recursive: true, dereference: true });
  }
  const npmRoot = join(root, 'tools/npm');
  if (!existsSync(join(npmRoot, 'bin/npm-cli.js'))) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli)) throw new Error('首次安装请使用 npm run local:install，准备离线更新工具。');
    await cp(dirname(dirname(await realpath(npmCli))), npmRoot, { recursive: true });
  }
  // Read integrity-checked tarballs from npm's local cache instead of copying
  // FileProvider placeholder files. No network, lifecycle scripts or upgrades.
  const dependencies = spawn(join(root, 'bin/node'), [join(npmRoot, 'bin/npm-cli.js'), 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: workspace, stdio: 'inherit', env: { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  const depCode = await new Promise((resolve, reject) => { dependencies.once('error', reject); dependencies.once('exit', resolve); });
  if (depCode !== 0) throw new Error('离线依赖缓存不完整，未替换当前版本。请先在项目中完成 npm ci，再重新更新。');
  console.log('正在构建稳定版；已有服务继续运行…');
  const buildNext = () => {
    const build = spawn(join(root, 'bin/node'), [join(workspace, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
      cwd: workspace, stdio: 'inherit',
      env: { ...process.env, XHS_LOCAL_STANDALONE: '1', NEXT_TELEMETRY_DISABLED: '1', APP_MODE: 'local', APP_LOCAL_ONLY: '1' },
    });
    return new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', resolve); });
  };
  let code = await buildNext();
  if (code === 1) {
    // Next records its permitted retry in this fresh build directory. A new
    // directory would issue the same reminder again instead of claiming it.
    const receipts = await readdir(join(workspace, '.next/cache/next-agentic-upgrade-retries')).catch(() => []);
    if (receipts.some(file => /^[a-f0-9]{64}\.json$/u.test(file))) {
      console.log('Next.js 已提示安全升级，按其提示在同一构建目录重试一次…');
      code = await buildNext();
    }
  }
  if (code !== 0) throw new Error('构建失败，正在使用的版本未被替换。');
  const release = join(root, 'releases', id);
  await cp(join(workspace, '.next/standalone'), release, { recursive: true, dereference: true,
    filter: path => !path.endsWith('/.local-data') && !path.split('/').at(-1).startsWith('.env') });
  await cp(join(workspace, '.next/static'), join(release, '.next/static'), { recursive: true });
  if (existsSync(join(workspace, 'public'))) await cp(join(workspace, 'public'), join(release, 'public'), { recursive: true });
  await cp(join(workspace, 'vendor/humanizer-zh'), join(release, 'vendor/humanizer-zh'), { recursive: true });
  // Keep one authoritative data directory. No migrations, decryptions or data copies.
  await symlink(join(project, '.local-data'), join(release, '.local-data'));
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (existsSync(join(workspace, name))) { await copyFile(join(workspace, name), join(release, name)); await chmod(join(release, name), 0o600); }
  }
  const manifest = { instance, release: id, createdAt: new Date().toISOString() };
  await atomicJson(join(release, 'release.json'), manifest);
  await validateRelease(release, manifest);
  await rm(workspace, { recursive: true }); // This invocation's disposable build only.
  // Copy management tools only after a candidate has passed. No credentials in launchd.
  for (const name of ['local-service.mjs', 'local-service-core.mjs', 'local-service-runner.mjs', 'local-style-storage.mjs', 'local-hotspot-storage.mjs']) {
    if (join(scriptDir, name) !== join(root, 'tools', name)) await copyFile(join(project, 'scripts', name), join(root, 'tools', name));
  }
  await atomicJson(join(root, 'installation.json'), { project });
  await atomicJson(join(root, 'prepared.json'), { release });
  console.log('新版本已通过健康检查和六个页面检查，可以启用。');
}
async function activate() {
  const { release } = await readJson(join(root, 'prepared.json'));
  if (!release.startsWith(join(root, 'releases') + '/')) throw new Error('待启用版本路径无效。');
  const manifest = await readJson(join(release, 'release.json'));
  const old = await current();
  if (!loaded() && run('/usr/sbin/lsof', ['-nP', '-iTCP:3000', '-sTCP:LISTEN', '-t']).status === 0) {
    throw new Error('稳定版已准备好，但 3000 端口仍被其他进程占用。未结束未知进程，请确认后停止旧服务，再运行 npm run local:activate。');
  }
  const hotspotCopy = await prepareLocalHotspotStorage(project, root);
  try {
    await activatePreparedRelease(release, old, manifest, hotspotCopy);
  } finally { await hotspotCopy.discard(); }
}
async function activatePreparedRelease(release, old, manifest, hotspotCopy) {
  if (loaded()) {
    const hotspots = await probe(3000, 15_000, '/api/hotspots?check=storage');
    if (hotspots.body?.updating || hotspots.body?.analyzing?.length) throw new Error('当前热点采集或拆解仍在运行，请等它完成后再启用更新。');
    const learning = await probe(3000, 15_000, '/api/personal/styles/learning-jobs');
    if (learning.code === 200 && learning.body?.jobs?.some(job => job.status === 'running')) {
      throw new Error('新版本已准备好，当前风格分析仍在进行。请等它完成，或在页面暂停并保存进度后，再运行 npm run local:activate。');
    }
    // Older releases have no background-job endpoint. For a current endpoint,
    // an unreadable status must not lead to terminating potentially paid work.
    if (learning.code !== 200 && learning.code !== 404) throw new Error('暂时无法确认后台分析状态，未切换运行版本。请检查工作台后重试启用。');
  }
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(plist, launchAgent({ root, label }), { mode: 0o600 });
  if (run('/usr/bin/plutil', ['-lint', plist]).status !== 0) throw new Error('本机服务配置校验失败。');
  if (loaded()) await stop();
  try {
    await ensureLocalStyleStorage(project, root);
    await ensureLocalAiStorage(project, root);
    await hotspotCopy.activate();
    await switchRelease(root, release);
    await start();
    const styles = await probe(3000, 15_000, '/api/personal/styles');
    if (styles.code !== 200 || !Array.isArray(styles.body?.styles)) throw new Error('风格记录读取检查未通过，原记录保留。');
    const profiles = await probe(3000, 15_000, '/api/ai/profiles');
    if (profiles.code !== 200 || !Array.isArray(profiles.body?.profiles)) throw new Error('AI 配置读取检查未通过，原加密记录和密钥保留。');
    const hotspots = await probe(3000, 15_000, '/api/hotspots?check=storage');
    if (hotspots.code !== 200 || hotspots.body?.storage !== 'disk' || !hotspots.body?.revision) throw new Error('热点规则、榜单读取检查失败，已保留原记录。');
    await atomicJson(join(root, 'last-good.json'), { release, previous: old });
    console.log(`稳定版 ${manifest.release} 已启用；登录自动启动、异常退出自动恢复。`);
  } catch (error) {
    if (loaded()) await stop();
    if (old) { await switchRelease(root, old); await start(); console.log('启用失败，已恢复上一个正常版本。'); }
    throw error;
  }
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('此启动器适用于 macOS；其他系统请使用项目 npm 启动命令。');
  if (!['start', 'stop', 'status', 'prepare', 'activate', 'install', 'update'].includes(command)) throw new Error('不支持的服务操作。');
  if (command === 'status') {
    console.log(JSON.stringify({ managed: loaded(), health: await probe(), releases: existsSync(join(root, 'releases')) ? await readdir(join(root, 'releases')) : [] }, null, 2));
    return;
  }
  // Repeated opens of a healthy managed app must not contend on an update lock
  // or restart its active generation requests.
  if (command === 'start' && loaded() && healthy(await probe(), instance)) {
    console.log(serviceMessage); return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  let releaseLock;
  try { releaseLock = await acquireLock(root); }
  catch (error) {
    if (command === 'start' && await waitHealthy(instance)) { console.log(serviceMessage); return; }
    throw error;
  }
  try {
    if (command === 'start') await start();
    if (command === 'stop') await stop();
    if (['prepare', 'install', 'update'].includes(command)) await prepare();
    if (['activate', 'install', 'update'].includes(command)) await activate();
  } finally { await releaseLock(); }
}
try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

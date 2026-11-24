import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, atomicJson, healthy, launchAgent, switchRelease, tokenFor, waitStopped } from '../scripts/local-service-core.mjs';
import { GET } from '../app/api/local-health/route';

test('健康检查验证应用、项目和版本，不将任意 HTTP 200 当作工作台', () => {
  const body = { app: 'xhs-inspiration-studio', status: 'ok', instance: 'project-a', release: 'v1' };
  assert.equal(healthy({ code: 200, body }, 'project-a', 'v1'), true);
  for (const status of [{ code: 200 }, { code: 503, body }, { code: 200, body: { ...body, instance: 'other' } }, { code: 200, body: { ...body, release: 'v2' } }]) {
    assert.equal(healthy(status, 'project-a', 'v1'), false);
  }
});
test('双击互斥、释放锁、崩溃遗留锁恢复，不删除其他文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-service-lock-'));
  try {
    await writeFile(join(root, 'user-data'), 'preserved');
    const unlock = await acquireLock(root);
    await assert.rejects(acquireLock(root), /正在进行/);
    await unlock();
    await mkdir(join(root, 'operation.lock'));
    await writeFile(join(root, 'operation.lock/owner-2147483647-aaaa'), '');
    const recovered = await acquireLock(root); await recovered();
    assert.equal(await readFile(join(root, 'user-data'), 'utf8'), 'preserved');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('版本切换与回退只改变入口，不删除旧版和数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-service-release-'));
  try {
    await mkdir(join(root, 'v1')); await mkdir(join(root, 'v2'));
    await atomicJson(join(root, 'v1/manifest.json'), { version: 1 });
    await switchRelease(root, join(root, 'v1'));
    await switchRelease(root, join(root, 'v2'));
    assert.equal(await readlink(join(root, 'current')), join(root, 'v2'));
    await switchRelease(root, join(root, 'v1'));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'current/manifest.json'), 'utf8')), { version: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('LaunchAgent 使用绝对路径和自动恢复，不存 API 密钥', () => {
  const text = launchAgent({ root: '/tmp/user & name/workbench', label: 'test.service' });
  assert.match(text, /KeepAlive<\/key><true\/>/);
  assert.match(text, /AbandonProcessGroup<\/key><false\/>/);
  assert.match(text, /user &amp; name/);
  assert.doesNotMatch(text, /OPENAI_API_KEY|AI_CONFIG_SECRET|0\.0\.0\.0|sudo/);
  assert.equal(tokenFor('/project'), tokenFor('/project'));
  assert.notEqual(tokenFor('/project'), tokenFor('/different'));
});
test('健康接口只在本机模式开放，无副作用且不泄露配置', async () => {
  const before = { ...process.env };
  try {
    delete process.env.VERCEL;
    Object.assign(process.env, { APP_MODE: 'local', APP_LOCAL_ONLY: '1', XHS_LOCAL_INSTANCE: 'test', XHS_LOCAL_RELEASE: 'v1', OPENAI_API_KEY: 'secret-sentinel' });
    const req = (host: string) => new Request(`http://${host}/api/local-health`, { headers: { host } });
    const good = GET(req('127.0.0.1:3000'));
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await good.json(), { app: 'xhs-inspiration-studio', status: 'ok', instance: 'test', release: 'v1' });
    assert.equal(GET(req('example.com')).status, 403);
    process.env.APP_MODE = 'cloud';
    assert.equal(GET(req('127.0.0.1:3000')).status, 404);
  } finally { process.env = before; }
});
test('切换必须等待旧任务注册和进程都退出，超时不结束未知进程', async () => {
  let registered = true, finished = false;
  const waiting = waitStopped(() => registered, undefined, 200, 5).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(finished, false);
  registered = false;
  await waiting;
  assert.equal(finished, true);
  await assert.rejects(waitStopped(() => false, process.pid, 20, 5), /旧服务尚未完全退出/);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

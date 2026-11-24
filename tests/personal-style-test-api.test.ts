import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST, maxDuration } from '../app/api/personal/styles/test/route';
import { aiTransport } from '../lib/server/ai/provider';
import { listPersonalStyles } from '../lib/server/personal-style-store';
import { emptyPersonalInput } from '../lib/personal/schema';

const env = { ...process.env };
let directory: string, versionId: string, clock = Date.now();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-style-route-test-'));
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_CONFIG_DIR: join(directory, 'ai'),
    PERSONAL_STYLES_DIR: join(directory, 'styles'), AI_CONFIG_SECRET: '',
    OPENAI_API_KEY: 'synthetic-style-route-key', OPENAI_MODEL: 'synthetic-model', OPENAI_BASE_URL: 'https://api.openai.com/v1' };
  delete process.env.VERCEL;
  clock += 60_001; mock.method(Date, 'now', () => clock);
  versionId = (await listPersonalStyles('local-owner')).styles.find(style => style.id === 'daily')!.draftVersionId;
});
afterEach(async () => { mock.restoreAll(); process.env = env; await rm(directory, { recursive: true, force: true }); });
function request(signal?: AbortSignal) {
  const form = new FormData();
  form.set('payload', JSON.stringify({ id: 'daily', versionId, kind: 'body', input: { ...emptyPersonalInput, experience: '合成测试：公园散步。' }, imageIds: [] }));
  return new Request('http://localhost/api/personal/styles/test', { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost' }, body: form, signal });
}
function answer() { return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ body: '合成试生成正文，仅用于验证。' }) }] }] }); }
function shortBudget() {
  const original = AbortSignal.timeout;
  mock.method(AbortSignal, 'timeout', (milliseconds: number) => original(milliseconds === 190_000 ? 25 : milliseconds));
}
function manualBudget() {
  const original = AbortSignal.timeout, deadline = new AbortController();
  mock.method(AbortSignal, 'timeout', (milliseconds: number) => milliseconds === 190_000 ? deadline.signal : original(milliseconds));
  return () => deadline.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
}
function delayedModel() {
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const transport = mock.method(aiTransport, 'fetch', async () => { entered(); await hold; return answer(); });
  return { start, release, transport };
}

test('风格试生成平台限时覆盖已有总预算，成功时仅记录一次试生成', async () => {
  assert(maxDuration * 1000 > 190_000);
  const transport = mock.method(aiTransport, 'fetch', async () => answer());
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.match((await response.json()).trial.output, /合成试生成正文/);
  assert.equal(transport.mock.callCount(), 1);
  assert.equal((await listPersonalStyles('local-owner')).trials.length, 1);
});

test('风格试生成总预算到期返回 TIMEOUT/504，忽略取消的迟到结果不记录', async () => {
  const model = delayedModel(), expire = manualBudget();
  try {
    const pending = POST(request());
    await model.start; expire();
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'TIMEOUT');
    model.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await listPersonalStyles('local-owner')).trials.length, 0);
  } finally { model.release(); }
});

test('风格试生成用户主动取消返回 CANCELLED/499，迟到结果不记录', async () => {
  const model = delayedModel(), controller = new AbortController();
  const pending = POST(request(controller.signal));
  await model.start; controller.abort();
  try {
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal((await response.json()).error.code, 'CANCELLED');
    model.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await listPersonalStyles('local-owner')).trials.length, 0);
  } finally { model.release(); }
});

test('风格试生成开始前已取消，不发送任何模型请求', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => { throw new Error('No outbound request expected'); });
  const controller = new AbortController(); controller.abort();
  const response = await POST(request(controller.signal));
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, 'CANCELLED');
  assert.equal(transport.mock.callCount(), 0);
});

test('风格试生成读取表单超时也返回 TIMEOUT，而非上传取消', async () => {
  shortBudget(); let cancelled = false;
  const transport = mock.method(aiTransport, 'fetch', async () => { throw new Error('No outbound request expected'); });
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const stalled = new Request('http://localhost/api/personal/styles/test', { method: 'POST', headers: {
    host: 'localhost', origin: 'http://localhost', 'content-type': 'multipart/form-data; boundary=test',
  }, body: stream, duplex: 'half' } as RequestInit);
  const keep = setTimeout(() => {}, 1000);
  try {
    const response = await POST(stalled);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'TIMEOUT');
    assert.equal(cancelled, true);
    assert.equal(transport.mock.callCount(), 0);
  } finally { clearTimeout(keep); }
});

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { POST as hotspots } from '../app/api/hotspots/route';
import { POST as settings } from '../app/api/ai/profiles/route';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { blankCategory } from '../lib/xhs-hotspots';
import { analyzeXhsNote } from '../lib/server/xhs-hotspots-ai';
import { aiTransport } from '../lib/server/ai/provider';
import { saveProfile, setDefault, readStateFor } from '../lib/server/ai/store';
import { checkRateLimit, RateLimitError } from '../lib/server/guard';
import { AppError } from '../lib/errors';
import { xhsFixtureNote as item, xhsFixtureAnalysis, xhsFixtureIngestContent } from './xhs-fixture';

const env = { ...process.env };
const globals = globalThis as typeof globalThis & { __xhsHotspotsV2?: XhsHotspotsStore };
const previousStore = globals.__xhsHotspotsV2;
let directory: string, store: XhsHotspotsStore, now = Date.now();
const content = xhsFixtureIngestContent;
const profileInput = { name: 'selected', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'synthetic-selected-model', apiKey: 'synthetic-selected-key', jsonMode: 'schema' };
const response = (content: unknown) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(content) }] }] });
function request(path: string, body: unknown, profileId?: string) {
  return new Request(`http://127.0.0.1:3000/api/${path}`, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json', 'X-Request-ID': randomUUID(), ...(profileId ? { 'X-AI-Profile': profileId } : {}) }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-hotspot-calls-'));
  now += 60001; mock.method(Date, 'now', () => now);
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_CONFIG_DIR: join(directory, 'profiles'), AI_CONFIG_SECRET: '', OPENAI_API_KEY: '', OPENAI_MODEL: '' };
  delete process.env.VERCEL;
  store = new XhsHotspotsStore({ file: join(directory, 'hotspots.json'), now: () => new Date(now), collect: async (date, _progress, save) => { for (const category of ['travel', 'wedding', 'daily'] as const) await save(category, { ...blankCategory(), notes: category === 'travel' ? [item] : [], collectedAt: date, attemptedAt: date }); }, analyze: analyzeXhsNote });
  await store.update(true); await store.waitForUpdate(); globals.__xhsHotspotsV2 = store;
});
afterEach(async () => {
  mock.restoreAll(); process.env = { ...env }; globals.__xhsHotspotsV2 = previousStore;
  await rm(directory, { recursive: true, force: true });
});

test('设置页模型列表、文字测试和正式热点拆解调用采用同一所选配置及统一传输，不误用默认或旧环境', async () => {
  const old = await saveProfile('local-owner', { ...profileInput, name: 'old default', provider: 'custom', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-old-key', model: 'old-model' });
  await setDefault('local-owner', old.id);
  const selected = await saveProfile('local-owner', profileInput);
  process.env.OPENAI_API_KEY = 'synthetic-env-key'; process.env.OPENAI_MODEL = 'env-model';
  let fail = false;
  const transport = mock.method(aiTransport, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input); assert.equal(new URL(url).origin, 'https://api.openai.com');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + profileInput.apiKey);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: profileInput.model }] });
    const sent = JSON.parse(String(init?.body)); assert.equal(sent.model, profileInput.model); assert.equal(sent.store, false);
    assert.equal(new URL(url).pathname, '/v1/responses');
    if (sent.text.format.name === 'connection_test') return response({ value: 'OK' });
    if (fail) throw new TypeError('network', { cause: new AppError('UNSAFE_ADDRESS', '请求在地址解析校验阶段停止。', 400) });
    assert.equal(sent.text.format.name, 'xhs_ingest_analysis');
    assert.match(sent.input[0].content, /人群 × 场景/);
    return response(content);
  });
  let result = await settings(request('ai/profiles', { action: 'models', id: selected.id, revision: selected.revision }));
  assert.equal(result.status, 200); assert.deepEqual((await result.json()).models, [profileInput.model]);
  // A model list alone must never mark text or image capability as passed.
  let saved = (await readStateFor('local-owner')).profiles.find(p => p.id === selected.id)!;
  assert.equal(saved.textTest.status, 'unverified'); assert.equal(saved.imageTest.status, 'unverified');
  result = await settings(request('ai/profiles', { action: 'test', id: selected.id, kind: 'text' }));
  assert.equal((await result.json()).probe.status, 'passed');
  const outgoing = request('hotspots', { action: 'analyze', noteId: item.id, force: true }, selected.id);
  result = await hotspots(outgoing); assert.equal(result.status, 200);
  assert.equal(result.headers.get('X-Request-ID'), outgoing.headers.get('X-Request-ID'));
  const successful = await result.json(); assert.equal(successful.analysis.content.summary, content.summary); assert.equal(successful.analysis.coverObserved, false); assert.equal(successful.analysis.method, 'xiaohongshu-ingest'); assert.equal(successful.analysis.content.derivedTopics.length, 5); assert.match(successful.analysis.content.cover, /未读取封面/);
  fail = true; result = await hotspots(request('hotspots', { action: 'analyze', noteId: item.id, force: true }, selected.id));
  assert.equal(result.status, 400); assert.equal((await result.json()).error.code, 'UNSAFE_ADDRESS');
  assert.deepEqual((await store.state()).analyses[item.id], successful.analysis); assert.equal(transport.mock.callCount(), 4);
  saved = (await readStateFor('local-owner')).profiles.find(p => p.id === selected.id)!;
  assert.equal(saved.revision, selected.revision); assert.equal(saved.imageTest.status, 'unverified');
  assert.equal((await readStateFor('local-owner')).defaultId, old.id);
});

test('工作台拆解限流与刷新限流独立，返回实际剩余时间及请求 ID，过期后允许手动重试', async () => {
  const p = await saveProfile('local-owner', profileInput);
  const state = await store.state(); const suggest = mock.method(store, 'analyze', async () => xhsFixtureAnalysis);
  const update = mock.method(store, 'update', async () => state);
  for (let i = 0; i < 4; i++) assert.equal((await hotspots(request('hotspots', { action: 'analyze', noteId: item.id, force: true }, p.id))).status, 200);
  now += 12001;
  const outgoing = request('hotspots', { action: 'analyze', noteId: item.id, force: true }, p.id), limited = await hotspots(outgoing), body = await limited.json();
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '48');
  assert.equal(body.error.code, 'RATE_LIMIT'); assert.equal(body.error.scope, 'hotspots_suggest'); assert.match(body.error.message, /工作台选题建议/);
  assert.equal(Date.parse(body.error.retryAt), now + 47999); assert.equal(body.requestId, outgoing.headers.get('X-Request-ID'));
  assert.equal(suggest.mock.callCount(), 4);
  for (let i = 0; i < 6; i++) assert.equal((await hotspots(request('hotspots', { action: 'update' }, p.id))).status, 200);
  const updateLimit = await (await hotspots(request('hotspots', { action: 'update' }, p.id))).json();
  assert.equal(updateLimit.error.scope, 'hotspots_update'); assert.equal(update.mock.callCount(), 6);
  now += 48000;
  assert.equal((await hotspots(request('hotspots', { action: 'analyze', noteId: item.id, force: true }, p.id))).status, 200); assert.equal(suggest.mock.callCount(), 5);
});

test('全局 AI 调用限流说明属于工作台，未知用户键不会进入响应', () => {
  for (let i = 0; i < 6; i++) checkRateLimit('live', 6, now);
  assert.throws(() => checkRateLimit('live', 6, now + 5000), error => {
    assert(error instanceof RateLimitError); assert.equal(error.scope, 'live'); assert.equal(error.retryAfterSeconds, 55); assert.match(error.message, /工作台AI 生成/); return true;
  });
  const privateScope = 'private-user-sentinel'; checkRateLimit(privateScope, 1, now);
  assert.throws(() => checkRateLimit(privateScope, 1, now), error => { assert(error instanceof RateLimitError); assert.equal(error.scope, 'workbench'); assert(!JSON.stringify(error).includes(privateScope)); return true; });
});

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST } from '../app/api/ai/profiles/route';
import { AppError } from '../lib/errors';
import { aiTransport, createProvider } from '../lib/server/ai/provider';
import { assertApiKeyFormat } from '../lib/server/ai/credentials';
import { migrateLegacy, readStateFor, saveProfile } from '../lib/server/ai/store';

const env = { ...process.env };
let directory: string;
const valid = 'synthetic-safe-key_123+/=';
const profile = { name: 'existing', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: valid, model: 'manual-model', jsonMode: 'schema' };
const invalidKeys = ['synthetic-密钥', 'synthetic-\u200bkey', 'synthetic-\u00a0key', 'synthetic key', 'synthetic-\nkey', 'synthetic-\u0000key', 'synthetic-\u007fkey', 'Bearer synthetic-key', '••••••••abcd'];
const request = (body: unknown) => new Request('http://localhost/api/ai/profiles', { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-key-format-'));
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_CONFIG_DIR: directory, AI_CONFIG_SECRET: '', OPENAI_API_KEY: '', OPENAI_MODEL: '' };
});
afterEach(async () => { mock.restoreAll(); process.env = env; await rm(directory, { recursive: true, force: true }); });

test('查询前拦截 Unicode、隐藏字符、空白和控制字符，不发请求、不写配置、不泄露密钥', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => { assert.fail('invalid credentials must not reach transport'); });
  const logs: unknown[] = [];
  mock.method(console, 'error', (...values: unknown[]) => logs.push(values));
  mock.method(console, 'warn', (...values: unknown[]) => logs.push(values));
  mock.method(console, 'log', (...values: unknown[]) => logs.push(values));
  for (const apiKey of invalidKeys) {
    const response = await POST(request({ action: 'models', profile: { provider: profile.provider, baseUrl: profile.baseUrl, apiKey } }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_KEY_FORMAT');
    assert.match(body.error.message, /API Key 格式/);
    assert.match(body.error.message, /未向 AI 服务发送请求/);
    assert.doesNotMatch(body.error.message, /手动填写模型|模型列表格式|synthetic-/);
    assert(!JSON.stringify(body).includes(apiKey));
  }
  assert.equal(transport.mock.callCount(), 0);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(logs, []);
});

test('无效新密钥无法保存或覆盖旧配置；留空与首尾空白仍兼容', async () => {
  const saved = await saveProfile('local-owner', profile);
  const before = await readStateFor('local-owner'), files = await readdir(directory);
  const bytes = await Promise.all(files.map(file => readFile(join(directory, file))));
  for (const apiKey of invalidKeys) {
    const response = await POST(request({ action: 'save', id: saved.id, revision: saved.revision, profile: { ...profile, name: 'must-not-save', apiKey } }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_KEY_FORMAT');
  }
  assert.deepEqual(await readStateFor('local-owner'), before);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(directory, file)))), bytes);
  const kept = await saveProfile('local-owner', { ...profile, apiKey: '' }, saved.id, saved.revision);
  assert.equal((await readStateFor('local-owner')).profiles[0].apiKey, valid);
  const trimmed = await saveProfile('local-owner', { ...profile, apiKey: ' \n' + valid + '\t ' }, kept.id, kept.revision);
  assert.equal((await readStateFor('local-owner')).profiles[0].apiKey, valid);
  assert(!JSON.stringify(trimmed).includes(valid));
});

test('历史配置、两种协议和旧环境变量同样在构造 SDK 前校验，失败不会发送图片或文字', async () => {
  await saveProfile('local-owner', profile);
  const stored = (await readStateFor('local-owner')).profiles[0];
  const transport = mock.method(aiTransport, 'fetch', async () => { assert.fail('must reject before any model request'); });
  for (const protocol of ['responses', 'chat-completions'] as const) {
    for (const testImage of [false, true]) await assert.rejects(createProvider({ owner: 'local-owner', profile: { ...stored, protocol, apiKey: invalidKeys[0] } }, { testImage }), error => error instanceof AppError && error.code === 'INVALID_KEY_FORMAT');
  }
  process.env.OPENAI_API_KEY = invalidKeys[1]; process.env.OPENAI_MODEL = 'legacy-model'; process.env.OPENAI_BASE_URL = profile.baseUrl;
  await assert.rejects(createProvider('relay'), error => error instanceof AppError && error.code === 'INVALID_KEY_FORMAT');
  assert.equal(transport.mock.callCount(), 0);
  assert.equal((await readStateFor('local-owner')).profiles[0].apiKey, valid);
});

test('不假设服务商密钥前缀；格式检查通过不代表认证或生成成功', async () => {
  for (const apiKey of ['', 'a-non-sk-provider-token', valid]) assert.doesNotThrow(() => assertApiKeyFormat(apiKey));
  const transport = mock.method(aiTransport, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + valid);
    return Response.json({ data: [{ id: 'manual-model' }] });
  });
  const response = await POST(request({ action: 'models', profile: { provider: profile.provider, baseUrl: profile.baseUrl, apiKey: valid } }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { models: ['manual-model'] });
  assert.equal(transport.mock.callCount(), 1); assert.deepEqual(await readdir(directory), []);
  transport.mock.mockImplementation(async () => Response.json({ error: { message: valid } }, { status: 401 }));
  const rejected = await POST(request({ action: 'models', profile: { provider: profile.provider, baseUrl: profile.baseUrl, apiKey: valid } }));
  const body = await rejected.json(); assert.equal(body.error.code, 'INVALID_KEY'); assert(!JSON.stringify(body).includes(valid));
});

test('无效旧环境密钥不会迁移成新的可用配置，环境原值保留', async () => {
  process.env.OPENAI_API_KEY = invalidKeys[0]; process.env.OPENAI_MODEL = profile.model; process.env.OPENAI_BASE_URL = profile.baseUrl;
  await migrateLegacy('local-owner');
  assert.equal((await readStateFor('local-owner')).profiles.length, 0);
  assert.equal(process.env.OPENAI_API_KEY, invalidKeys[0]);
});

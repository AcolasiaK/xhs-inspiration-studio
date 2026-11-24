import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelListQuery, canQueryModels, modelListHelp, type ModelListQueryInput } from '../lib/ai-model-list-client';
import type { ProfileInput, PublicProfile } from '../lib/ai-config';
import type { cloudFetch } from '../lib/cloud/client';

const secret = 'synthetic-model-list-key';
const form = (): ProfileInput => ({
  name: '', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1',
  apiKey: secret, model: '', timeoutSeconds: 60, maxOutputTokens: 8000, jsonMode: 'schema',
});
const saved = (): PublicProfile => ({
  name: '已有配置', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1',
  model: 'saved-model', timeoutSeconds: 60, maxOutputTokens: 8000, jsonMode: 'schema',
  id: 'saved-profile', revision: 'saved-revision', hasApiKey: true, maskedApiKey: '••••••••-key',
  textTest: { status: 'passed', at: '2026-01-01T00:00:00Z', message: '原有文字测试' },
  imageTest: { status: 'unverified', at: null, message: '尚未验证' },
});
function input(value = form()): ModelListQueryInput {
  const { provider, baseUrl, apiKey, clearApiKey, protocol, timeoutSeconds } = value;
  return { profile: { provider, baseUrl, apiKey, clearApiKey, protocol, timeoutSeconds } };
}
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('新增未保存、名称和模型为空时可查询；地址或密钥缺失时不启用查询', () => {
  assert.equal(canQueryModels(form(), null), true);
  assert.equal(canQueryModels({ ...form(), baseUrl: ' ' }, null), false);
  assert.equal(canQueryModels({ ...form(), apiKey: ' ' }, null), false);
  assert.equal(canQueryModels({ ...form(), clearApiKey: true }, null), false);
});

test('编辑仅在同服务同地址下复用已有密钥，更换服务或地址后需要新密钥', () => {
  const current = saved();
  const emptyKey = { ...form(), apiKey: '' };
  assert.equal(canQueryModels(emptyKey, current), true);
  assert.equal(canQueryModels({ ...emptyKey, baseUrl: ' https://api.openai.com/v1/// ' }, current), true);
  assert.equal(canQueryModels({ ...emptyKey, baseUrl: 'https://another.example/v1' }, current), false);
  assert.equal(canQueryModels({ ...emptyKey, provider: 'custom' }, current), false);
  assert.equal(canQueryModels({ ...emptyKey, clearApiKey: true }, current), false);
  assert.equal(canQueryModels({ ...emptyKey, baseUrl: 'https://another.example/v1', apiKey: 'replacement-key' }, current), true);
  assert.equal(canQueryModels(emptyKey, { ...current, hasApiKey: false }), false);
});

test('仅主动调用发送当前连接字段；密钥放 POST 请求体，无保存、默认配置或模型依赖', async () => {
  const query = new ModelListQuery(), pending = deferred();
  const manual = { ...form(), model: 'user-manual-model' }, before = structuredClone(manual);
  const body = input(manual), originalBody = structuredClone(body);
  let calls = 0;
  const statuses: string[] = [];
  const off = query.subscribe(() => statuses.push(query.getSnapshot().status));
  const transport: typeof cloudFetch = async (url, init) => {
    calls++;
    assert.equal(url, '/api/ai/profiles');
    assert(!String(url).includes(secret));
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), { action: 'models', profile: {
      provider: manual.provider, baseUrl: manual.baseUrl, apiKey: secret,
      protocol: manual.protocol, timeoutSeconds: manual.timeoutSeconds,
    } });
    return pending.promise;
  };
  query.invalidate();
  assert.equal(calls, 0, '改变输入只使列表失效，不触发请求');
  const work = query.load(body, transport);
  assert.equal(query.getSnapshot().status, 'loading');
  pending.resolve(Response.json({ models: ['model-b', 'model-a', 'model-b'] }));
  await work;
  assert.deepEqual(query.getSnapshot().models, ['model-b', 'model-a']);
  assert.equal(query.getSnapshot().status, 'success');
  assert.deepEqual(manual, before, '获取列表不能选择首个模型或覆盖手动模型');
  assert.deepEqual(body, originalBody);
  assert(!JSON.stringify(query.getSnapshot()).includes(secret));
  assert.deepEqual(statuses, ['idle', 'loading', 'success']);
  off();
  query.invalidate();
  assert.deepEqual(statuses, ['idle', 'loading', 'success']);
  assert.equal(query.getSnapshot().status, 'idle');
  assert.deepEqual(query.getSnapshot().models, []);
});

for (const lateOutcome of ['success', 'failure'] as const) {
  test(`旧请求晚到的${lateOutcome === 'success' ? '成功' : '失败'}不能覆盖新服务的列表`, async () => {
    const query = new ModelListQuery(), old = deferred(), newer = deferred();
    const oldInput = input(), newInput = input({ ...form(), provider: 'custom', baseUrl: 'https://new.example/v1', apiKey: 'new-key' });
    let firstSignal: AbortSignal | null | undefined;
    const first = query.load(oldInput, async (_url, init) => { firstSignal = init?.signal; return old.promise; });
    assert.equal(query.getSnapshot().status, 'loading');
    query.invalidate();
    assert.equal(firstSignal?.aborted, true);
    assert.equal(query.getSnapshot().status, 'idle');
    const second = query.load(newInput, async () => newer.promise);
    newer.resolve(Response.json({ models: ['new-service-model'] }));
    await second;
    const latest = query.getSnapshot();
    if (lateOutcome === 'success') old.resolve(Response.json({ models: ['old-service-model'] }));
    else old.reject(new Error('outdated request failed'));
    await first;
    assert.equal(query.getSnapshot(), latest);
    assert.deepEqual(query.getSnapshot().models, ['new-service-model']);
  });
}

test('同一表单再次主动查询时也取消之前请求；失效后晚到结果不会重新出现', async () => {
  const query = new ModelListQuery(), firstResponse = deferred(), secondResponse = deferred();
  let signal: AbortSignal | null | undefined;
  const first = query.load(input(), async (_url, init) => { signal = init?.signal; return firstResponse.promise; });
  const second = query.load(input(), async () => secondResponse.promise);
  assert.equal(signal?.aborted, true);
  query.invalidate();
  secondResponse.resolve(Response.json({ models: ['newer-but-invalidated'] }));
  firstResponse.resolve(Response.json({ models: ['old'] }));
  await Promise.all([first, second]);
  assert.equal(query.getSnapshot().status, 'idle');
  assert.deepEqual(query.getSnapshot().models, []);
});

test('空列表、列表权限或接口格式问题允许手动填写，不代表生成能力通过', async () => {
  const query = new ModelListQuery();
  await query.load(input(), async () => Response.json({ models: [] }));
  assert.equal(query.getSnapshot().status, 'empty');
  assert.match(query.getSnapshot().message, /空模型列表.*手动/);
  for (const [status, code, message] of [[403, 'MODELS_FORBIDDEN', '当前密钥没有读取模型列表的权限。'], [404, 'MODELS_UNSUPPORTED', '该服务未提供模型列表接口。']] as const) {
    await query.load(input(), async () => Response.json({ error: { code, message } }, { status }));
    assert.equal(query.getSnapshot().status, 'error');
    assert(query.getSnapshot().message.includes(message));
    assert.match(query.getSnapshot().message, /手动填写/);
    assert.match(modelListHelp(query.getSnapshot()), /生成能力需另行测试/);
    assert.deepEqual(query.getSnapshot().models, []);
  }
  for (const response of [Response.json({ models: [null] }), Response.json({ wrong: [] }), new Response('<html>upstream detail</html>')]) {
    await query.load(input(), async () => response);
    assert.equal(query.getSnapshot().status, 'error');
    assert.match(query.getSnapshot().message, /格式不正确/);
  }
});

test('地址、解析、网络、认证和服务故障不追加手填绕过提示，页面帮助保持一致', async () => {
  const query = new ModelListQuery();
  for (const code of ['UNSAFE_ADDRESS', 'NETWORK_CONFIG', 'DNS_RESOLUTION_FAILED', 'DNS_LOOKUP_FAILED', 'INVALID_BASE_URL', 'MODELS_NETWORK', 'MODELS_TIMEOUT', 'INVALID_KEY', 'INVALID_KEY_FORMAT', 'MODELS_QUERY_FAILED', 'ENDPOINT_REDIRECT', 'PROVIDER_QUOTA', 'PROVIDER_LIMIT', 'PROVIDER_UNAVAILABLE']) {
    const message = code.includes('DNS') ? '服务域名解析失败，请检查后端网络。' : '请先处理连接或配置错误。';
    await query.load(input(), async () => Response.json({ error: { code, message } }, { status: 502 }));
    assert.equal(query.getSnapshot().errorCode, code);
    assert.equal(query.getSnapshot().message, message);
    assert.doesNotMatch(modelListHelp(query.getSnapshot()), /手动填写/);
  }
  await query.load(input(), async () => Response.json({ error: { message: '未知请求失败。' } }, { status: 502 }));
  assert.doesNotMatch(query.getSnapshot().message, /手动填写/);
  await query.load(input(), async () => { throw new TypeError('internal transport detail ' + secret); });
  assert.equal(query.getSnapshot().errorCode, 'MODELS_NETWORK');
  assert.match(query.getSnapshot().message, /网络/);
  assert.doesNotMatch(query.getSnapshot().message, /手动填写|internal transport detail/);
  assert(!JSON.stringify(query.getSnapshot()).includes(secret));
  assert.doesNotMatch(modelListHelp(query.getSnapshot()), /手动填写/);
  query.invalidate();
  assert.equal(query.getSnapshot().errorCode, undefined);
});

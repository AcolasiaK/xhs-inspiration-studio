import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { unverified, type Profile } from '../lib/ai-config';
import { AppError } from '../lib/errors';
import { aiTransport } from '../lib/server/ai/provider';
import { generateVideo } from '../lib/server/video';
import type { VideoRequest } from '../lib/video/schema';
import { videoInput, videoPlan } from './video-fixture';

const profile: Profile = {
  id: 'synthetic-video-profile', revision: 'synthetic-revision', name: '视频离线测试',
  provider: 'custom', protocol: 'responses', baseUrl: 'https://api.example.com/v1',
  apiKey: 'synthetic-video-test-key', model: 'synthetic-video-model',
  timeoutSeconds: 60, maxOutputTokens: 8000, jsonMode: 'schema',
  textTest: unverified(), imageTest: unverified(),
};
afterEach(() => mock.restoreAll());
const response = (value: unknown) => Response.json({
  id: 'synthetic-response', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const request = (phase: 'before' | 'after'): VideoRequest => ({
  action: 'generate', input: videoInput(phase), current: null, targetId: '', instruction: '测试要求',
});

for (const protocol of ['responses', 'chat-completions'] as const) {
  for (const jsonMode of ['schema', 'object'] as const) {
    for (const phase of ['before', 'after'] as const) {
      test(`视频 ${protocol}/${jsonMode}/${phase} 使用选定配置并传入正确阶段、素材与完整输出结构`, async () => {
        const source = { owner: 'synthetic-owner', profile: { ...profile, protocol, jsonMode } };
        const transport = mock.method(aiTransport, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
          assert.equal(String(url), `${profile.baseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
          const sent = JSON.parse(String(init?.body));
          assert.equal(sent.model, profile.model);
          assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${profile.apiKey}`);
          const messages = protocol === 'responses' ? sent.input : sent.messages;
          const user = JSON.parse(messages.find((entry: { role: string }) => entry.role === 'user').content);
          assert.equal(user.phase, phase);
          assert.equal(user.brief.duration, 30);
          assert.equal(user.brief.customStyle, '短句、安静留白');
          assert.equal(user.actualMaterials.length, phase === 'after' ? 3 : 0);
          assert.equal(user.shootingReference, null);
          const format = protocol === 'responses' ? sent.text.format : sent.response_format;
          assert.equal(format.type, jsonMode === 'schema' ? 'json_schema' : 'json_object');
          if (jsonMode === 'object') assert.match(messages[0].content, /"plan"/);
          else {
            const schema = protocol === 'responses' ? format.schema : format.json_schema.schema;
            assert.deepEqual(schema.required, ['plan']);
            assert.equal(schema.additionalProperties, false);
          }
          return protocol === 'responses'
            ? response({ plan: videoPlan() })
            : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ plan: videoPlan() }) } }] });
        });
        const result = await generateVideo(request(phase), new AbortController().signal, source);
        assert.deepEqual(result.plan, videoPlan());
        assert.equal(transport.mock.callCount(), 1);
      });
    }
    test(`视频单镜头重写 ${protocol}/${jsonMode} 保持目标与时间且只返回一个镜头`, async () => {
      const current = videoPlan(), shot = { ...current.shots[0], visual: '测试的新湖面画面' };
      const transport = mock.method(aiTransport, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const sent = JSON.parse(String(init?.body));
        const messages = protocol === 'responses' ? sent.input : sent.messages;
        const user = JSON.parse(messages.find((entry: { role: string }) => entry.role === 'user').content);
        assert.equal(user.action, 'rewrite');
        assert.deepEqual(user.targetShot, current.shots[0]);
        assert.equal(user.adjacentShots.length, current.shots.length);
        return protocol === 'responses' ? response({ shot })
          : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ shot }) } }] });
      });
      const result = await generateVideo({ ...request('after'), action: 'rewrite', current, targetId: shot.shotId }, new AbortController().signal,
        { owner: 'synthetic-owner', profile: { ...profile, protocol, jsonMode } });
      assert.deepEqual(result, { shot });
      assert.equal(transport.mock.callCount(), 1);
    });
  }
}

for (const protocol of ['responses', 'chat-completions'] as const) {
  test(`视频 ${protocol} 截断结果不进入业务结果、不自动重试`, async () => {
    const transport = mock.method(aiTransport, 'fetch', async () => protocol === 'responses'
      ? Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"plan":' }] }] })
      : Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"plan":' } }] }));
    await assert.rejects(generateVideo(request('before'), new AbortController().signal, { owner: 'synthetic-owner', profile: { ...profile, protocol } }), error => {
      assert(error instanceof AppError);
      assert.match(error.code, /INCOMPLETE|OUTPUT_LIMIT/);
      return true;
    });
    assert.equal(transport.mock.callCount(), 1);
  });
}

test('视频的已取消请求不发送任何模型请求', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => { throw new Error('Must not call model'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateVideo(request('before'), controller.signal, { owner: 'synthetic-owner', profile }), error => {
    assert(error instanceof AppError); assert.equal(error.code, 'CANCELLED'); return true;
  });
  assert.equal(transport.mock.callCount(), 0);
});

test('视频 legacy 使用统一模型预算，保存配置仍使用用户自定义 60 秒且 token 不变', async () => {
  const saved = { ...process.env };
  process.env = { ...saved, APP_MODE: 'local', GENERATION_TIMEOUT_PROFILE: 'local', OPENAI_API_KEY: profile.apiKey,
    OPENAI_MODEL: profile.model, OPENAI_BASE_URL: 'https://api.openai.com/v1' };
  delete process.env.VERCEL;
  const timeouts: number[] = [];
  const originalTimeout = globalThis.setTimeout;
  mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof globalThis.setTimeout>) => {
    const milliseconds = args[1];
    if (milliseconds === 90_000 || milliseconds === 60_000) timeouts.push(milliseconds);
    return originalTimeout(...args);
  });
  const transport = mock.method(aiTransport, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 8000);
    return response({ plan: videoPlan() });
  });
  try {
    await generateVideo(request('before'), new AbortController().signal, 'relay');
    assert(timeouts.length > 0);
    assert.deepEqual([...new Set(timeouts)], [90_000]);
    timeouts.length = 0;
    await generateVideo(request('before'), new AbortController().signal, { owner: 'synthetic-owner', profile });
    assert(timeouts.length > 0);
    assert.deepEqual([...new Set(timeouts)], [60_000]);
    assert.equal(transport.mock.callCount(), 2);
  } finally { process.env = saved; }
});

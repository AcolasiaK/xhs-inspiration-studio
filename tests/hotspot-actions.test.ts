import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HotspotActionGate, hotspotFailure } from '../lib/hotspot-actions';

test('前端同步阻止重复提交；刷新与生成共用进行中锁但限流时间分别计算', () => {
  const actions = new HotspotActionGate();
  assert.equal(actions.start('suggest', 1000), true);
  assert.equal(actions.start('suggest', 1000), false);
  assert.equal(actions.start('update', 1000), false);
  actions.defer('suggest', 5000); actions.finish();
  assert.equal(actions.start('suggest', 4999), false);
  assert.equal(actions.start('update', 1001), true); actions.finish();
  // The gate never sends network requests: expiry only permits a later user action.
  assert.equal(actions.start('suggest', 5000), true); actions.finish();
  assert.equal(actions.start('suggest', 5000), true);
});

test('工作台限流读取准确重试时间；模型限流和热点来源失败保留各自提示', () => {
  const response = new Response(null, { status: 429, headers: { 'Retry-After': '17' } });
  const now = Date.parse('2026-11-04T08:00:00Z'), until = now + 17000;
  const limit = hotspotFailure(response, { error: { code: 'RATE_LIMIT', message: '工作台选题建议请求过于频繁。', retryAt: new Date(until).toISOString() } }, 'suggest', now);
  assert.equal(limit.retryAt, until); assert.match(limit.message, /工作台选题建议/);
  assert.equal(hotspotFailure(response, { error: { code: 'RATE_LIMIT' } }, 'suggest', now).retryAt, until);
  const provider = hotspotFailure(response, { error: { code: 'PROVIDER_LIMIT', message: '模型服务限流，请稍后重试。' } }, 'suggest', now);
  assert.equal(provider.retryAt, 0); assert.equal(provider.message, '模型服务限流，请稍后重试。');
  const source = hotspotFailure(response, { error: '热点来源暂时限制访问。' }, 'update', now);
  assert.equal(source.message, '热点来源暂时限制访问。'); assert.equal(source.retryAt, 0);
  assert.match(hotspotFailure(response, null, 'suggest', now).message, /AI 选题/);
  assert.match(hotspotFailure(response, null, 'update', now).message, /热点刷新/);
});

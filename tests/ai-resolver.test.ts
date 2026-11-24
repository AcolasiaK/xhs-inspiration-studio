import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https, { type RequestOptions } from 'node:https';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AppError } from '../lib/errors';
import { resolvePublicAddresses } from '../lib/server/ai/resolver';

const originalEnv = { ...process.env };
const secret = 'synthetic-dns-must-not-leak';
const host = 'api.example.com';
let systemLookups: number;
beforeEach(() => {
  process.env = { ...originalEnv, AI_DNS_MODE: 'cloudflare-doh', OPENAI_API_KEY: secret };
  systemLookups = 0;
  mock.method(dns, 'lookup', (async () => { systemLookups++; throw new Error('OS_DNS_MUST_NOT_BE_USED'); }) as unknown as typeof dns.lookup);
});
afterEach(() => { mock.restoreAll(); process.env = originalEnv; });

type DnsReply = { status?: number; body?: unknown; raw?: string; error?: Error; pending?: boolean; onAbort?: () => void };
function mockDoh(reply: (url: URL, options: RequestOptions) => DnsReply) {
  return mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const value = reply(url, options);
    const outgoing = new EventEmitter() as ClientRequest;
    const onAbort = () => { value.onAbort?.(); outgoing.destroy(options.signal?.reason); };
    outgoing.destroy = ((error?: Error) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (error) queueMicrotask(() => outgoing.emit('error', error));
      return outgoing;
    }) as ClientRequest['destroy'];
    outgoing.end = (() => {
      options.signal?.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        if (value.pending) return;
        options.signal?.removeEventListener('abort', onAbort);
        if (value.error) { outgoing.emit('error', value.error); return; }
        const incoming = new EventEmitter() as IncomingMessage;
        incoming.statusCode = value.status ?? 200;
        incoming.headers = { location: 'https://internal.example/redirect' };
        incoming.resume = (() => incoming) as IncomingMessage['resume'];
        callback(incoming);
        incoming.emit('data', Buffer.from(value.raw ?? JSON.stringify(value.body)));
        incoming.emit('end');
      });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as typeof https.request);
}
function answer(url: URL) {
  const type = Number(url.searchParams.get('type'));
  return { Status: 0, Question: [{ name: host + '.', type }], Answer: [{ name: host, type, data: type === 1 ? '8.8.8.8' : '2606:4700:4700::1111' }] };
}
const signal = () => new AbortController().signal;
function safeFailure(error: unknown, code = 'DNS_RESOLUTION_FAILED') {
  assert(error instanceof AppError);
  assert.equal(error.code, code);
  assert(!error.message.includes(secret));
  assert.doesNotMatch(error.message, /PRIVATE_DETAIL|OS_DNS_MUST_NOT_BE_USED/);
  return true;
}

test('DoH 只发送域名和记录类型，TLS 验证开启，无 API 认证与系统 DNS 查询', async () => {
  const agents = new Set<https.Agent>();
  const socket = mockDoh((url, options) => {
    assert.equal(url.origin, 'https://1.1.1.1');
    assert.equal(url.pathname, '/dns-query');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['name', 'type']);
    assert.equal(url.searchParams.get('name'), host);
    assert(['1', '28'].includes(url.searchParams.get('type') || ''));
    assert.equal(url.username, ''); assert.equal(url.password, '');
    assert(!url.href.includes(secret));
    assert.equal(options.rejectUnauthorized, true);
    assert(options.agent instanceof https.Agent);
    assert.notEqual(options.agent, https.globalAgent);
    assert.equal(options.agent.options.proxyEnv, undefined);
    agents.add(options.agent);
    assert.deepEqual(options.headers, { accept: 'application/dns-json' });
    assert(!JSON.stringify(options.headers).includes(secret));
    return { body: answer(url) };
  });
  assert.deepEqual(await resolvePublicAddresses(host, signal()), [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  assert.equal(socket.mock.callCount(), 2);
  assert.equal(agents.size, 2, '每次 DoH 查询使用独立 Agent，不继承全局代理 Agent');
  assert.equal(systemLookups, 0);
});

test('接受 A、AAAA 与关联 CNAME 链；没有 AAAA 时保留有效 A 结果', async () => {
  let ipv6 = true;
  mockDoh(url => {
    const base = answer(url), type = Number(url.searchParams.get('type'));
    if (type === 28 && !ipv6) return { body: { ...base, Answer: [] } };
    return { body: { ...base, Question: [{ name: 'API.EXAMPLE.COM.', type }], Answer: [
      { name: 'edge.example.net.', type, data: type === 1 ? '8.8.4.4' : '2001:4860:4860::8844' },
      { name: 'alias.example.net.', type: 5, data: 'edge.example.net.' },
      { name: host, type: 5, data: 'alias.example.net.' },
    ] } };
  });
  assert.deepEqual(await resolvePublicAddresses(host, signal()), [{ address: '8.8.4.4', family: 4 }, { address: '2001:4860:4860::8844', family: 6 }]);
  ipv6 = false;
  assert.deepEqual(await resolvePublicAddresses(host, signal()), [{ address: '8.8.4.4', family: 4 }]);
  assert.equal(systemLookups, 0);
});

test('任意非公网记录使整个结果拒绝，包括公网混合和 Fake-IP', async () => {
  let rejected = '198.18.0.44';
  mockDoh(url => {
    const base = answer(url);
    return { body: url.searchParams.get('type') === '1' ? { ...base, Answer: [...base.Answer, { name: host, type: 1, data: rejected }] } : base };
  });
  for (rejected of ['198.18.0.44', '127.0.0.1', '10.0.0.1', '169.254.169.254']) {
    await assert.rejects(resolvePublicAddresses(host, signal()), error => safeFailure(error, 'UNSAFE_ADDRESS'));
  }
  assert.equal(systemLookups, 0);
});

test('拒绝畸形、截断、问题不匹配、无关答案、NXDOMAIN 与空结果，不降级到系统 DNS', async () => {
  let malformed: (url: URL) => DnsReply = url => ({ body: answer(url) });
  mockDoh(url => malformed(url));
  const variants: Array<(url: URL) => DnsReply> = [
    () => ({ raw: '<html>PRIVATE_DETAIL ' + secret + '</html>' }),
    () => ({ body: null }),
    url => ({ body: { ...answer(url), TC: true } }),
    url => ({ body: { ...answer(url), Question: [{ name: 'different.example.com', type: Number(url.searchParams.get('type')) }] } }),
    url => ({ body: { ...answer(url), Question: [{ name: host, type: 5 }] } }),
    url => ({ body: { ...answer(url), Question: [] } }),
    url => ({ body: { ...answer(url), Answer: [{ name: 'unrelated.example.com', type: 1, data: '8.8.8.8' }] } }),
    url => ({ body: { ...answer(url), Answer: [{ name: host, type: Number(url.searchParams.get('type')), data: 'not-an-ip' }] } }),
    url => ({ body: { ...answer(url), Status: 3 } }),
    url => ({ body: { ...answer(url), Answer: [] } }),
    url => ({ body: { ...answer(url), Answer: 'not-an-array' } }),
    () => ({ raw: ' '.repeat(32 * 1024 + 1) }),
  ];
  for (malformed of variants) await assert.rejects(resolvePublicAddresses(host, signal()), error => safeFailure(error));
  assert.equal(systemLookups, 0);
});

test('DoH 重定向、服务异常和 TLS 失败均终止，不跟随新地址或调用系统 DNS', async () => {
  let response: DnsReply = { status: 302, body: {} };
  const socket = mockDoh(url => { assert.equal(url.origin, 'https://1.1.1.1'); return response; });
  for (response of [{ status: 302, body: {} }, { status: 500, body: {} }, { error: Object.assign(new Error('PRIVATE_DETAIL ' + secret), { code: 'CERT_HAS_EXPIRED' }) }]) {
    const before = socket.mock.callCount();
    await assert.rejects(resolvePublicAddresses(host, signal()), error => safeFailure(error));
    assert.equal(socket.mock.callCount() - before, 2, '仅发出原目标 A/AAAA 查询，不重试或跟随重定向');
  }
  assert.equal(systemLookups, 0);
});

test('取消中的 DoH 查询立即拒绝；已取消请求不创建任何网络查询', async () => {
  const socket = mockDoh(() => ({ pending: true }));
  const controller = new AbortController();
  const resolving = resolvePublicAddresses(host, controller.signal);
  await Promise.resolve();
  assert.equal(socket.mock.callCount(), 2);
  controller.abort();
  await assert.rejects(resolving, { name: 'AbortError' });
  await assert.rejects(resolvePublicAddresses(host, controller.signal), { name: 'AbortError' });
  assert.equal(socket.mock.callCount(), 2);
  assert.equal(systemLookups, 0);
});

test('内部 DNS 超时映射为解析失败，并取消 pending A/AAAA 查询', async () => {
  const timeout = new AbortController();
  const timer = mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 8000); return timeout.signal; });
  const aborted: string[] = [];
  const socket = mockDoh(url => ({ pending: true, onAbort: () => { aborted.push(url.searchParams.get('type') || ''); } }));
  const external = new AbortController();
  const resolving = resolvePublicAddresses(host, external.signal);
  await Promise.resolve();
  assert.equal(socket.mock.callCount(), 2);
  timeout.abort(new DOMException('PRIVATE_DETAIL ' + secret, 'TimeoutError'));
  await assert.rejects(resolving, error => safeFailure(error));
  assert.deepEqual(aborted.sort(), ['1', '28']);
  assert.equal(external.signal.aborted, false, '内部超时不修改调用方取消状态');
  assert.equal(timer.mock.callCount(), 1);
  assert.equal(systemLookups, 0);
});

test('一个 DoH 分支失败时取消仍在等待的另一分支，不降级或重试', async () => {
  const aborted: string[] = [];
  const socket = mockDoh(url => url.searchParams.get('type') === '1'
    ? { error: new Error('PRIVATE_DETAIL ' + secret) }
    : { pending: true, onAbort: () => { aborted.push('28'); } });
  await assert.rejects(resolvePublicAddresses(host, signal()), error => safeFailure(error));
  assert.deepEqual(aborted, ['28']);
  assert.equal(socket.mock.callCount(), 2);
  assert.equal(systemLookups, 0);
});

test('错误解析模式明确拒绝；公开 IP 字面量不查 DNS，非公网字面量仍被阻止', async () => {
  const socket = mockDoh(() => { assert.fail('IP 字面量或无效配置不得查询 DNS'); });
  process.env.AI_DNS_MODE = 'unsupported-mode';
  await assert.rejects(resolvePublicAddresses(host, signal()), error => safeFailure(error, 'NETWORK_CONFIG'));
  for (const mode of ['system', 'cloudflare-doh']) {
    process.env.AI_DNS_MODE = mode;
    assert.deepEqual(await resolvePublicAddresses('8.8.8.8', signal()), [{ address: '8.8.8.8', family: 4 }]);
    assert.deepEqual(await resolvePublicAddresses('2606:4700:4700::1111', signal()), [{ address: '2606:4700:4700::1111', family: 6 }]);
    await assert.rejects(resolvePublicAddresses('127.0.0.1', signal()), error => safeFailure(error, 'UNSAFE_ADDRESS'));
  }
  assert.equal(socket.mock.callCount(), 0);
  assert.equal(systemLookups, 0);
});

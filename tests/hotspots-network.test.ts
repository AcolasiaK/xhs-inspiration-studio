import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import https, { type RequestOptions } from 'node:https';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { fetchHotspotSource, hotspotDnsAddresses, HotspotNetworkError } from '../lib/server/hotspots-network';
import { fetchBaiduHotspots, hotspotSourceErrorMessage, HotspotSourceError } from '../lib/server/hotspots-source';
import { HOTSPOT_BOARD } from '../lib/hotspot-metadata';

const original = { ...process.env };
const dnsAnswer = (ip = '8.8.8.8') => ({ Status: 0, Question: { name: 'top.baidu.com.', type: 1 }, Answer: [
  { name: 'top.baidu.com.', type: 5, data: 'board.example.net.' },
  { name: 'board.example.net.', type: 1, data: ip },
] });
const html = '<!--s-data:' + JSON.stringify({ tab: 'realtime', data: { cards: [{ component: 'hotList', content: [{ index: 0, word: '测试周末旅行', desc: '模拟数据', rawUrl: 'https://www.baidu.com/s?wd=test' }] }] } }) + '-->';
beforeEach(() => {
  process.env = { ...original, APP_MODE: 'local', APP_LOCAL_ONLY: '1', HOTSPOTS_NETWORK_MODE: 'direct-interface', HOTSPOTS_NETWORK_INTERFACE: 'en0', OPENAI_API_KEY: 'NEVER_SEND_THIS_SENTINEL', AI_DNS_MODE: 'cloudflare-doh' };
  delete process.env.VERCEL;
  mock.method(os, 'networkInterfaces', () => ({ en0: [{ address: '192.168.1.11', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.11/24' }] }));
});
afterEach(() => { mock.restoreAll(); process.env = original; });
type Reply = { status?: number; text?: string; error?: string; pending?: boolean; headers?: Record<string, string> };
function sockets(reply: (url: URL, options: RequestOptions) => Reply) {
  return mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const out = new EventEmitter() as ClientRequest;
    const chosen = reply(url, options);
    let aborted = false;
    const onAbort = () => { aborted = true; queueMicrotask(() => out.emit('error', options.signal?.reason)); };
    out.destroy = ((error?: Error) => { if (error) queueMicrotask(() => out.emit('error', error)); return out; }) as ClientRequest['destroy'];
    out.end = (() => {
      options.signal?.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        if (chosen.pending || aborted) return;
        options.signal?.removeEventListener('abort', onAbort);
        if (chosen.error) {
          const socket = new EventEmitter(); out.emit('socket', socket); socket.emit('connect');
          out.emit('error', Object.assign(new Error('NEVER_SEND_THIS_SENTINEL'), { code: chosen.error })); return;
        }
        const incoming = new EventEmitter() as IncomingMessage;
        incoming.statusCode = chosen.status ?? 200; incoming.headers = chosen.headers ?? {};
        callback(incoming);
        incoming.emit('data', Buffer.from(chosen.text ?? (url.hostname === '223.5.5.5' ? JSON.stringify(dnsAnswer()) : html)));
        incoming.emit('end');
      }); return out;
    }) as ClientRequest['end'];
    return out;
  }) as typeof https.request);
}

test('固定来源使用同一物理网卡、加密 DNS、动态固定公网 IP 和原始 TLS 域名，不发送 AI 密钥', async () => {
  const outbound = sockets((url, options) => {
    assert.equal(options.localAddress, '192.168.1.11');
    assert.equal(options.rejectUnauthorized, true);
    assert(options.agent instanceof https.Agent);
    assert.notEqual(options.agent, https.globalAgent);
    assert.equal(options.agent.options.proxyEnv, undefined);
    assert.doesNotMatch(JSON.stringify(options.headers), /authorization|cookie|NEVER_SEND/i);
    if (url.hostname === '223.5.5.5') {
      assert.equal(url.href, 'https://223.5.5.5/resolve?name=top.baidu.com&type=A');
    } else {
      assert.equal(url.href, HOTSPOT_BOARD);
      assert.equal(options.servername, 'top.baidu.com');
      const lookup = options.lookup as (h: string, o: object, cb: (e: Error | null, ip: string, family: number) => void) => void;
      lookup('top.baidu.com', {}, (e, ip, family) => { assert.equal(e, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4); });
    }
    return {};
  });
  const items = await fetchBaiduHotspots('2026-11-05T00:00:00Z');
  assert.equal(items.length, 1); assert.equal(outbound.mock.callCount(), 2);
  assert.equal(process.env.AI_DNS_MODE, 'cloudflare-doh');
});
test('公网解析拒绝 Fake-IP、内网、混合答案、错误问题和无关记录', () => {
  assert.deepEqual(hotspotDnsAddresses(dnsAnswer()), ['8.8.8.8']);
  for (const ip of ['198.18.0.243', '127.0.0.1', '10.0.0.1', '169.254.169.254']) assert.throws(() => hotspotDnsAddresses(dnsAnswer(ip)), { code: 'UNSAFE_ADDRESS' });
  const mixed = dnsAnswer(); mixed.Answer.push({ name: 'board.example.net.', type: 1, data: '192.168.1.1' });
  assert.throws(() => hotspotDnsAddresses(mixed), { code: 'UNSAFE_ADDRESS' });
  assert.throws(() => hotspotDnsAddresses({ ...dnsAnswer(), Question: { name: 'other.test', type: 1 } }), { code: 'DNS' });
  assert.throws(() => hotspotDnsAddresses({ ...dnsAnswer(), Answer: [{ name: 'unrelated.test', type: 1, data: '8.8.8.8' }] }), { code: 'DNS' });
});
test('地址和网卡配置失败时不打开连接，不静默改回代理或云端', async () => {
  const outbound = sockets(() => assert.fail('must not connect'));
  await assert.rejects(fetchHotspotSource('https://evil.test/'), { code: 'NETWORK_CONFIG' });
  for (const name of ['en99', 'utun1024', 'lo0', 'en0;cmd']) {
    process.env.HOTSPOTS_NETWORK_INTERFACE = name;
    await assert.rejects(fetchHotspotSource(HOTSPOT_BOARD), { code: 'NETWORK_CONFIG' });
  }
  process.env.HOTSPOTS_NETWORK_INTERFACE = 'en0'; process.env.APP_MODE = 'cloud';
  await assert.rejects(fetchHotspotSource(HOTSPOT_BOARD), { code: 'NETWORK_CONFIG' });
  assert.equal(outbound.mock.callCount(), 0);
});
test('非公网 DNS 与 DNS 重定向阻止来源连接；来源重定向不跟随', async () => {
  const blocked = sockets(() => ({ text: JSON.stringify(dnsAnswer('198.18.0.1')) }));
  await assert.rejects(fetchBaiduHotspots('2026-11-05T00:00:00Z'), { code: 'UNSAFE_ADDRESS' });
  assert.equal(blocked.mock.callCount(), 1); blocked.mock.restore();
  const redirectDns = sockets(() => ({ status: 302, headers: { location: 'https://other.test' } }));
  await assert.rejects(fetchHotspotSource(HOTSPOT_BOARD), { code: 'DNS' });
  assert.equal(redirectDns.mock.callCount(), 1); redirectDns.mock.restore();
  const redirectSource = sockets(url => url.hostname === 'top.baidu.com' ? { status: 302 } : {});
  await assert.rejects(fetchBaiduHotspots('2026-11-05T00:00:00Z'), { code: 'RESTRICTED' });
  assert.equal(redirectSource.mock.callCount(), 2);
});
test('响应限制、取消和 TLS 错误不会采用内容或暴露原始错误', async () => {
  const huge = sockets(url => url.hostname === 'top.baidu.com' ? { text: 'x'.repeat(1_000_001) } : {});
  await assert.rejects(fetchBaiduHotspots('2026-11-05T00:00:00Z'), { code: 'TOO_LARGE' }); huge.mock.restore();
  const tls = sockets(url => url.hostname === 'top.baidu.com' ? { error: 'ECONNRESET' } : {});
  await assert.rejects(fetchBaiduHotspots('2026-11-05T00:00:00Z'), { code: 'TLS' }); tls.mock.restore();
  const controller = new AbortController(); controller.abort();
  const none = sockets(() => assert.fail('must not connect'));
  await assert.rejects(fetchHotspotSource(HOTSPOT_BOARD, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(none.mock.callCount(), 0);
  for (const code of ['DNS', 'UNSAFE_ADDRESS', 'TLS', 'NETWORK_CONFIG'] as const) assert.doesNotMatch(hotspotSourceErrorMessage(new HotspotSourceError(code)), /NEVER_SEND|密钥错误/);
  assert.equal(new HotspotNetworkError('DNS').message, 'DNS');
});
test('未启用本机专用路径时保留原采集方式，连接超时能正确分类', async () => {
  process.env.HOTSPOTS_NETWORK_MODE = 'system';
  const originalFetch = mock.method(globalThis, 'fetch', async () => new Response(html));
  assert.equal((await fetchBaiduHotspots('2026-11-05T00:00:00Z')).length, 1);
  originalFetch.mock.mockImplementation(async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); });
  await assert.rejects(fetchBaiduHotspots('2026-11-05T00:00:00Z'), { code: 'TIMEOUT' });
});

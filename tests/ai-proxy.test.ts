import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type ClientRequest, type RequestOptions } from 'node:http';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { aiHttpsAgent, localAiProxy, resolveAiProxy } from '../lib/server/ai/proxy-agent';
import { safeFetch } from '../lib/server/ai/address';
import { providerError } from '../lib/server/provider-errors';
import OpenAI from 'openai';

const originalEnv = { ...process.env };
beforeEach(() => { process.env = { ...originalEnv, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_LOCAL_PROXY_URL: 'http://127.0.0.1:7897' }; delete process.env.VERCEL; });
afterEach(() => { mock.restoreAll(); process.env = originalEnv; });
function network() {
  const request = Object.assign(new EventEmitter(), { end: mock.fn(), destroy: mock.fn() });
  const tunnel = Object.assign(new EventEmitter(), { destroy: mock.fn() });
  const secure = Object.assign(new EventEmitter(), { destroy: mock.fn() });
  const connect = mock.method(http, 'request', (() => request as unknown as ClientRequest) as typeof http.request);
  const tlsConnect = mock.method(tls, 'connect', (() => secure as unknown as tls.TLSSocket) as typeof tls.connect);
  return { request, tunnel, secure, connect, tlsConnect };
}
function start(signal = new AbortController().signal, address = '8.8.8.8', hostname = 'api.example.com') {
  const agent = aiHttpsAgent(address, hostname, 443, signal);
  const result = new Promise<{ error: Error | null; socket: unknown }>(resolve => {
    agent.createConnection({}, (error, socket) => resolve({ error, socket }));
  });
  return { agent, result };
}
test('代理仅限本机显式配置；拒绝远程代理、认证信息和云端使用', () => {
  assert.equal(localAiProxy()?.port, '7897');
  for (const url of ['https://127.0.0.1:7897', 'http://localhost:7897', 'http://8.8.8.8:7897', 'http://user:secret@127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897?q=1', 'http://127.0.0.1:7897#x', 'http://127.0.0.1:0']) {
    process.env.AI_LOCAL_PROXY_URL = url;
    assert.throws(localAiProxy, { code: 'NETWORK_CONFIG' });
  }
  process.env.AI_LOCAL_PROXY_URL = 'http://127.0.0.1:7897';
  process.env.APP_MODE = 'cloud';
  assert.throws(localAiProxy, { code: 'NETWORK_CONFIG' });
  delete process.env.AI_LOCAL_PROXY_URL;
  process.env.HTTPS_PROXY = 'http://example.com:9999';
  assert.equal(localAiProxy(), null, '不会隐式继承全局代理');
});
test('CONNECT 仅发送已验证 IP；TLS 成功前不会交付 API socket，验证原域名', async () => {
  const n = network(), { agent, result } = start();
  const options = n.connect.mock.calls[0].arguments[0] as RequestOptions;
  assert.deepEqual(options, { hostname: '127.0.0.1', port: 7897, method: 'CONNECT', path: '8.8.8.8:443', agent: false, headers: { host: '8.8.8.8:443' } });
  let delivered = false; void result.then(() => { delivered = true; });
  n.request.emit('connect', { statusCode: 200 }, n.tunnel, Buffer.alloc(0));
  const tlsOptions = n.tlsConnect.mock.calls[0].arguments[0] as tls.ConnectionOptions;
  assert.equal(tlsOptions.servername, 'api.example.com');
  assert.equal(tlsOptions.rejectUnauthorized, true);
  const identity = mock.method(tls, 'checkServerIdentity', () => undefined);
  tlsOptions.checkServerIdentity?.('ignored-name', {} as tls.PeerCertificate);
  assert.equal(identity.mock.calls[0].arguments[0], 'api.example.com');
  await Promise.resolve(); assert.equal(delivered, false);
  n.secure.emit('secureConnect');
  assert.deepEqual(await result, { error: null, socket: n.secure });
  assert.equal(n.connect.mock.callCount(), 1); agent.destroy();
});
test('DNS IP 和 IPv6 连接仍校验证书；非公网目标在创建 CONNECT 前被阻止', async () => {
  const n = network(), { agent, result } = start(undefined, '2606:4700:4700::1111', '1.1.1.1');
  assert.equal((n.connect.mock.calls[0].arguments[0] as RequestOptions).path, '[2606:4700:4700::1111]:443');
  n.request.emit('connect', { statusCode: 200 }, n.tunnel, Buffer.alloc(0));
  assert.equal((n.tlsConnect.mock.calls[0].arguments[0] as tls.ConnectionOptions).servername, undefined);
  n.secure.emit('secureConnect'); await result; agent.destroy();
  for (const ip of ['127.0.0.1', '10.0.0.1', '198.18.0.1', '::1']) assert.throws(() => start(undefined, ip), { code: 'UNSAFE_ADDRESS' });
  assert.equal(n.connect.mock.callCount(), 1);
});
test('代理拒绝、重定向、隧道额外数据或证书错误都安全终止，不直连重试', async () => {
  for (const failure of ['407', '302', 'head', 'tls', 'network']) {
    const n = network(), { agent, result } = start();
    if (failure === 'network') n.request.emit('error', new Error('secret-private-detail'));
    else {
      n.request.emit('connect', { statusCode: ['407', '302'].includes(failure) ? Number(failure) : 200 }, n.tunnel, Buffer.from(failure === 'head' ? 'unexpected' : ''));
      if (failure === 'tls') n.secure.emit('error', new Error('secret-private-detail'));
    }
    const { error } = await result;
    assert.equal((error as Error & { code: string }).code, 'AI_PROXY_UNAVAILABLE');
    assert(!error?.message.includes('secret-private-detail'));
    assert.equal(providerError(new OpenAI.APIConnectionError({ cause: error! }), 'OpenAI').code, 'AI_PROXY_UNAVAILABLE');
    assert.equal(n.connect.mock.callCount(), 1); agent.destroy(); mock.restoreAll();
  }
});
test('取消关闭正在建立的隧道，不产生第二次连接', async () => {
  const n = network(), controller = new AbortController(), { agent, result } = start(controller.signal);
  controller.abort();
  assert.equal((await result).error?.name, 'AbortError');
  n.request.emit('connect', { statusCode: 200 }, n.tunnel, Buffer.alloc(0));
  assert.equal(n.tunnel.destroy.mock.callCount(), 1);
  assert.equal(n.tlsConnect.mock.callCount(), 0);
  assert.equal(n.request.destroy.mock.callCount(), 1); agent.destroy();
});
test('代理模式拒绝明文 API 地址，不发送密钥', async () => {
  const n = network();
  await assert.rejects(safeFetch('http://api.example.com/v1/models', { headers: { authorization: 'Bearer synthetic' } }), { code: 'NETWORK_CONFIG' });
  assert.equal(n.connect.mock.callCount(), 0);
});
test('系统模式跟随本机代理端口；系统代理关闭时交给 TUN 路由，既有请求保留路径', async () => {
  process.env.AI_LOCAL_PROXY_URL = 'system';
  let settings = '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7897\n}';
  const read = mock.method(childProcess, 'execFile', ((_bin: string, _args: string[], _options: unknown, done: (error: null, value: string) => void) => { done(null, settings); }) as unknown as typeof childProcess.execFile);
  const signal = new AbortController().signal;
  const first = await resolveAiProxy(signal);
  settings = settings.replace('7897', '7890');
  assert.equal((await resolveAiProxy(signal))?.port, '7890');
  assert.equal(first?.port, '7897', '已启动请求保存网络快照');
  settings = '<dictionary> {\n HTTPEnable : 0\n HTTPSEnable : 0\n}';
  assert.equal(await resolveAiProxy(signal), null);
  assert.deepEqual(read.mock.calls[0].arguments.slice(0, 2), ['/usr/sbin/scutil', ['--proxy']]);
});
test('系统代理检测失败、远程代理与 PAC 不会退回直连', async () => {
  process.env.AI_LOCAL_PROXY_URL = 'system';
  let settings = '', failure: Error | null = null;
  mock.method(childProcess, 'execFile', ((_bin: string, _args: string[], _options: unknown, done: (error: Error | null, value: string) => void) => { done(failure, settings); }) as unknown as typeof childProcess.execFile);
  for (settings of ['', '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 192.168.1.1\n HTTPSPort : 7890\n}', '<dictionary> {\n ProxyAutoConfigEnable : 1\n}', '<dictionary> {\n HTTPEnable : 1\n HTTPSEnable : 0\n}']) {
    await assert.rejects(resolveAiProxy(new AbortController().signal), { code: 'NETWORK_CONFIG' });
  }
  failure = new Error('secret-private-detail');
  await assert.rejects(resolveAiProxy(new AbortController().signal), error => {
    assert(error instanceof Error); assert(!error.message.includes('secret-private-detail')); return true;
  });
});

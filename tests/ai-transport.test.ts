import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https, { type RequestOptions } from 'node:https';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicIP, safeFetch } from '../lib/server/ai/address';
import { migrateLegacy, saveProfile, setDefault, stateFor } from '../lib/server/ai/store';

const originalEnv = { ...process.env };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xhs-ai-transport-'));
  process.env = { ...originalEnv, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_CONFIG_DIR: dir, AI_CONFIG_SECRET: '', OPENAI_API_KEY: '', OPENAI_MODEL: '' };
});
afterEach(async () => { mock.restoreAll(); process.env = originalEnv; await rm(dir, { recursive: true, force: true }); });

test('IPv6 special ranges are rejected regardless of compression or leading zeroes', () => {
  for (const ip of ['::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001::1', '2001:0000::1', '2001:2::1', '2001:20::1', '2001:db8::1', '2001:0db8::1', '2002:7f00:1::1', '3fff::1', '3fff:fff::1']) assert.equal(publicIP(ip), false, ip);
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001::200e']) assert.equal(publicIP(ip), true, ip);
});

function responseSocket(status: number, onRequest: (url: URL, options: RequestOptions & { autoSelectFamily?: boolean }) => void) {
  return mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    onRequest(url, options);
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.end = (() => {
      const incoming = new EventEmitter() as IncomingMessage;
      incoming.statusCode = status;
      incoming.headers = { 'content-type': 'application/json', location: 'https://other.example/collect' };
      callback(incoming);
      queueMicrotask(() => { incoming.emit('data', Buffer.from('{}')); incoming.emit('end'); });
      return outgoing;
    }) as ClientRequest['end'];
    return outgoing;
  }) as typeof https.request);
}

test('transport resolves once, pins the checked address, and preserves the intended TLS hostname', async () => {
  const resolver = mock.method(dns, 'lookup', (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof dns.lookup);
  const socket = responseSocket(200, (url, options) => {
    assert.equal(url.hostname, 'api.example.com');
    assert.equal(options.autoSelectFamily, false);
    assert.equal(options.family, 4);
    assert.equal(options.rejectUnauthorized, true);
    assert(options.agent instanceof https.Agent);
    assert.notEqual(options.agent, https.globalAgent);
    assert.equal(options.agent.options.proxyEnv, undefined);
    assert.equal((options.headers as Record<string, string>).authorization, 'Bearer synthetic-key');
    const lookup = options.lookup! as (host: string, options: object, callback: (error: Error | null, address: string, family: number) => void) => void;
    lookup('api.example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  });
  const response = await safeFetch('https://api.example.com/v1/models', { headers: { Authorization: 'Bearer synthetic-key' } });
  assert.equal(response.status, 200);
  assert.equal(resolver.mock.callCount(), 1);
  assert.equal(socket.mock.callCount(), 1);
});

test('private DNS answers are blocked before authorization is sent, including mixed answer sets', async () => {
  mock.method(dns, 'lookup', (async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]) as unknown as typeof dns.lookup);
  const socket = responseSocket(200, () => assert.fail('must not create a socket'));
  await assert.rejects(safeFetch('https://api.example.com/v1/models', { headers: { Authorization: 'Bearer synthetic-key' } }), /非公开网络/);
  assert.equal(socket.mock.callCount(), 0);
});

test('redirect responses never send the key to their Location destination', async () => {
  mock.method(dns, 'lookup', (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as typeof dns.lookup);
  const socket = responseSocket(302, url => assert.equal(url.hostname, 'api.example.com'));
  const response = await safeFetch('https://api.example.com/v1/models', { headers: { Authorization: 'Bearer synthetic-key' }, redirect: 'follow' });
  assert.equal(response.status, 302);
  assert.equal(socket.mock.callCount(), 1);
});

test('aborting during DNS rejects promptly and a late DNS result cannot open a socket', async () => {
  let finishLookup!: (addresses: {address:string;family:number}[]) => void;
  const resolver = mock.method(dns, 'lookup', (() => new Promise(resolve => { finishLookup = resolve; })) as unknown as typeof dns.lookup);
  const socket = responseSocket(200, () => assert.fail('must not create a socket after cancellation'));
  const controller = new AbortController();
  const request = safeFetch('https://api.example.com/v1/models', { signal: controller.signal });
  await Promise.resolve(); // Request first snapshots its network/proxy route.
  assert.equal(resolver.mock.callCount(), 1);
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(socket.mock.callCount(), 0);
  finishLookup([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.mock.callCount(), 0);
});

const lockPath = (owner: string) => join(dir, createHash('sha256').update(owner).digest('hex') + '.enc.lock');
test('local storage recovers a dead process lock and an old incomplete lock', async () => {
  const deadLock = lockPath('dead-owner'); await mkdir(deadLock);
  await writeFile(join(deadLock, 'owner-2147483647-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), '');
  await setDefault('dead-owner', null);
  await assert.rejects(readdir(deadLock), { code: 'ENOENT' });
  const incomplete = lockPath('incomplete-owner'); await mkdir(incomplete);
  const old = new Date(Date.now() - 60_000); await utimes(incomplete, old, old);
  await setDefault('incomplete-owner', null);
  await assert.rejects(readdir(incomplete), { code: 'ENOENT' });
});

test('local storage leaves a live owner lock untouched', async () => {
  const lock = lockPath('live-owner'); await mkdir(lock);
  const marker = `owner-${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  await writeFile(join(lock, marker), '');
  await assert.rejects(setDefault('live-owner', null), /正在保存/);
  assert.deepEqual(await readdir(lock), [marker]);
});

test('invalid old environment configuration does not block personal configuration', async () => {
  process.env.OPENAI_API_KEY = 'synthetic-legacy-key'; process.env.OPENAI_MODEL = 'legacy-model'; process.env.OPENAI_BASE_URL = 'http://127.0.0.1';
  await migrateLegacy('local-owner');
  assert.equal((await stateFor('local-owner')).profiles.length, 0);
  assert.equal(process.env.OPENAI_API_KEY, 'synthetic-legacy-key');
  await saveProfile('local-owner', { name: 'manual', provider: 'custom', protocol: 'responses', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-new-key', model: 'manual-model' });
  await migrateLegacy('local-owner');
  assert.equal((await stateFor('local-owner')).profiles.length, 1);
});

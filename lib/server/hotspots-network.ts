import 'server-only';
import https from 'node:https';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { HOTSPOT_BOARD } from '../hotspot-metadata';
import { publicIP } from './ai/ip';

type NetworkCode = 'NETWORK_CONFIG' | 'DNS' | 'UNSAFE_ADDRESS' | 'TLS' | 'NETWORK' | 'TOO_LARGE';
export class HotspotNetworkError extends Error {
  constructor(readonly code: NetworkCode) { super(code); }
}
const canonical = (name: string) => name.toLowerCase().replace(/\.$/u, '');

/** Validate the complete answer before opening a source connection. Never pin a
 * permanent Baidu IP, accept unrelated records, or use the OS Fake-IP answer. */
export function hotspotDnsAddresses(value: unknown): string[] {
  const fail = () => { throw new HotspotNetworkError('DNS'); };
  if (!value || typeof value !== 'object') return fail();
  const data = value as { Status?: unknown; TC?: unknown; Question?: unknown; Answer?: unknown };
  if (data.Status !== 0 || data.TC === true || !Array.isArray(data.Answer)) return fail();
  const questions = Array.isArray(data.Question) ? data.Question : [data.Question];
  const question = questions[0];
  if (questions.length !== 1 || !question || typeof question.name !== 'string' || canonical(question.name) !== 'top.baidu.com' || question.type !== 1) return fail();
  const names = new Set(['top.baidu.com']);
  for (let i = 0; i < data.Answer.length; i++) {
    for (const row of data.Answer) {
      if (row?.type === 5 && typeof row.name === 'string' && typeof row.data === 'string' && names.has(canonical(row.name))) names.add(canonical(row.data));
    }
  }
  const addresses: string[] = [];
  for (const row of data.Answer) {
    if (!row || typeof row.name !== 'string' || !names.has(canonical(row.name))) return fail();
    if (row.type === 5 && typeof row.data === 'string') continue;
    if (row.type !== 1 || typeof row.data !== 'string' || isIP(row.data) !== 4) return fail();
    if (!publicIP(row.data)) throw new HotspotNetworkError('UNSAFE_ADDRESS');
    addresses.push(row.data);
  }
  if (!addresses.length) return fail();
  return [...new Set(addresses)];
}

function interfaceAddress(): string {
  const name = process.env.HOTSPOTS_NETWORK_INTERFACE || '';
  // Only a named physical adapter explicitly configured for this local app.
  if (!/^(?:en\d+|eth\d+|wlan\d+)$/u.test(name)) throw new HotspotNetworkError('NETWORK_CONFIG');
  const address = networkInterfaces()[name]?.find(item => !item.internal && item.family === 'IPv4')?.address;
  if (!address) throw new HotspotNetworkError('NETWORK_CONFIG');
  return address; // Re-read each request, so DHCP changes do not require a restart.
}

async function boundedHttps(url: URL, localAddress: string, signal: AbortSignal, limit: number, address?: string) {
  signal.throwIfAborted();
  const agent = new https.Agent({ keepAlive: false });
  try {
    return await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      let connected = false, tls = false;
      const options: https.RequestOptions & { autoSelectFamily: false } = {
        agent, method: 'GET', signal, localAddress, family: 4, autoSelectFamily: false, rejectUnauthorized: true,
        headers: { accept: address ? 'text/html' : 'application/dns-json', 'accept-encoding': 'identity', 'accept-language': 'zh-CN,zh;q=0.9' },
        ...(address ? { servername: 'top.baidu.com', lookup: (_host, _options, callback) => callback(null, address, 4) } as Pick<https.RequestOptions, 'lookup' | 'servername'> : {}),
      };
      const request = https.request(url, options, response => {
        if (Number(response.headers['content-length']) > limit) { const error = new HotspotNetworkError('TOO_LARGE'); reject(error); request.destroy(error); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { const error = new HotspotNetworkError('TOO_LARGE'); reject(error); request.destroy(error); return; }
          chunks.push(chunk);
        });
        response.on('error', () => reject(new HotspotNetworkError('NETWORK')));
        response.on('end', () => resolve({ status: response.statusCode || 502, body: Buffer.concat(chunks) }));
      });
      request.on('socket', socket => {
        socket.once('connect', () => { connected = true; });
        socket.once('secureConnect', () => { tls = true; });
      });
      request.on('error', error => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error instanceof HotspotNetworkError) { reject(error); return; }
        reject(new HotspotNetworkError(connected && !tls ? 'TLS' : 'NETWORK'));
      });
      request.end();
    });
  } finally { agent.destroy(); }
}

/** Source-specific transport. Never accepts a user URL, cookie or provider key.
 * The opt-in local path uses AliDNS HTTPS and the configured physical adapter;
 * it does not change system DNS/proxy or any AI provider connection. */
export const fetchHotspotSource: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== HOTSPOT_BOARD || request.method !== 'GET') throw new HotspotNetworkError('NETWORK_CONFIG');
  const mode = process.env.HOTSPOTS_NETWORK_MODE || 'system';
  if (mode === 'system') return fetch(request.url, init);
  if (mode !== 'direct-interface' || process.env.APP_MODE !== 'local' || process.env.APP_LOCAL_ONLY !== '1' || process.env.VERCEL) throw new HotspotNetworkError('NETWORK_CONFIG');
  const localAddress = interfaceAddress();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]);
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  let addresses: string[];
  try {
    // Fixed documented resolver IP, not a hardcoded source IP. Only the public
    // hostname and A-record type are sent; no ECS, credentials or user content.
    const dns = await boundedHttps(new URL('https://223.5.5.5/resolve?name=top.baidu.com&type=A'), localAddress, dnsSignal, 32_768);
    if (dns.status !== 200) throw new HotspotNetworkError('DNS');
    addresses = hotspotDnsAddresses(JSON.parse(dns.body.toString('utf8')));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HotspotNetworkError && error.code === 'UNSAFE_ADDRESS') throw error;
    throw new HotspotNetworkError('DNS');
  }
  const result = await boundedHttps(new URL(HOTSPOT_BOARD), localAddress, signal, 1_000_000, addresses[0]);
  // No retries or redirects; the collector retains its existing status/HTML checks.
  return new Response([204,304].includes(result.status) ? null : new Uint8Array(result.body), { status: result.status, headers: { 'content-type': 'text/html; charset=utf-8' } });
};

import 'server-only';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { isIP } from 'node:net';
import { AppError } from '@/lib/errors';
import { publicIP } from './ip';

/** Explicit app-only opt-in. Never inherit global proxy variables or trust a
 * proxy URL supplied by an API profile/browser. Only a local HTTP CONNECT port. */
export function localAiProxy(value = process.env.AI_LOCAL_PROXY_URL): URL | null {
  if (!value) return null;
  const invalid = () => new AppError('NETWORK_CONFIG', 'AI 本机代理配置无效：仅支持本机模式下的 http://127.0.0.1:端口，不允许账号、路径或查询参数。', 503);
  if (process.env.APP_MODE !== 'local' || process.env.APP_LOCAL_ONLY !== '1' || process.env.VERCEL) throw invalid();
  let url: URL; try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
  return url;
}
/** Resolve once per task request, so DNS and provider TLS use the same path.
 * macOS system settings are read only. TUN needs no HTTP proxy; routing stays
 * under the OS. Never fall back from a configured but broken proxy to direct. */
export async function resolveAiProxy(signal: AbortSignal): Promise<URL | null> {
  signal.throwIfAborted();
  if (process.env.AI_LOCAL_PROXY_URL !== 'system') return localAiProxy();
  // Reuse strict local-mode validation before reading any OS setting.
  localAiProxy('http://127.0.0.1:1');
  const invalid = () => new AppError('NETWORK_CONFIG', '无法使用当前系统代理配置。请检查代理软件的系统代理设置；仅支持本机 HTTP 代理或关闭系统代理后使用 TUN，不支持远程代理和 PAC。', 503);
  if (process.platform !== 'darwin') throw invalid();
  const output = await new Promise<string>((resolve, reject) => {
    childProcess.execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 16 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (error) { reject(invalid()); return; }
      resolve(stdout);
    });
  });
  signal.throwIfAborted();
  const setting = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  if (!output.includes('<dictionary>') || setting('ProxyAutoConfigEnable') === '1' || setting('ProxyAutoDiscoveryEnable') === '1') throw invalid();
  if (setting('HTTPSEnable') !== '1') {
    if (setting('HTTPEnable') === '1') throw invalid();
    return null;
  }
  const host = setting('HTTPSProxy'), port = setting('HTTPSPort');
  if (host !== '127.0.0.1' || !port || !/^\d+$/.test(port)) throw invalid();
  return localAiProxy(`http://127.0.0.1:${port}`);
}
const proxyError = () => new AppError('AI_PROXY_UNAVAILABLE', '无法通过已配置的本机 AI 代理建立安全连接，请确认代理软件正在运行且端口正确。未自动改为直连，已有内容保留。', 502);

/** CONNECT receives only a checked public IP and port. The API key and request
 * body are written only after TLS verifies the original provider hostname. */
export function aiHttpsAgent(address: string, hostname: string, port: number, signal: AbortSignal, proxy = localAiProxy()): https.Agent {
  const agent = new https.Agent({ keepAlive: false });
  if (!proxy) return agent;
  if (!publicIP(address)) throw new AppError('UNSAFE_ADDRESS', '服务地址不是公开网络，已停止请求。', 400);
  agent.createConnection = ((_options, callback) => {
    if (!callback) throw proxyError();
    // Node accepts no socket on connection failure; net's callback type still
    // declares it required for both success and failure.
    const done = callback as (error: Error | null, stream?: tls.TLSSocket) => void;
    let socket: tls.TLSSocket | undefined, settled = false;
    const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
    const request = http.request({ hostname: '127.0.0.1', port: Number(proxy.port), method: 'CONNECT', path: authority,
      agent: false, headers: { host: authority } });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) { request.destroy(); socket?.destroy(); done(error); }
      else done(null, socket);
    };
    const cancel = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(proxyError()), 10_000);
    signal.addEventListener('abort', cancel, { once: true });
    request.once('error', () => finish(proxyError()));
    request.once('connect', (response, tunnel, head) => {
      if (settled || signal.aborted || response.statusCode !== 200 || head.length) { tunnel.destroy(); finish(proxyError()); return; }
      socket = tls.connect({ socket: tunnel, servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true, checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(hostname, certificate) });
      socket.once('error', () => finish(proxyError()));
      socket.once('secureConnect', () => finish());
    });
    request.once('response', response => { response.resume(); finish(proxyError()); });
    if (signal.aborted) cancel(); else request.end();
    return undefined;
  }) as typeof agent.createConnection;
  return agent;
}

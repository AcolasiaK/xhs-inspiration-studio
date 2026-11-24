import 'server-only';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

type BrowserReply = { ok?: boolean; targetId?: string; path?: string; result?: unknown; error?: { message?: string } };
export type BrowserSearchPort = (args: string[], signal: AbortSignal) => Promise<BrowserReply>;
export const browserNavigationBlockedNotice = 'OpenClaw 的导航保护拦截了检索页面。请检查本机代理是否对检索域名返回了 Fake-IP。';
const explicitProxyNotice = 'OpenClaw 的导航保护拦截了给浏览器单独指定的代理。请使用工作台默认的浏览器配置。';
export class BrowserNavigationBlockedError extends Error {
  constructor(reason: 'navigation' | 'explicit-proxy' = 'navigation') { super(reason === 'explicit-proxy' ? explicitProxyNotice : browserNavigationBlockedNotice); }
}
export class BrowserPageTimeoutError extends Error {
  constructor() { super('搜索页面加载超时，尚未确认本次检索页面就绪。'); }
}

const exec = promisify(execFile);
const runCli: BrowserSearchPort = async (args, signal) => {
  const { stdout } = await exec(join(homedir(), '.openclaw/bin/openclaw'), ['browser', '--browser-profile', 'openclaw', '--json', ...args], {
    signal, timeout: 35_000, maxBuffer: 2_000_000, env: { ...process.env, NO_COLOR: '1' },
  });
  return JSON.parse(stdout) as BrowserReply;
};

function reachedDestination(value: unknown, wanted: URL, exact: boolean) {
  if (!value || typeof value !== 'object' || !('url' in value) || typeof value.url !== 'string' ||
    !('ready' in value) || !['interactive', 'complete'].includes(String(value.ready)) || wanted.protocol !== 'https:') return false;
  let actual: URL;
  try { actual = new URL(value.url); } catch { return false; }
  if (!exact && wanted.origin === 'https://cn.bing.com' && actual.origin === 'https://www.bing.com') wanted.hostname = 'www.bing.com';
  if (actual.username || actual.password || actual.origin !== wanted.origin) return false;
  // Let the existing site guard handle a visible verification page without dismissing it.
  if (!exact && wanted.origin === 'https://www.xiaohongshu.com' && /^\/(?:captcha|website-login)(?:\/|$)/u.test(actual.pathname)) return true;
  if (exact && actual.searchParams.size !== wanted.searchParams.size) return false;
  return actual.pathname === wanted.pathname && [...wanted.searchParams.keys()].every(key =>
    JSON.stringify(actual.searchParams.getAll(key)) === JSON.stringify(wanted.searchParams.getAll(key)));
}

/** A navigation may time out waiting for media after the requested document is already usable. */
export async function runOpenClawBrowser(args: string[], signal: AbortSignal, execute: BrowserSearchPort = runCli): Promise<BrowserReply> {
  signal.throwIfAborted();
  try {
    const reply = await execute(args, signal);
    if (reply.ok === false) throw new Error(reply.error?.message || 'BROWSER_UNAVAILABLE');
    return reply;
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as { message?: string; stdout?: string; stderr?: string; killed?: boolean; code?: string | number | null; signal?: string };
    const message = [failure?.stderr, failure?.stdout, failure?.message].join('\n');
    if (/strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed/iu.test(message)) throw new BrowserNavigationBlockedError('explicit-proxy');
    if (/\bbrowser navigation blocked by policy\b/iu.test(message)) throw new BrowserNavigationBlockedError();
    const targetIndex = args.indexOf('--target-id');
    // execFile's own deadline reports SIGTERM and a null exit code rather than ETIMEDOUT.
    const transportTimeout = (failure?.killed === true && failure.signal === 'SIGTERM' && failure.code === null) ||
      /\bgateway (?:request timed out|timeout) after \d+ms\b/iu.test(message);
    if (args[0] === 'navigate' && targetIndex >= 0 && args[targetIndex + 1] &&
        (transportTimeout || /page\.goto:\s*Timeout|browser request timed out/iu.test(message))) {
      const page = await execute(['evaluate', '--target-id', args[targetIndex + 1], '--fn', '() => ({url:location.href,ready:document.readyState})'], signal).catch(() => undefined);
      signal.throwIfAborted();
      if (page && page.ok !== false && reachedDestination(page.result, new URL(args[1]), transportTimeout)) return { ok: true, targetId: args[targetIndex + 1] };
      throw new BrowserPageTimeoutError();
    }
    // CLI failures may include signed URLs, request bodies or local credentials.
    throw new Error('BROWSER_UNAVAILABLE');
  }
}

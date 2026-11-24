import { createHash, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";
import { getServerConfig } from "./config";

export function verifyAccessToken(supplied: string, expected: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return Boolean(expected) && timingSafeEqual(hash(supplied), hash(expected));
}

// This flag is set by commands that bind Next to 127.0.0.1, not inferred from a client header.
// Host checks additionally reject DNS rebinding / unintended proxy exposure.
export function assertLocalRequest(request: Request, config = getServerConfig()) {
  if (!config.localOnly) return;
  const allowed = new Set(["127.0.0.1", "localhost", "[::1]"]);
  let local = false;
  try {
    const url = new URL(request.url);
    const host = new URL(`${url.protocol}//${request.headers.get("host") || ""}`);
    // NextRequest normalizes 127.0.0.1 / ::1 to localhost in request.url.
    // Validate both loopback names and the port; compare Origin to the actual Host.
    local = allowed.has(url.hostname) && allowed.has(host.hostname) && host.port === url.port;
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).origin !== host.origin) local = false;
    if (request.headers.get("sec-fetch-site") === "cross-site") local = false;
  } catch { /* Invalid hosts and origins are rejected without logging their contents. */ }
  if (!local) throw new AppError("INVALID_ORIGIN", "当前仅支持本机访问，请从本机工具地址打开页面。", 403);
}

export function assertAppAccess(request: Request, config = getServerConfig()) {
  if (config.localOnly) { assertLocalRequest(request, config); return; }
  if (config.production && config.accessToken.length < 16) throw new AppError("ACCESS_NOT_CONFIGURED", "当前运行方式尚未配置访问控制。请使用项目的本机启动命令；对外部署需另行配置访问控制。", 503);
  if (config.accessToken && !verifyAccessToken(request.headers.get("x-access-token") || "", config.accessToken)) throw new AppError("UNAUTHORIZED", "当前请求未通过服务端访问控制，请检查运行方式。已有内容已保留。", 401);
}

// 单进程防连点。本机由回环地址隔离；对外部署应配置独立鉴权与持久化额度。
const windows = new Map<string, { count: number; expires: number }>();
export class RateLimitError extends AppError {
  readonly retryAfterSeconds:number;
  readonly retryAt:string;
  readonly scope:'hotspots_update'|'hotspots_suggest'|'live'|'workbench';
  constructor(key:string,expires:number,now:number){
    const scope=key==='hotspots_update'||key==='hotspots_suggest'||key==='live'?key:'workbench';
    const label=scope==='hotspots_update'?'热点刷新':scope==='hotspots_suggest'?'选题建议':scope==='live'?'AI 生成':'操作';
    const seconds=Math.max(1,Math.ceil((expires-now)/1000));
    const time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(expires);
    super('RATE_LIMIT',`工作台${label}请求过于频繁，请在 ${time}（北京时间，约 ${seconds} 秒后）重试。`,429);
    this.retryAt=new Date(expires).toISOString();this.retryAfterSeconds=seconds;this.scope=scope;
  }
}
export function checkRateLimit(key: string, limit: number, now = Date.now()) {
  for (const [id, state] of windows) if (state.expires <= now) windows.delete(id);
  const current = windows.get(key);
  if (!current) { windows.set(key, { count: 1, expires: now + 60_000 }); return; }
  if (current.count >= limit) throw new RateLimitError(key,current.expires,now);
  current.count += 1;
}

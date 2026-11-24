export type HotspotAction = 'update' | 'suggest';
/** One active operation, independent cooldowns; expiry never sends a request. */
export class HotspotActionGate {
  private active = false;
  private retryAt = { update: 0, suggest: 0 };
  start(action: HotspotAction, now = Date.now()) {
    if (this.active || now < this.retryAt[action]) return false;
    this.active = true; return true;
  }
  finish() { this.active = false; }
  defer(action: HotspotAction, until: number) { this.retryAt[action] = until; }
}
export class HotspotActionError extends Error {
  constructor(message: string, public code: string, public retryAt = 0) { super(message); }
}
export function hotspotFailure(response: Pick<Response, 'status' | 'headers'>, body: unknown, action: HotspotAction, now = Date.now()) {
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  const detail = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; retryAt?: unknown } : null;
  const code = typeof detail?.code === 'string' ? detail.code : 'UNKNOWN';
  const fallback = action === 'update' ? '热点刷新未完成，已有数据保留。' : 'AI 选题生成未完成，已有建议保留。';
  const message = typeof detail?.message === 'string' ? detail.message : typeof error === 'string' ? error : fallback;
  // Only the workbench RATE_LIMIT contract promises a concrete retry time.
  const seconds=Number(response.headers.get('Retry-After'));
  const retry = code === 'RATE_LIMIT' ? typeof detail?.retryAt === 'string' ? Date.parse(detail.retryAt) : seconds>0&&seconds<=60?now+seconds*1000:NaN : NaN;
  return new HotspotActionError(message, code, Number.isFinite(retry) && retry > now ? retry : 0);
}

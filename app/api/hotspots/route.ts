import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { isRequestId } from '@/lib/client-diagnostics';
import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { requireUser } from '@/lib/cloud/server/auth';
import { readJson } from '@/lib/cloud/server/config';
import { getServerConfig } from '@/lib/server/config';
import { assertAppAccess, assertLocalRequest, checkRateLimit, RateLimitError } from '@/lib/server/guard';
import { xhsCategoryIdSchema } from '@/lib/xhs-hotspot-rules';
import { getAiSource } from '@/lib/server/ai-source';
import { getXhsHotspotsStore } from '@/lib/server/xhs-hotspots-store';

export const runtime = 'nodejs';
export const maxDuration = 230;
const headers = { 'Cache-Control': 'no-store' };
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('regroup'), categories: z.array(xhsCategoryIdSchema).min(1).max(30).optional() }),
  z.object({ action: z.literal('update'), force: z.boolean().optional(), categories: z.array(xhsCategoryIdSchema).min(1).max(30).optional() }),
  z.object({ action: z.literal('analyze'), noteId: z.string().regex(/^[a-f0-9]{24}$/), force: z.boolean().optional() }),
]);
function assertXhsLocal(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) throw new AppError('INVALID_ORIGIN', '请从本机工作台页面操作。', 403);
  assertLocalRequest(request); assertAppAccess(request);
  if (isCloudMode() || !getServerConfig().localOnly) throw new AppError('XHS_LOCAL_ONLY', '小红书热点通过本机 OpenClaw 登录态采集，请在本机工作台打开此页。', 503);
}
function failure(error: unknown, responseHeaders: Record<string, string> = headers) {
  const known = error instanceof AppError ? error : new AppError('SERVER_ERROR', '热点请求暂时失败，已有结果保留，请稍后重试。', 500);
  const limited = error instanceof RateLimitError ? { retryAt: error.retryAt, retryAfterSeconds: error.retryAfterSeconds, scope: error.scope } : {};
  return Response.json({ error: { code: known.code, message: known.message, ...limited }, requestId: responseHeaders['X-Request-ID'] }, { status: known.status, headers: { ...responseHeaders, ...(error instanceof RateLimitError ? { 'Retry-After': String(error.retryAfterSeconds) } : {}) } });
}
export async function GET(request: Request) {
  try {
    if (isCloudMode()) await requireUser(request, { requireIdentity: true });
    assertXhsLocal(request);
    const state = await getXhsHotspotsStore().state();
    if (new URL(request.url).searchParams.get('check') === 'storage') {
      return Response.json({ storage: state.storage, revision: state.configuredRules?.revision, updating: state.updating, analyzing: state.analyzing }, { headers });
    }
    return Response.json(state, { headers });
  }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const supplied = request.headers.get('X-Request-ID');
  const headers = { 'Cache-Control': 'no-store', 'X-Request-ID': isRequestId(supplied) ? supplied! : randomUUID() };
  try {
    if (request.headers.has('X-AI-Source') && request.headers.get('X-AI-Source') !== 'relay') throw new AppError('SOURCE_REMOVED', '订阅通道已停用，请在 AI 设置中配置 API 密钥。', 400);
    if (isCloudMode()) await requireUser(request, { requireIdentity: true });
    assertXhsLocal(request);
    const parsed = inputSchema.safeParse(await readJson(request, 4096));
    if (!parsed.success) throw new AppError('INVALID_FORM', '请检查热点操作或笔记编号。', 400);
    const input = parsed.data, store = getXhsHotspotsStore();
    if (input.action === 'cancel') return Response.json(await store.cancel(), { headers });
    if (input.action === 'regroup') { checkRateLimit('hotspots_update', 6); return Response.json(await store.regroup(input.categories), { headers }); }
    if (input.action === 'update') {
      checkRateLimit('hotspots_update', 6);
      const state = await store.update(input.force === true, input.categories);
      return Response.json(state, { status: state.updating ? 202 : 200, headers });
    }
    const state = await store.state();
    const note = [...Object.values(state.previews || {}), ...Object.values(state.categories)].flatMap(category => category.notes).find(note => note.id === input.noteId);
    const cached = state.analyses[input.noteId];
    if (!input.force && note && cached?.fingerprint === note.fingerprint) return Response.json({ analysis: cached, cached: true }, { headers });
    checkRateLimit('hotspots_suggest', 4); checkRateLimit('live', 6);
    const source = await getAiSource(request);
    const deadline = AbortSignal.timeout(220_000);
    const analysis = await store.analyze(input.noteId, source, input.force === true, AbortSignal.any([request.signal, deadline]));
    return Response.json({ analysis, cached: false }, { headers });
  } catch (error) { return failure(error, headers); }
}

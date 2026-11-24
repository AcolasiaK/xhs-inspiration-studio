import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { ownerFor } from '@/lib/server/ai/selection';
import { checkRateLimit } from '@/lib/server/guard';
import { readStyleReference } from '@/lib/server/style-reference';
import { getXhsHotspotsStore } from '@/lib/server/xhs-hotspots-store';

export const runtime = 'nodejs';
export const maxDuration = 250;
export async function POST(request: Request) {
  const deadline = AbortSignal.timeout(240_000), signal = AbortSignal.any([request.signal, deadline]);
  try {
    const owner = await ownerFor(request);
    if (isCloudMode()) throw new AppError('XHS_LOCAL_ONLY', '链接读取使用本机 OpenClaw 浏览器，请在本机工作台操作；此处可粘贴文案。', 403);
    const parsed = z.object({ link: z.string().trim().min(1).max(3000) }).strict().safeParse(await readJson(request, 16000));
    if (!parsed.success) throw new AppError('INVALID_FORM', '请提供一条小红书笔记链接。', 400);
    checkRateLimit('style-reference:' + owner, 10);
    if ((await getXhsHotspotsStore().state()).updating) throw new AppError('XHS_BUSY', '热点正在采集，请完成后再读取链接；也可以直接粘贴正文。', 409);
    return Response.json(await readStyleReference(parsed.data.link, signal), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return cloudError(signal.aborted ? new AppError(request.signal.aborted ? 'CANCELLED' : 'TIMEOUT', request.signal.aborted ? '已取消读取，现有文案保留。' : '链接读取超时，请重试或粘贴正文。', request.signal.aborted ? 499 : 504) : error);
  }
}

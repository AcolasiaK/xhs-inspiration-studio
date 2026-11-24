import { AppError } from '@/lib/errors';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { MAX_REFERENCE_IMAGE_BYTES } from '@/lib/personal/style-learning';
import { ownerFor, selectProfile } from '@/lib/server/ai/selection';
import { checkRateLimit } from '@/lib/server/guard';
import { analyzeWritingStyle } from '@/lib/server/style-learning';
import { analysisForLegacyPage, parseStyleLearningInput } from '@/lib/server/style-learning-compat';
import { OutputBudgetError } from '@/lib/server/ai/output-budget';
import { styleLearningRecovery } from '@/lib/server/style-learning-recovery';

export const runtime = 'nodejs';
export const maxDuration = 200;
export async function POST(request: Request) {
  const deadline = AbortSignal.timeout(190_000), signal = AbortSignal.any([request.signal, deadline]);
  const interrupted = () => new AppError(request.signal.aborted ? 'CANCELLED' : 'TIMEOUT', request.signal.aborted ? '已取消分析，输入和上次结果保留。' : '风格分析超时，输入和上次结果保留。', request.signal.aborted ? 499 : 504);
  let onAbort: () => void = () => undefined, legacyPage = false;
  try {
    const owner = await ownerFor(request);
    const { input, legacy } = parseStyleLearningInput(await readJson(request, MAX_REFERENCE_IMAGE_BYTES + 600_000));
    legacyPage = legacy;
    checkRateLimit('style-learning:' + owner, 6); checkRateLimit('live', 6);
    const source = await selectProfile(owner, request.headers.get('X-AI-Profile'));
    if (signal.aborted) throw interrupted();
    const stop = new Promise<never>((_, reject) => { onAbort = () => reject(interrupted()); signal.addEventListener('abort', onAbort, { once: true }); });
    const analysis = await Promise.race([analyzeWritingStyle(input, source, signal, { legacy }), stop]);
    if (signal.aborted) throw interrupted();
    return Response.json({ analysis: legacy ? analysisForLegacyPage(analysis) : analysis }, { headers: { 'Cache-Control': 'no-store', 'X-Style-Learning-Version': legacy ? '1' : '2' } });
  } catch (error) {
    if (!signal.aborted && error instanceof OutputBudgetError) return Response.json({
      error: { code: error.code, message: error.message + (legacyPage ? ' 当前页面为旧版，请先保留未保存内容并刷新，即可在分析页直接选择本次上限。' : '') },
      recovery: styleLearningRecovery(error),
    }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
    return cloudError(signal.aborted ? interrupted() : error);
  }
  finally { signal.removeEventListener('abort', onAbort); }
}

import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { styleJobActionSchema, styleJobIdSchema } from '@/lib/personal/style-learning-job';
import { ownerFor } from '@/lib/server/ai/selection';
import { getStyleLearningJob, pauseStyleLearningJob, resumeStyleLearningJob } from '@/lib/server/style-learning-jobs';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'no-store' };
async function identity(request: Request, context: Context) {
  if (isCloudMode()) throw new AppError('LOCAL_ONLY', '分步后台分析请在本机工作台使用。', 400);
  const owner = await ownerFor(request), id = styleJobIdSchema.safeParse((await context.params).id);
  if (!id.success) throw new AppError('NOT_FOUND', '没有找到这次分析。', 404);
  return { owner, id: id.data };
}
export async function GET(request: Request, context: Context) {
  try {
    const { owner, id } = await identity(request, context);
    return Response.json(await getStyleLearningJob(owner, id, new URL(request.url).searchParams.get('input') === '1'), { headers });
  } catch (error) { return cloudError(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { owner, id } = await identity(request, context), parsed = styleJobActionSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError('INVALID_FORM', '请检查本次等待时间和输出上限，再确认如何继续。', 400);
    const job = parsed.data.action === 'pause' ? await pauseStyleLearningJob(owner, id) : await resumeStyleLearningJob(owner, id, parsed.data.settings);
    return Response.json({ job }, { headers });
  } catch (error) { return cloudError(error); }
}

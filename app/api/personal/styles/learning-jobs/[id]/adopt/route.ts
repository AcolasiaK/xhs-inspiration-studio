import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { styleJobIdSchema } from '@/lib/personal/style-learning-job';
import { adoptStyleLearningSchema } from '@/lib/personal/style-integration';
import { ownerFor } from '@/lib/server/ai/selection';
import { adoptStyleLearningJob } from '@/lib/server/style-learning-jobs';

export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (isCloudMode()) throw new AppError('LOCAL_ONLY', '持续学习与综合更新请在本机工作台使用。', 400);
    const owner = await ownerFor(request), id = styleJobIdSchema.safeParse((await context.params).id);
    if (!id.success) throw new AppError('NOT_FOUND', '没有找到这次分析。', 404);
    const parsed = adoptStyleLearningSchema.safeParse(await readJson(request, 160_000));
    if (!parsed.success) throw new AppError('INVALID_FORM', '请检查规则草稿、所选写法和冲突处理方式。', 400);
    return Response.json(await adoptStyleLearningJob(owner, id.data, parsed.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return cloudError(error); }
}

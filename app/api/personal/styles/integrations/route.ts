import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { startStyleIntegrationSchema } from '@/lib/personal/style-learning-job';
import { ownerFor } from '@/lib/server/ai/selection';
import { startStyleIntegrationJob } from '@/lib/server/style-learning-jobs';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    if (isCloudMode()) throw new AppError('LOCAL_ONLY', '持续学习与综合更新请在本机工作台使用。', 400);
    const owner = await ownerFor(request), parsed = startStyleIntegrationSchema.safeParse(await readJson(request, 32_000));
    if (!parsed.success) throw new AppError('INVALID_FORM', '请检查所选写法、目标风格版本与本次等待设置。', 400);
    return Response.json({ job: await startStyleIntegrationJob(owner, parsed.data, request.headers.get('X-AI-Profile')) }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return cloudError(error); }
}

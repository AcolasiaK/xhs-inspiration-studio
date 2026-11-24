import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { MAX_REFERENCE_IMAGE_BYTES, styleLearningInputError } from '@/lib/personal/style-learning';
import { startStyleJobSchema } from '@/lib/personal/style-learning-job';
import { ownerFor } from '@/lib/server/ai/selection';
import { listStyleLearningJobs, startStyleLearningJob } from '@/lib/server/style-learning-jobs';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request) {
  try {
    if (isCloudMode()) throw new AppError('LOCAL_ONLY', '分步后台分析请在本机工作台使用。', 400);
    return Response.json({ jobs: await listStyleLearningJobs(await ownerFor(request)) }, { headers });
  } catch (error) { return cloudError(error); }
}
export async function POST(request: Request) {
  try {
    if (isCloudMode()) throw new AppError('LOCAL_ONLY', '分步后台分析请在本机工作台使用。', 400);
    const owner = await ownerFor(request), parsed = startStyleJobSchema.safeParse(await readJson(request, MAX_REFERENCE_IMAGE_BYTES + 600_000));
    if (!parsed.success) throw new AppError('INVALID_FORM', styleLearningInputError(parsed.error), 400);
    const { id, input, settings } = parsed.data;
    return Response.json({ job: await startStyleLearningJob(owner, id, input, settings, request.headers.get('X-AI-Profile')) }, { status: 202, headers });
  } catch (error) { return cloudError(error); }
}

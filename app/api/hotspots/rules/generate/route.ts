import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { assertLocalRequest, assertAppAccess, checkRateLimit } from '@/lib/server/guard';
import { getServerConfig } from '@/lib/server/config';
import { isCloudMode } from '@/lib/cloud/mode';
import { readJson } from '@/lib/cloud/server/config';
import { getAiSource } from '@/lib/server/ai-source';
import { xhsCategoryIdSchema, xhsRulesSchema } from '@/lib/xhs-hotspot-rules';
import { editableRuleFields } from '@/lib/xhs-rule-draft';
import { generateXhsRuleDraft } from '@/lib/server/xhs-rules-ai';
export const runtime = 'nodejs';
export const maxDuration = 190;
const input = z.object({ rules: xhsRulesSchema, category: xhsCategoryIdSchema, demand: z.string().trim().min(5).max(4000), lockedFields: z.array(z.string().refine(s => editableRuleFields.includes(s))).max(60) });
export async function POST(request: Request) {
 try {
  assertLocalRequest(request); assertAppAccess(request);
  if (isCloudMode() || !getServerConfig().localOnly) throw new AppError('XHS_LOCAL_ONLY', '请在本机工作台生成检索规则。', 403);
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) throw new AppError('INVALID_ORIGIN', '请从工作台页面操作。', 403);
  const parsed = input.safeParse(await readJson(request, 600_000));
  if (!parsed.success) throw new AppError('INVALID_FORM', '请填写需求并检查当前规则。', 400);
  checkRateLimit('xhs_rule_generate', 6);
  const { rules, category, demand, lockedFields } = parsed.data;
  const source = await getAiSource(request);
  return Response.json(await generateXhsRuleDraft(rules, category, demand, lockedFields, source, AbortSignal.any([request.signal, AbortSignal.timeout(180_000)])), { headers: { 'Cache-Control': 'no-store' } });
 } catch (e) {
  const error = e instanceof AppError ? e : new AppError('XHS_RULE_GENERATE', '规则生成失败，输入与原规则均保留，请重试。', 502);
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
 }
}

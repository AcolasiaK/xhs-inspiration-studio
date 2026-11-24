import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { requireUser } from '@/lib/cloud/server/auth';
import { readJson } from '@/lib/cloud/server/config';
import { getServerConfig } from '@/lib/server/config';
import { assertAppAccess, assertLocalRequest, checkRateLimit } from '@/lib/server/guard';
import { getXhsRulesStore } from '@/lib/server/xhs-hotspot-rules-store';
import { getXhsHotspotsStore } from '@/lib/server/xhs-hotspots-store';
import { formatXhsRuleIssues, DEFAULT_XHS_RULES, xhsRulesSchema, categoryIds } from '@/lib/xhs-hotspot-rules';
import { rankQualifiedXhsThemes } from '@/lib/xhs-hotspot-ranking';
import { blankCategory } from '@/lib/xhs-hotspots';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
async function access(request: Request) {
  if (isCloudMode()) await requireUser(request, { requireIdentity: true });
  assertLocalRequest(request); assertAppAccess(request);
  if (!getServerConfig().localOnly) throw new AppError('XHS_LOCAL_ONLY', '热点规则管理仅在本机工作台提供。', 503);
}
function failure(e: unknown) {
  const error = e instanceof AppError ? e : new AppError('XHS_RULES_ERROR', '规则操作失败，请稍后重试；已有规则保留。', 500);
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers });
}
export async function GET(request: Request) {
  try { await access(request); return Response.json({ ...await getXhsRulesStore().read(), defaults: DEFAULT_XHS_RULES }, { headers }); } catch (e) { return failure(e); }
}
export async function POST(request: Request) {
  try {
    await access(request); checkRateLimit('xhs_rules', 30);
    const body = await readJson(request, 600_000) as { action?: string; rules?: unknown; revision?: string };
    const parsed = xhsRulesSchema.safeParse(body?.rules);
    if (!parsed.success) throw new AppError('INVALID_RULES', formatXhsRuleIssues(parsed.error.issues), 400);
    if (body.action === 'preview') {
      const state = await getXhsHotspotsStore().state(), now = new Date().toISOString();
      return Response.json({ preview: categoryIds(parsed.data).map(category => {
        const c = state.categories[category] || blankCategory(), ranked = rankQualifiedXhsThemes(c.notes, category, now, parsed.data);
        return { category, collectedAt: c.collectedAt, noteCount: c.notes.length, previous: c.themes.length, count: ranked.themes.length, diagnostics: ranked.diagnostics, singles: ranked.singleNoteIds.length,
          themes: ranked.themes.map(t => ({ title: t.title, heat: t.heat, notes: t.qualifiedNoteCount || t.noteCount, authors: t.authorCount })),
          removed: c.themes.filter(t => !ranked.themes.some(next => next.title === t.title)).map(t => ({ title: t.title, reason: ranked.diagnostics.rejectedThemes.find(r => r.title === t.title)?.reason || '未满足互动门槛、具体主题规则或作者证据' })) };
      }) }, { headers });
    }
    if (body.action !== 'save' || typeof body.revision !== 'string' || body.revision.length > 80) throw new AppError('INVALID_FORM', '请重新载入规则后保存。', 400);
    return Response.json(await getXhsRulesStore().save(parsed.data, body.revision), { headers });
  } catch (e) { return failure(e); }
}

import { z } from 'zod';
import { xhsCategoryIdSchema, xhsRulesVersionSchema, type XhsRulesVersion } from './xhs-hotspot-rules';

export const XHS_CATEGORIES: Record<string, string> = { travel: '旅行', wedding: '婚礼', daily: '日常分享' } as const;
export type XhsCategory = string;
export const XHS_CATEGORY_KEYS = Object.keys(XHS_CATEGORIES) as XhsCategory[];
export const XHS_SEARCHES: Record<XhsCategory, string[]> = {
  travel: ['旅行', '周末旅行', '小众旅行', '旅游攻略', '城市漫步'],
  wedding: ['婚礼', '备婚', '婚礼布置', '婚纱', '婚礼流程'],
  daily: ['日常分享', '生活记录', '独居生活', '周末日常', '生活碎片'],
};
export const XHS_ORDERING = '近 7 天确认发布的笔记；同主题去重后，按点赞＋收藏＋评论总和降序排列，每类最多 10 个主题。仅代表本次关键词采集范围，不是小红书官方全站热榜。';
export const isoDate = z.string().datetime();
const count = z.number().int().nonnegative().max(1_000_000_000);
export const xhsTopicLabelSchema = z.object({
  name: z.string().trim().min(2).max(120), kind: z.enum(['specific', 'direction']),
  focus: z.string().trim().min(2).max(60), place: z.string().trim().min(2).max(40).nullable(),
  evidence: z.string().trim().min(2).max(200),
});
export type XhsTopicLabel = z.infer<typeof xhsTopicLabelSchema>;
export const xhsNoteSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i), title: z.string().min(1).max(300),
  author: z.string().max(100), authorId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(), url: z.string().url().max(2048),
  category: xhsCategoryIdSchema, query: z.string().max(80), matchedQueries: z.array(z.string().max(80)).max(40).optional(),
  body: z.string().max(14000), tags: z.array(z.string().max(80)).max(40),
  publishedAt: isoDate, dateLabel: z.string().max(100), collectedAt: isoDate,
  likes: count, collects: count, comments: count,
  coverUrl: z.string().max(2048).nullable(), coverFile: z.string().max(150).nullable(),
  fingerprint: z.string().max(80),
  scopeMatch: z.boolean().optional(), topicLabel: z.string().max(120).nullable().optional(), topicRuleKey: z.string().max(80).optional(),
  topicLabels: z.array(xhsTopicLabelSchema).max(6).optional(),
});
export type XhsNote = z.infer<typeof xhsNoteSchema>;
export const xhsThemeSchema = z.object({
  id: z.string().min(1).max(100), category: xhsCategoryIdSchema,
  title: z.string().min(1).max(120), rank: z.number().int().min(1).max(20),
  heat: z.number().int().nonnegative().max(10_000_000_000_000), likes: z.number().nonnegative(), collects: z.number().nonnegative(), comments: z.number().nonnegative(),
  qualifiedNoteCount: z.number().int().positive().optional(), authorCount: z.number().int().positive().optional(), noteCount: z.number().int().positive(), noteIds: z.array(z.string()).max(200),
  representatives: z.array(z.string()).min(1).max(5),
  kind: z.enum(['specific', 'direction']).optional(), focus: z.string().max(60).optional(), place: z.string().max(40).nullable().optional(),
  rawInteractions: z.number().nonnegative().optional(), countedNoteIds: z.array(z.string()).max(200).optional(),
  relatedTopics: z.array(z.object({ title: z.string().max(120), kind: z.enum(['specific', 'direction']), reason: z.string().max(200), noteIds: z.array(z.string()).max(200) })).max(200).optional(),
});
export type XhsTheme = z.infer<typeof xhsThemeSchema>;
export const xhsCandidateThemeSchema = xhsThemeSchema.extend({ verificationReasons: z.array(z.string().min(1).max(200)).min(1).max(4) });
export type XhsCandidateTheme = z.infer<typeof xhsCandidateThemeSchema>;
export const xhsAnalysisSchema = z.object({
  summary: z.string().min(1).max(1200),
  titleAndHook: z.string().min(1).max(1800),
  structure: z.array(z.string().min(1).max(800)).min(1).max(8),
  cover: z.string().min(1).max(1800),
  engagement: z.string().min(1).max(1800),
  takeaways: z.array(z.string().min(1).max(800)).min(1).max(6),
  cautions: z.array(z.string().min(1).max(600)).min(1).max(5),
});
export type XhsAnalysisContent = z.infer<typeof xhsAnalysisSchema>;
/** Adapted from xiaohongshu-ingest 1.0.0, with the workbench's evidence safeguards. */
export const xhsIngestAnalysisSchema = xhsAnalysisSchema.extend({
  audience: z.string().min(1).max(600), scene: z.string().min(1).max(600),
  painPoint: z.string().min(1).max(600), emotion: z.string().min(1).max(600),
  titleHook: z.object({ type: z.string().min(1).max(100), why: z.string().min(1).max(800) }),
  reusableTemplate: z.string().min(1).max(1600),
  derivedTopics: z.array(z.string().min(1).max(150)).length(5),
});
export type XhsIngestAnalysisContent = z.infer<typeof xhsIngestAnalysisSchema>;
export const savedAnalysisSchema = z.object({
  noteId: z.string(), fingerprint: z.string(), generatedAt: isoDate,
  model: z.string().max(200), coverObserved: z.boolean(),
  method: z.literal('xiaohongshu-ingest').optional(), methodVersion: z.literal(1).optional(),
  content: z.union([xhsIngestAnalysisSchema, xhsAnalysisSchema]),
}).refine(v => !v.method || (v.methodVersion === 1 && 'audience' in v.content), '新版拆解缺少完整分析字段');
export type XhsAnalysis = z.infer<typeof savedAnalysisSchema>;
export function isIngestAnalysis(value: XhsAnalysis): value is XhsAnalysis & { content: XhsIngestAnalysisContent } {
  return value.method === 'xiaohongshu-ingest' && value.methodVersion === 1 && 'audience' in value.content;
}
export const rankingDiagnosticsSchema = z.object({ eligibleNotes: z.number().int().nonnegative(), lowInteraction: z.number().int().nonnegative(), unknownAuthors: z.number().int().nonnegative(), noSpecificTopic: z.number().int().nonnegative(), authorDuplicates: z.number().int().nonnegative(), mergedThemes: z.number().int().nonnegative().optional(), rejectedThemes: z.array(z.object({ title: z.string(), reason: z.string(), notes: z.number(), authors: z.number() })).max(1200) });
export type XhsRankingDiagnostics = z.infer<typeof rankingDiagnosticsSchema>;
export const collectionStatsSchema = z.object({ detailsAttempted: z.number().int().nonnegative(), own: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), unknownDate: z.number().int().nonnegative(), outsideWindow: z.number().int().nonnegative(), irrelevant: z.number().int().nonnegative(), invalidCounts: z.number().int().nonnegative(), uncheckedCandidates: z.number().int().nonnegative() });
export type XhsCollectionStats = z.infer<typeof collectionStatsSchema>;
export const xhsKeywordCoverageSchema = z.object({
  query: z.string().min(1).max(80),
  status: z.enum(['pending', 'searching', 'covered', 'empty', 'partial', 'interrupted']),
  basicCovered: z.boolean(), searches: count, completedSearches: count,
  candidates: count, inspected: count, newNotes: count, newAuthors: count, matchedNotes: count,
  elapsedMs: z.number().nonnegative(), reason: z.string().max(500).nullable(),
  sorts: z.array(z.enum(['likes', 'collects', 'comments', 'latest'])).max(4),
});
export type XhsKeywordCoverage = z.infer<typeof xhsKeywordCoverageSchema>;
export const xhsSearchCoverageSchema = z.object({
  version: z.literal(1), phase: z.enum(['basic', 'expand', 'grouping', 'finished']),
  completed: count, total: count, keywords: z.array(xhsKeywordCoverageSchema).max(10),
}).superRefine((value, context) => {
  if (value.total !== value.keywords.length) context.addIssue({ code: 'custom', path: ['total'], message: '覆盖总数须对应本轮关键词' });
  if (value.completed !== value.keywords.filter(item => item.basicCovered).length) context.addIssue({ code: 'custom', path: ['completed'], message: '完成数须对应已基础覆盖的关键词' });
  if (new Set(value.keywords.map(item => item.query)).size !== value.keywords.length) context.addIssue({ code: 'custom', path: ['keywords'], message: '覆盖记录不能重复计入同一关键词' });
});
export type XhsSearchCoverage = z.infer<typeof xhsSearchCoverageSchema>;
export const categoryResultSchema = z.object({
  run: z.object({ startedAt: isoDate, finishedAt: isoDate.nullable(), firstResultMs: z.number().nonnegative().nullable(), elapsedMs: z.number().nonnegative(), stopReason: z.string().max(300), searches: z.number().nonnegative(), cacheHits: z.number().nonnegative(), aiCalls: z.number().nonnegative(), warnings: z.array(z.string().max(500)).max(20), coverage: xhsSearchCoverageSchema.optional(), themeTarget: z.object({ minimum: z.number().int().min(5).max(20), found: z.number().int().nonnegative().max(20), status: z.enum(['searching', 'met', 'shortfall']) }).optional() }).optional(),
  themes: z.array(xhsThemeSchema).max(20), candidateThemes: z.array(xhsCandidateThemeSchema).max(5).optional(), notes: z.array(xhsNoteSchema).max(200),
  rankingVersion: z.union([z.literal(2), z.literal(3)]).optional(), singleNoteIds: z.array(z.string()).max(20).optional(), diagnostics: rankingDiagnosticsSchema.optional(), collectionStats: collectionStatsSchema.optional(),
  regroupedAt: isoDate.optional(),
  // Validate historical snapshots without injecting new defaults into untouched categories.
  ruleSnapshot: z.custom<XhsRulesVersion>(value => xhsRulesVersionSchema.safeParse(value).success).optional(),
  collectionRuleSnapshot: z.custom<XhsRulesVersion>(value => xhsRulesVersionSchema.safeParse(value).success).optional(),
  collectedAt: isoDate.nullable(), attemptedAt: isoDate.nullable(), error: z.string().max(500).nullable(),
  candidateCount: count, excludedCount: count, queries: z.array(z.string()).max(60),
});
export type XhsCategoryResult = z.infer<typeof categoryResultSchema>;
export const blankCategory = (): XhsCategoryResult => ({ themes: [], notes: [], collectedAt: null, attemptedAt: null, error: null, candidateCount: 0, excludedCount: 0, queries: [] });
export type XhsProgress = { category: XhsCategory | null; message: string; current: number; total: number };
export type XhsHotspotState = {
  version: 2; categories: Record<XhsCategory, XhsCategoryResult>;
  analyses: Record<string, XhsAnalysis>; analyzing: string[];
  updating: boolean; updatingCategories?: XhsCategory[]; progress: XhsProgress | null; previews?: Record<string, XhsCategoryResult>; error: string | null;
  lastAttemptAt: string | null; lastSuccessAt: string | null;
  scheduler: boolean; storage: 'disk' | 'memory'; ordering: string;
  configuredRules?: XhsRulesVersion;
};
export function beijingDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function noteHeat(note: Pick<XhsNote, 'likes' | 'collects' | 'comments'>): number {
  return note.likes + note.collects + note.comments;
}

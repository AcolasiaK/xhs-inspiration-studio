import 'server-only';
import { z } from 'zod';
import { AppError } from '../errors';
import { learningScopes, referenceImagesSchema, styleAnalysisSchema, styleLearningInputError, styleLearningRequestSchema, type StyleAnalysis, type StyleLearningRequest } from '../personal/style-learning';

// Tabs opened before multi-reference learning still send and validate this contract.
export const legacyStyleAnalysisSchema = z.object({
  name: z.string().trim().min(1).max(60), summary: z.string().trim().min(1).max(600),
  traits: z.array(z.object({
    scope: z.enum(learningScopes), label: z.string().trim().min(1).max(40),
    observation: z.string().trim().min(1).max(500), evidence: z.string().trim().min(1).max(160),
    imageIds: z.array(z.string().min(1).max(80)).max(20), rule: z.string().trim().min(1).max(700),
  }).strict()).min(1).max(12),
  imageAnalyses: z.array(styleAnalysisSchema.shape.imageAnalyses.element.omit({ referenceId: true })).max(20),
  cautions: z.array(z.string().min(1).max(300)).max(5),
}).strict();
const legacyRequestSchema = z.object({
  referenceText: z.string().trim().max(12000), referenceImages: referenceImagesSchema.default([]),
  preferences: z.string().trim().max(2000).default(''), previous: legacyStyleAnalysisSchema.optional(),
  maxOutputTokens: styleLearningRequestSchema.shape.maxOutputTokens,
}).strict().refine(input => input.referenceText.length >= 20 || input.referenceImages.length > 0, '请提供至少 20 字文案或一张参考图。');

// Reserve room for compatibility labels without truncating executable rules or evidence.
export const legacyCompatibleStyleAnalysisSchema = styleAnalysisSchema.extend({
  traits: z.array(styleAnalysisSchema.shape.traits.element.extend({
    observation: z.string().trim().min(1).max(470), rule: z.string().trim().min(1).max(690),
  })).min(1).max(12),
  cautions: z.array(z.string().min(1).max(300)).max(4),
});
export function parseStyleLearningInput(value: unknown): { input: StyleLearningRequest; legacy: boolean } {
  const legacy = typeof value === 'object' && value !== null && !('references' in value) && ('referenceText' in value || 'referenceImages' in value);
  if (!legacy) {
    const parsed = styleLearningRequestSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_FORM', styleLearningInputError(parsed.error), 400);
    return { input: parsed.data, legacy: false };
  }
  const parsed = legacyRequestSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_FORM', styleLearningInputError(parsed.error), 400);
  const { referenceText, referenceImages, preferences, previous, maxOutputTokens } = parsed.data;
  // The old form mixed title and body. Never pretend its first line is a verified title.
  const input: StyleLearningRequest = { references: [{ id: 'primary', title: '', text: referenceText, images: referenceImages, url: '' }], preferences, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) };
  if (previous) input.previous = {
    name: previous.name, summary: previous.summary,
    portrait: { temperament: previous.summary, titles: { available: false, expression: '', language: '', appeal: '', relation: '' }, body: '旧版分析未单独提供正文画像，请根据本次参考重新提炼。', captions: '旧版分析的逐图观察见 imageAnalyses，请重新核对。', imageText: '旧版分析未单独提供图文画像，请重新提炼。', transfer: '旧版候选写法需要按可迁移风格重新核对。' },
    traits: previous.traits.map(({ evidence, imageIds, ...trait }) => ({ ...trait, mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: evidence, imageIds }] })),
    imageAnalyses: previous.imageAnalyses.map(image => ({ ...image, referenceId: 'primary' })), differences: [], cautions: previous.cautions,
  };
  return { input: styleLearningRequestSchema.parse(input), legacy: true };
}
export function analysisForLegacyPage(analysis: StyleAnalysis) {
  return legacyStyleAnalysisSchema.parse({
    name: analysis.name, summary: analysis.summary,
    traits: analysis.traits.map(trait => ({
      scope: trait.scope, label: trait.label,
      observation: `候选特点，需你认可。${trait.mode === 'flexible' ? '随素材调整。' : '建议保持。'}${trait.observation}`,
      evidence: trait.evidence[0].quote, imageIds: trait.evidence[0].imageIds,
      rule: `${trait.mode === 'flexible' ? '随素材调整：' : ''}${trait.rule}`,
    })),
    imageAnalyses: analysis.imageAnalyses.map(({ imageId, visibleText, visualDescription, captionAnalysis, role, limitations }) => ({ imageId, visibleText, visualDescription, captionAnalysis, role, limitations })),
    cautions: ['当前为旧版页面，已兼容本次拆解。要使用独立标题和多篇风格画像，请先保留未保存内容，再刷新页面。', ...analysis.cautions],
  });
}

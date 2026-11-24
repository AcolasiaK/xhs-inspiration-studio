import { z } from 'zod';
import { outputTokenLimitSchema } from '../ai-config';
import { emptyRuleContent, ruleContentSchema, type RuleContent, type RuleSection } from './style-rules';
import { retainLearnedVoice } from './style-learning-fidelity';

export const MAX_REFERENCE_IMAGES = 20;
export const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_STYLE_REFERENCES = 12;
export const referenceImageSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  dataUrl: z.string().max(3_000_000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  caption: z.string().trim().max(2000).default(''),
}).strict();
export type StyleReferenceImage = z.infer<typeof referenceImageSchema>;
export const referenceImagesSchema = z.array(referenceImageSchema).max(MAX_REFERENCE_IMAGES)
  .refine(images => new Set(images.map(i => i.id)).size === images.length, '图片编号不能重复。')
  .refine(images => images.reduce((sum, i) => sum + i.dataUrl.length, 0) <= MAX_REFERENCE_IMAGE_BYTES, '参考图片总量过大。');
export const learningScopes = ['overall', 'title', 'body', 'captions', 'avoid'] as const;
export const styleReferenceSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), title: z.string().trim().max(300),
  text: z.string().trim().max(12000), images: referenceImagesSchema,
  url: z.string().max(1000).default(''),
}).strict().refine(r => r.title.length >= 2 || r.text.length >= 20 || r.images.length > 0, '每篇参考请提供标题、至少 20 字正文或图片。');
export type StyleReference = z.infer<typeof styleReferenceSchema>;
export const styleLearningReferencesSchema = z.array(styleReferenceSchema).min(1).max(MAX_STYLE_REFERENCES).superRefine((refs, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(refs.map(r => r.id)).size !== refs.length) error('参考编号不能重复。');
  if (refs.reduce((n, r) => n + r.images.length, 0) > MAX_REFERENCE_IMAGES) error(`本轮参考图片合计最多 ${MAX_REFERENCE_IMAGES} 张，可先移除不需要分析的图片。`);
  if (refs.reduce((n, r) => n + r.images.reduce((size, i) => size + i.dataUrl.length, 0), 0) > MAX_REFERENCE_IMAGE_BYTES) error('参考图片总量过大，请分批提供。');
  if (refs.reduce((n, r) => n + r.text.length + r.title.length, 0) > 48000) error('参考文字合计最多 48000 字，请精简后再试。');
  const urls = refs.filter(r => r.url).map(r => r.url);
  const samples = refs.map(r => JSON.stringify([r.title.replace(/\s/g, ''), r.text.replace(/\s/g, ''), r.images.map(i => i.dataUrl)]));
  if (new Set(samples).size !== samples.length) error('同一篇参考请只保留一份，重复内容不能作为多篇共性依据。');
  const bodies = refs.filter(r => r.text.length >= 20).map(r => r.text.replace(/\s/g, ''));
  if (new Set(urls).size !== urls.length || new Set(bodies).size !== bodies.length) error('同一篇参考请只保留一份，重复内容不能作为多篇共性依据。');
});
export const styleAnalysisSchema = z.object({
  name: z.string().trim().min(1).max(60),
  summary: z.string().trim().min(1).max(600),
  portrait: z.object({
    temperament: z.string().trim().min(1).max(700),
    titles: z.object({ available: z.boolean(), expression: z.string().max(400), language: z.string().max(400), appeal: z.string().max(400), relation: z.string().max(400) }).strict(),
    body: z.string().trim().min(1).max(700), captions: z.string().trim().min(1).max(700),
    imageText: z.string().trim().min(1).max(700), transfer: z.string().trim().min(1).max(700),
  }).strict(),
  traits: z.array(z.object({
    scope: z.enum(learningScopes), label: z.string().trim().min(1).max(40),
    observation: z.string().trim().min(1).max(500),
    mode: z.enum(['core', 'flexible']), support: z.enum(['candidate', 'recurring']),
    evidence: z.array(z.object({ referenceId: z.string().min(1).max(80), quote: z.string().trim().min(1).max(160), imageIds: z.array(z.string().min(1).max(80)).max(MAX_REFERENCE_IMAGES) }).strict()).min(1).max(MAX_STYLE_REFERENCES),
    rule: z.string().trim().min(1).max(700),
  }).strict()).min(1).max(16),
  differences: z.array(z.object({ aspect: z.string().min(1).max(80), referenceIds: z.array(z.string().min(1).max(80)).min(2).max(MAX_STYLE_REFERENCES), description: z.string().min(1).max(500), suggestion: z.string().min(1).max(500) }).strict()).max(6),
  imageAnalyses: z.array(z.object({
    referenceId: z.string().min(1).max(80),
    imageId: z.string().min(1).max(80),
    visibleText: z.string().max(2000),
    visualDescription: z.string().trim().min(1).max(500),
    captionAnalysis: z.string().trim().min(1).max(700),
    role: z.string().trim().min(1).max(300),
    limitations: z.string().max(300),
  }).strict()).max(MAX_REFERENCE_IMAGES),
  cautions: z.array(z.string().min(1).max(300)).max(5),
}).strict();
export type StyleAnalysis = z.infer<typeof styleAnalysisSchema>;
export const styleLearningRequestSchema = z.object({
  references: styleLearningReferencesSchema,
  preferences: z.string().trim().max(2000).default(''),
  previous: styleAnalysisSchema.optional(),
  maxOutputTokens: outputTokenLimitSchema.optional(),
}).strict();
export type StyleLearningRequest = z.infer<typeof styleLearningRequestSchema>;
export const styleLearningRecoverySchema = z.object({
  reason: z.enum(['exhausted', 'unsupported']), limit: outputTokenLimitSchema, suggestedTokens: outputTokenLimitSchema,
  partial: z.array(z.object({ label: z.string().min(1).max(30), text: z.string().min(1).max(700) }).strict()).max(12),
}).strict();
export type StyleLearningRecovery = z.infer<typeof styleLearningRecoverySchema>;

/** Field-specific errors are shared by the form and both API request versions. */
export function styleLearningInputError(error: z.ZodError): string {
  const issue = error.issues.find(i => i.code === 'custom') ?? error.issues[0];
  if (issue.code === 'custom') return issue.message;
  const path = issue.path;
  const reference = path[0] === 'references' && typeof path[1] === 'number' ? `参考 ${path[1] + 1}的` : '';
  const field = String(path.at(-1));
  if (field === 'maxOutputTokens') return '本次输出上限请填写不小于 256 的整数。';
  const labels: Record<string, string> = { title: '标题', text: '正文', referenceText: '参考文案', preferences: '补充要求', caption: '图片文字补充', images: '图片', referenceImages: '参考图片', references: '参考笔记', url: '来源链接' };
  if (path[0] === 'previous') return '上次分析格式不兼容，请先保留未保存内容，再刷新页面重新分析。';
  if (issue.code === 'too_big' && labels[field]) {
    const unit = ['images', 'referenceImages'].includes(field) ? '张' : field === 'references' ? '篇' : '字';
    return `${reference}${labels[field]}最多 ${issue.maximum} ${unit}，请精简后重试。`;
  }
  if (field === 'dataUrl' || field === 'id') return `${reference}图片或参考编号格式无效，请重新读取或上传。`;
  if (issue.code === 'unrecognized_keys' || path.length === 0 || field === 'references') return '提交格式与页面版本不一致，请先保留未保存内容，再刷新页面重试。';
  return `${reference}${labels[field] ?? '参考内容'}格式不正确，请检查后重试。`;
}

export function defaultLearnedSelection(analysis: StyleAnalysis) {
  return analysis.traits.flatMap((trait, index) => trait.support === 'recurring' ? [index] : []);
}

/** Only the user's explicitly selected rules cross into the writing library. */
export function compileLearnedRules(analysis: StyleAnalysis, selected: number[], base?: RuleContent, references?: StyleReference[]): RuleContent {
  const content = structuredClone(base ?? emptyRuleContent(analysis.name));
  const indices = [...new Set(selected)].filter(i => Number.isInteger(i) && i >= 0 && i < analysis.traits.length);
  if (!indices.length) throw new Error('请至少选择一项喜欢的写法。');
  const additions = new Map<RuleSection, string[]>();
  for (const index of indices) {
    const trait = analysis.traits[index];
    if (!trait.rule.trim()) throw new Error('请填写所选写法对应的规则。');
    const rule = `${trait.mode === 'flexible' ? '随素材调整：' : ''}${trait.rule.trim()}`;
    const lines = additions.get(trait.scope) ?? [];
    if (!lines.includes(rule) && !content.sections[trait.scope].split('\n').map(s => s.replace(/^[-•]\s*/, '').trim()).includes(rule)) lines.push(rule);
    additions.set(trait.scope, lines);
  }
  for (const [scope, lines] of additions) {
    if (lines.length) content.sections[scope] = [content.sections[scope].trim(), ...lines.map(s => `- ${s}`)].filter(Boolean).join('\n');
  }
  retainLearnedVoice(content, analysis, indices, references);
  const parsed = ruleContentSchema.safeParse(content);
  if (!parsed.success) throw new Error('补充后的规则超过长度限制，请减少所选写法，或保存为新风格。');
  return parsed.data;
}

/** Reject copied instructions in executable rules; evidence remains a short, visible quote. */
export function validateStyleAnalysis(value: unknown, references: StyleReference[]): StyleAnalysis {
  const result = styleAnalysisSchema.parse(value);
  const normalize = (s: string) => s.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  const referenceMap = new Map(references.map(r => [r.id, r]));
  const imageMap = new Map<string, StyleReferenceImage>(references.flatMap(r => r.images.map(i => [`${r.id}/${i.id}`, i] as const)));
  const analyzed = new Map(result.imageAnalyses.map(i => [`${i.referenceId}/${i.imageId}`, i]));
  if (analyzed.size !== result.imageAnalyses.length || analyzed.size !== imageMap.size || [...analyzed.keys()].some(id => !imageMap.has(id))) throw new Error('逐图拆解必须与提供的图片一一对应。');
  result.imageAnalyses = [...imageMap.keys()].map(key => analyzed.get(key)!);
  const hasTitles = references.some(r => r.title.length > 0);
  if (result.portrait.titles.available !== hasTitles || (hasTitles && !result.traits.some(t => t.scope === 'title'))) throw new Error('已提供的标题必须单独提炼；缺少标题时不能虚构。');
  if (!hasTitles && Object.entries(result.portrait.titles).some(([key, value]) => key !== 'available' && String(value).trim())) throw new Error('缺少标题时不能虚构标题风格。');
  if (hasTitles && Object.entries(result.portrait.titles).some(([key, value]) => key !== 'available' && !String(value).trim())) throw new Error('标题风格提炼不完整。');
  for (const difference of result.differences) {
    if (new Set(difference.referenceIds).size < 2 || difference.referenceIds.some(id => !referenceMap.has(id))) throw new Error('参考差异必须对应至少两篇实际参考。');
  }
  const source = normalize([...references.flatMap(r => [r.title, r.text]), ...[...imageMap.values()].map(i => i.caption), ...result.imageAnalyses.flatMap(i => [i.visibleText, i.visualDescription])].join('\n'));
  for (const trait of result.traits) {
    if (trait.support === 'recurring' && new Set(trait.evidence.map(e => e.referenceId)).size < 2) trait.support = 'candidate';
    if (trait.scope === 'captions' && !trait.evidence.some(e => e.imageIds.length)) throw new Error('逐图配文规则需要明确参考图片。');
    for (const evidence of trait.evidence) {
      const ref = referenceMap.get(evidence.referenceId);
      if (!ref) throw new Error('分析依据没有对应到参考笔记。');
      const keys = evidence.imageIds.map(id => `${ref.id}/${id}`);
      if (keys.some(key => !imageMap.has(key)) || new Set(keys).size !== keys.length) throw new Error('图片依据没有对应到这篇参考图。');
      if (trait.scope === 'title' && (!ref.title || keys.length)) throw new Error('标题规则须来自实际提供的笔记标题。');
      const evidenceSource = normalize(keys.length ? keys.map(key => [imageMap.get(key)!.caption, analyzed.get(key)!.visibleText, analyzed.get(key)!.visualDescription].join('\n')).join('\n') : trait.scope === 'title' ? ref.title : `${ref.title}\n${ref.text}`);
      const quote = normalize(evidence.quote);
      if (quote.length < 2 || !evidenceSource.includes(quote)) throw new Error('分析依据没有对应到参考原文或图片观察。');
    }
    const rule = Array.from(normalize(trait.rule));
    for (let i = 0; i + 24 <= rule.length; i++) {
      if (source.includes(rule.slice(i, i + 24).join(''))) throw new Error('规则包含过长原文，应提炼写法后再试。');
    }
  }
  return result;
}

export function normalizeXhsReferenceLink(text: string): string {
  // Some editors escape the URL scheme when copying a whole share message.
  const shareText = text.replace(/\b(https?)\\?:\\?\/\\?\//gi, '$1://');
  const matches = shareText.match(/https?:\/\/[^\s<>"，。；！）)]+/gi);
  if (!matches || matches.length !== 1) throw new Error('请提供一条小红书笔记链接，可直接粘贴分享文字。');
  const url = new URL(matches[0]);
  if (url.username || url.password || url.port || url.hash) throw new Error('这条链接格式不受支持，请重新复制笔记分享链接。');
  const long = ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname);
  const short = ['xhslink.com', 'xhslink.cn'].includes(url.hostname);
  if ((!long && !short) || (long && !/^\/(?:explore|discovery\/item)\/[a-f0-9]{24}\/?$/.test(url.pathname)) || (short && !/^\/(?:[ao]\/)?[A-Za-z0-9]+\/?$/.test(url.pathname))) {
    throw new Error('只支持小红书笔记链接或 xhslink 分享短链。');
  }
  url.protocol = 'https:';
  if (long) url.hostname = 'www.xiaohongshu.com';
  return url.toString();
}

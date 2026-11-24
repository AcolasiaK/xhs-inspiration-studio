import { z } from 'zod';
import { ruleContentSchema, ruleSections, styleIdSchema, type RuleContent } from './style-rules';
import { learningResolutionsSchema, learningScopeSchema, learningSelectionSchema, styleLearningRoundSchema, type LearningResolutions, type LearningSelection, type StyleLearningRound } from './style-learning-memory';
import type { StyleAnalysis, StyleReference } from './style-learning';

export const styleIntegrationTargetSchema = z.object({ styleId: styleIdSchema, revision: z.number().int().nonnegative(), versionId: z.string().min(1).max(100) }).strict();
export type StyleIntegrationTarget = z.infer<typeof styleIntegrationTargetSchema>;
const sectionsSchema = z.object({ overall: z.string().max(3000), title: z.string().max(3000), body: z.string().max(6000), captions: z.string().max(6000), avoid: z.string().max(3000) }).strict();
export const styleIntegrationProposalSchema = z.object({
  summary: z.string().trim().min(1).max(1000), sections: sectionsSchema,
  changes: z.array(z.object({ scope: learningScopeSchema, kind: z.enum(['keep', 'revise', 'merge', 'add', 'remove']), before: z.string().max(6000), after: z.string().max(6000), reason: z.string().trim().min(1).max(700), sourceIds: z.array(z.string().min(1).max(100)) }).strict()).min(1).max(40),
  conflicts: z.array(z.object({ id: z.string().min(1).max(80), scope: learningScopeSchema, question: z.string().trim().min(1).max(600), reason: z.string().min(1).max(700), options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(1).max(100), text: z.string().max(6000) }).strict()).min(2).max(4) }).strict()).max(5),
  cautions: z.array(z.string().min(1).max(500)).max(8),
}).strict();
export type StyleIntegrationProposal = z.infer<typeof styleIntegrationProposalSchema>;
export const styleIntegrationSnapshotSchema = z.object({
  target: styleIntegrationTargetSchema, sourceJobId: z.string().uuid(), selection: learningSelectionSchema,
  baseline: ruleContentSchema, historySourceCount: z.number().int().nonnegative(), proposal: styleIntegrationProposalSchema.optional(),
}).strict();
export type StyleIntegrationSnapshot = z.infer<typeof styleIntegrationSnapshotSchema>;
const integrationSourceImageSchema = z.object({ id: z.string().max(80), caption: z.string().max(2000), visibleText: z.string().max(2000), visualDescription: z.string().max(500), captionAnalysis: z.string().max(700), role: z.string().max(300), limitations: z.string().max(300) }).strict();
export const integrationSourceSchema = z.object({
  id: z.string().min(1).max(100), fingerprint: z.string().min(1).max(128), jobIds: z.array(z.string().uuid()),
  title: z.string().max(300), text: z.string().max(12000), url: z.string().max(1000),
  images: z.array(integrationSourceImageSchema),
  observationVariants: z.array(integrationSourceImageSchema).optional(),
}).strict();
export type IntegrationSource = z.infer<typeof integrationSourceSchema>;
export type LearningTextReference = Omit<StyleReference, 'images'> & { images: { id: string; caption: string }[] };
export type StyleIntegrationContext = {
  target: StyleIntegrationTarget; baseline: RuleContent; sourceJobId: string; selection: LearningSelection;
  current: { references: LearningTextReference[]; analysis: StyleAnalysis; preferences: string };
  sources: IntegrationSource[]; currentReferenceMap: Record<string, string>;
  history: StyleLearningRound[]; sourceJobIds: string[];
};
export const integrationContextParts = { target: styleIntegrationTargetSchema, selection: learningSelectionSchema, source: integrationSourceSchema, round: styleLearningRoundSchema };
export const adoptStyleLearningSchema = z.object({
  adoptionId: z.string().uuid(), content: ruleContentSchema, selection: learningSelectionSchema.optional(), resolutions: learningResolutionsSchema.default([]),
}).strict();

/** Resolve whole-column alternatives. No substring replacement can remove unrelated rules. */
export function resolvedIntegrationSections(proposal: StyleIntegrationProposal, resolutions: LearningResolutions, requireComplete = true) {
  const choices = learningResolutionsSchema.parse(resolutions), sections = { ...proposal.sections };
  if (new Set(proposal.conflicts.map(c => c.id)).size !== proposal.conflicts.length || new Set(proposal.conflicts.map(c => c.scope)).size !== proposal.conflicts.length) throw new Error('综合结果的冲突编号或栏目重复，请重新综合。');
  for (const choice of choices) if (!proposal.conflicts.some(c => c.id === choice.conflictId)) throw new Error('冲突选择与当前综合结果不一致。');
  for (const conflict of proposal.conflicts) {
    const choice = choices.find(c => c.conflictId === conflict.id);
    if (!choice) { if (requireComplete) throw new Error(`请先选择「${ruleSections[conflict.scope]}」冲突的处理方式。`); continue; }
    const option = conflict.options.find(o => o.id === choice.optionId);
    if (!option) throw new Error('冲突选项已变化，请重新选择。');
    sections[conflict.scope] = option.text;
  }
  return sectionsSchema.parse(sections);
}

/** Examples are verified source excerpts supplied by the normal compiler, never model-written quotes. */
export function compileIntegratedRules(proposal: StyleIntegrationProposal, base: RuleContent, learned: RuleContent, resolutions: LearningResolutions, requireComplete = true): RuleContent {
  const sections = resolvedIntegrationSections(proposal, resolutions, requireComplete);
  const keptScopes = new Set(proposal.conflicts.filter(conflict => resolutions.some(choice => choice.conflictId === conflict.id && choice.optionId === 'keep_previous')).map(conflict => conflict.scope));
  const examples = [...base.examples];
  for (const example of learned.examples) {
    if (keptScopes.has(example.scope)) continue;
    if (examples.length >= 8) break;
    if (!examples.some(e => e.scope === example.scope && e.output === example.output)) examples.push(example);
  }
  return ruleContentSchema.parse({ name: base.name, sections, examples });
}

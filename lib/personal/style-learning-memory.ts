import { z } from 'zod';

export const learningScopeSchema = z.enum(['overall', 'title', 'body', 'captions', 'avoid']);
export const learningSelectionSchema = z.array(z.object({ index: z.number().int().min(0), rule: z.string().trim().min(1).max(700) }).strict()).min(1).max(16)
  .refine(items => new Set(items.map(item => item.index)).size === items.length, '所选写法不能重复。');
export type LearningSelection = z.infer<typeof learningSelectionSchema>;
const rememberedTraitSchema = z.object({ scope: learningScopeSchema, label: z.string().max(40), rule: z.string().max(700), evidence: z.array(z.object({ sourceId: z.string().min(1).max(100), quote: z.string().min(1).max(160) }).strict()).optional() }).strict();
export const learningResolutionsSchema = z.array(z.object({ conflictId: z.string().min(1).max(80), optionId: z.string().min(1).max(80) }).strict()).max(5)
  .refine(items => new Set(items.map(item => item.conflictId)).size === items.length, '每项冲突只能选择一个处理方式。');
export type LearningResolutions = z.infer<typeof learningResolutionsSchema>;
export const styleLearningRoundSchema = z.object({
  jobId: z.string().uuid(), preferences: z.string().max(2000),
  selected: z.array(rememberedTraitSchema).max(16),
  notAdopted: z.array(rememberedTraitSchema).max(16),
  conflictChoices: z.array(z.object({ scope: learningScopeSchema, question: z.string().max(600), choice: z.string().max(100), text: z.string().max(6000) }).strict()).max(5),
}).strict();
export type StyleLearningRound = z.infer<typeof styleLearningRoundSchema>;
/** Learning provenance stays outside generation snapshots and does not authorize activation. */
export const styleLearningReviewSchema = z.object({
  adoptionId: z.string().uuid(), payloadHash: z.string().min(1).max(128), jobId: z.string().uuid(),
  sourceJobIds: z.array(z.string().uuid()), rounds: z.array(styleLearningRoundSchema),
}).strict();
export type StyleLearningReview = z.infer<typeof styleLearningReviewSchema>;

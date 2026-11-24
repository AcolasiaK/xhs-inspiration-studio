import { z } from 'zod';
import { outputTokenLimitSchema } from '../ai-config';
import { styleAnalysisSchema, styleLearningRecoverySchema, styleLearningRequestSchema, type StyleLearningRequest } from './style-learning';
import { styleIntegrationSnapshotSchema, styleIntegrationTargetSchema } from './style-integration';
import { learningSelectionSchema } from './style-learning-memory';

export const STYLE_IMAGE_BATCH_SIZE = 2;
export const DEFAULT_STYLE_STEP_TIMEOUT = 600;
// This is a per-step wait chosen for a local background task, not a global AI setting.
export const styleJobSettingsSchema = z.object({
  timeoutSeconds: z.number().int().min(10).max(86400).default(DEFAULT_STYLE_STEP_TIMEOUT),
  maxOutputTokens: outputTokenLimitSchema.optional(),
}).strict();
export type StyleJobSettings = z.infer<typeof styleJobSettingsSchema>;
export const styleJobIdSchema = z.string().uuid();
export const startStyleJobSchema = z.object({ id: styleJobIdSchema, input: styleLearningRequestSchema, settings: styleJobSettingsSchema }).strict();
export const startStyleIntegrationSchema = z.object({ id: styleJobIdSchema, sourceJobId: styleJobIdSchema, target: styleIntegrationTargetSchema, selection: learningSelectionSchema, settings: styleJobSettingsSchema }).strict();
export type StartStyleIntegration = z.infer<typeof startStyleIntegrationSchema>;
export const styleJobActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('resume'), settings: styleJobSettingsSchema }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
]);
export const styleJobSnapshotSchema = z.object({
  id: styleJobIdSchema, status: z.enum(['running', 'paused', 'failed', 'completed']),
  createdAt: z.string(), updatedAt: z.string(), completedSteps: z.number().int().min(0), totalSteps: z.number().int().min(1),
  stageLabel: z.string(), settings: styleJobSettingsSchema,
  profile: z.object({ id: z.string(), revision: z.string(), name: z.string() }).strict(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  recovery: styleLearningRecoverySchema.optional(), analysis: styleAnalysisSchema.optional(),
  integration: styleIntegrationSnapshotSchema.optional(),
}).strict();
export type StyleJobSnapshot = z.infer<typeof styleJobSnapshotSchema>;
export type StyleImageKey = { referenceId: string; imageId: string };
export function styleImageBatches(input: Pick<StyleLearningRequest, 'references'>): StyleImageKey[][] {
  const keys = input.references.flatMap(r => r.images.map(i => ({ referenceId: r.id, imageId: i.id })));
  const batches: StyleImageKey[][] = [];
  for (let i = 0; i < keys.length; i += STYLE_IMAGE_BATCH_SIZE) batches.push(keys.slice(i, i + STYLE_IMAGE_BATCH_SIZE));
  return batches;
}

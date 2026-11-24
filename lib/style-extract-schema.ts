import { z } from "zod";
import { REFERENCE_ASPECTS } from "./schema";
import { TONES } from "./constants";

export const styleExtractRequestSchema = z.object({
  referenceText: z.string().trim().min(1, "请先粘贴参考文案。").max(6000),
  referenceAspects: z.array(z.enum(REFERENCE_ASPECTS)).max(5).refine((items) => new Set(items).size === items.length).default([]),
});
export type StyleExtractRequest = z.infer<typeof styleExtractRequestSchema>;
export const styleExtractModelSchema = z.object({
  tone: z.enum(TONES), length: z.enum(["short", "medium", "long"]), emoji: z.boolean(), styleNotes: z.string(),
});

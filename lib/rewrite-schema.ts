import { z } from "zod";
import { requestSchema } from "./schema";
import { travelResearchSchema } from "./travel-research";

export const rewriteDirectionSchema = z.enum(["natural", "concise", "appealing", "detailed", "custom"]);
export type RewriteDirection = z.infer<typeof rewriteDirectionSchema>;
export const rewriteRequestSchema = requestSchema.safeExtend({
  mode: z.literal("live"),
  body: z.string().trim().min(1).max(8000),
  direction: rewriteDirectionSchema,
  instruction: z.string().trim().max(500),
  research: travelResearchSchema.optional(),
});

export const rewriteResultSchema = z.object({ body: z.string() });

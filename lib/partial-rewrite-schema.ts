import { z } from "zod";
import { MAX_IMAGES } from "./constants";
import { requestSchema } from "./schema";
import { rewriteDirectionSchema } from "./rewrite-schema";
import { analyzeHashtags } from "./format";
import { travelResearchSchema } from "./travel-research";

export const partialTargetSchema = z.enum(["title_one", "titles_all", "caption_one", "captions_all", "tag_one", "tags_all"]);
export type PartialTarget = z.infer<typeof partialTargetSchema>;
const caption = z.object({ imageId: z.string().uuid(), headline: z.string().max(150), description: z.string().max(700) });
// Existing results may have been edited or contain an incomplete legacy tag list.
export const partialCurrentSchema = z.object({
  titles: z.array(z.string().max(150)).length(5),
  coverCopy: z.object({ headline: z.string().max(150), subline: z.string().max(250) }),
  imageCaptions: z.array(caption).min(1).max(MAX_IMAGES),
  body: z.string().max(8000), hashtags: z.array(z.string().max(800)).max(12), warnings: z.array(z.string().max(500)).max(22),
});
export const partialRewriteRequestSchema = requestSchema.safeExtend({
  mode: z.literal("live"), target: partialTargetSchema,
  targetIndex: z.number().int().nonnegative().optional(), targetImageId: z.string().uuid().optional(),
  direction: rewriteDirectionSchema, instruction: z.string().trim().max(500), current: partialCurrentSchema,
  research: travelResearchSchema.optional(),
}).superRefine((input, ctx) => {
  const ids = input.current.imageCaptions.map((item) => item.imageId);
  if (JSON.stringify(ids) !== JSON.stringify(input.imageIds)) ctx.addIssue({ code: "custom", message: "配文与图片快照不一致" });
  if (input.target === "title_one" && (input.targetIndex === undefined || input.targetIndex >= input.current.titles.length)) ctx.addIssue({ code: "custom", message: "标题位置无效" });
  if (input.target === "caption_one" && (!input.targetImageId || !input.imageIds.includes(input.targetImageId))) ctx.addIssue({ code: "custom", message: "图片不存在" });
  if (input.target === "tag_one") {
    const tags = analyzeHashtags(input.current.hashtags);
    if (!tags.valid || tags.duplicateCount || input.targetIndex === undefined || input.targetIndex >= tags.tags.length) ctx.addIssue({ code: "custom", message: "请先整理为 10 个不重复的有效话题，再重写单个话题。" });
  }
});
export type PartialRewriteRequest = z.infer<typeof partialRewriteRequestSchema>;
// Arrays are always required by the strict structured-output schema. Unused arrays are ignored.
export const partialModelResultSchema = z.object({
  titles: z.array(z.string()),
  imageCaptions: z.array(z.object({ imageId: z.string(), headline: z.string(), description: z.string() })),
  hashtags: z.array(z.string()),
});
export type PartialRewriteResult = z.infer<typeof partialModelResultSchema>;

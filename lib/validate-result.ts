import { XHS_TITLE_RULE } from "./xhs-title";
import { resultSchema, type Brief, type ContentResult } from "./schema";
import { analyzeHashtags, formatAll, formatGeneratedParagraphs, splitTerms } from "./format";
import { AppError } from "./errors";
import { LENGTH_RANGES, MAX_IMAGES } from "./constants";
import { z } from "zod";
import { captionConstraints } from "./personal/style-rules";

export function validateResult(value: unknown, imageIds: string[], brief?: Brief, writingStyle = brief?.writingStyle): ContentResult {
  const schema = writingStyle ? resultSchema.extend({ imageCaptions: z.array(z.object({
    imageId: z.string().uuid(), headline: z.literal(""), description: z.string().trim().min(1).max(500),
  })).min(1).max(MAX_IMAGES) }) : resultSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success && parsed.error.issues.some(issue=>issue.message===XHS_TITLE_RULE)) throw new AppError("CONSTRAINT_FAILED", XHS_TITLE_RULE, 422);
  if (!parsed.success) throw new AppError("INVALID_RESULT", "生成内容不完整，请重试。你之前的内容已保留。", 502);
  const result = parsed.data;
  if (writingStyle && result.imageCaptions.some(caption => caption.description.split(/\r?\n/u).filter(line => line.trim()).length < captionConstraints(writingStyle).minLines)) {
    throw new AppError("INVALID_RESULT", "逐图配文未符合所选写作风格，已有内容保留，请重试。", 502);
  }
  result.body = formatGeneratedParagraphs(result.body);
  const returnedIds = result.imageCaptions.map((caption) => caption.imageId);
  if (returnedIds.length !== imageIds.length || new Set(returnedIds).size !== imageIds.length || returnedIds.some((id) => !imageIds.includes(id))) {
    throw new AppError("IMAGE_MISMATCH", "图片与配文没有正确对应，请重新生成。", 502);
  }
  result.imageCaptions.sort((a, b) => imageIds.indexOf(a.imageId) - imageIds.indexOf(b.imageId));
  const hashtags = analyzeHashtags(result.hashtags);
  if (!hashtags.valid) throw new AppError("HASHTAG_COUNT", `生成的话题未达到 10 个有效且不重复的标签（当前 ${hashtags.count} 个），请重试。已有内容已保留。`, 502);
  result.hashtags = hashtags.tags;
  if (brief) {
    if (brief.writingStyle ? brief.writingStyle.baseStyle === "china" : brief.creationTypes?.includes("china")) {
      const publishLength = Array.from(`${result.body}\n\n${result.hashtags.join(" ")}`).length;
      if (publishLength > 1000) throw new AppError("CONSTRAINT_FAILED", "环游中国正文和话题合计不超过 1000 字符；请重试。已有内容已保留。", 422);
    }
    if (result.warnings.length > 20) throw new AppError("INVALID_RESULT", "生成的提示过多，请缩短要求后重试。", 502);
    const text = formatAll(result);
    const forbidden = splitTerms(brief.forbidden).find((word) => text.includes(word));
    if (forbidden) throw new AppError("CONSTRAINT_FAILED", `结果包含禁用词“${forbidden}”，请重新生成或调整要求。`, 422);
    if (!brief.emoji && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(text)) {
      throw new AppError("CONSTRAINT_FAILED", "结果未遵守不使用 Emoji 的要求，请重新生成。", 422);
    }
    const missing = splitTerms(brief.mustInclude).filter((word) => !text.includes(word));
    if (missing.length) {
      const terms = missing.join("、");
      result.warnings.push(`请确认必提内容是否已表达：${terms.slice(0, 440)}${terms.length > 440 ? "…（请对照输入检查全部必提内容）" : ""}。`);
    }
    const characters = Array.from(result.body.replace(/\s/gu, "")).length;
    const [min, max] = LENGTH_RANGES[brief.length];
    if (characters < min || characters > max) result.warnings.push(`正文约 ${characters} 字符（不计空白），偏离所选 ${min}–${max} 字目标；请编辑或重新生成。`);
  }
  return result;
}

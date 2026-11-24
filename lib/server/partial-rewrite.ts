import { isTitleWithinLimit, XHS_TITLE_RULE } from "../xhs-title";
import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { AppError } from "../errors";
import { analyzeHashtags, splitTerms } from "../format";
import { partialModelResultSchema, type PartialRewriteRequest, type PartialRewriteResult } from "../partial-rewrite-schema";
import { buildPartialRewritePrompt, PARTIAL_REWRITE_SYSTEM_PROMPT } from "../partial-rewrite-prompt";
import { providerError } from "./provider-errors";
import { createProvider } from "./ai/provider";
import type { AiSource } from "./ai-source";
import { bindWritingStyle } from "./personal-style-store";
import { captionConstraints } from "../personal/style-rules";

const failure = () => new AppError("INVALID_RESULT", "AI 返回的重写结果不完整或不符合要求，原内容仍保留。请调整要求后重试。", 502);
const key = (text: string) => text.normalize("NFKC").trim().toLocaleLowerCase("und");

/** Business validation is deliberately separate from the structured-output schema. */
export function validatePartialResult(input: PartialRewriteRequest, candidate: PartialRewriteResult): PartialRewriteResult {
  const out: PartialRewriteResult = { titles: [], imageCaptions: [], hashtags: [] };
  if (input.target === "title_one" || input.target === "titles_all") {
    const expected = input.target === "title_one" ? 3 : 5;
    const titles = candidate.titles.map((value) => value.trim());
    if (titles.length !== expected || titles.some((value) => !value || /[\r\n]/u.test(value)) || new Set(titles.map(key)).size !== expected) throw failure();
    if (titles.some(title => !isTitleWithinLimit(title))) throw new AppError("CONSTRAINT_FAILED", XHS_TITLE_RULE, 422);
    // “新标题”不得原样复用已有标题，大小写和全角等价字符也视为重复。
    const existing = new Set(input.current.titles.map(key));
    if (titles.some((value) => existing.has(key(value)))) throw failure();
    out.titles = titles;
  } else if (input.target === "caption_one" || input.target === "captions_all") {
    const expected = input.target === "caption_one" ? [input.targetImageId!] : input.imageIds;
    const byId = new Map(candidate.imageCaptions.map((caption) => [caption.imageId, caption]));
    if (candidate.imageCaptions.length !== expected.length || byId.size !== expected.length || expected.some((id) => !byId.has(id))) throw failure();
    out.imageCaptions = expected.map((id) => {
      const caption = byId.get(id)!;
      const headline = caption.headline.trim(), description = caption.description.trim();
      const managed = input.brief.writingStyle;
      if ((managed ? Boolean(headline) : !headline) || headline.length > 100 || !description || description.length > 500 || description.split(/\r?\n/u).filter(line => line.trim()).length < (managed ? captionConstraints(managed).minLines : 2)) throw failure();
      const previous = input.current.imageCaptions.find((item) => item.imageId === id);
      if (previous && key(previous.headline) === key(headline) && key(previous.description) === key(description)) throw failure();
      return { imageId: id, headline, description };
    });
  } else {
    const expected = input.target === "tag_one" ? 3 : 10;
    if (candidate.hashtags.length !== expected) throw failure();
    const canonical = candidate.hashtags.map((raw) => {
      const parsed = analyzeHashtags([raw]);
      if (parsed.count !== 1 || parsed.invalidCount || parsed.duplicateCount || /\s/u.test(raw.trim())) throw failure();
      return parsed.tags[0];
    });
    if (new Set(canonical.map(key)).size !== expected) throw failure();
    if (input.target === "tag_one") {
      const existing = new Set(analyzeHashtags(input.current.hashtags).tags.map(key));
      if (canonical.some((tag) => existing.has(key(tag)))) throw failure();
    } else {
      const existing = new Set(analyzeHashtags(input.current.hashtags).tags.map(key));
      if (existing.size === expected && canonical.every((tag) => existing.has(key(tag)))) throw failure();
    }
    out.hashtags = canonical;
  }
  const texts = [...out.titles, ...out.imageCaptions.flatMap((item) => [item.headline, item.description]), ...out.hashtags];
  if (input.research?.sources.some(source => texts.some(text => text.includes(source.url)))) throw new AppError("INVALID_RESULT", "重写结果混入参考链接，原内容仍保留，请重试。", 502);
  if (splitTerms(input.brief.forbidden).some((term) => texts.some((text) => text.includes(term)))) {
    throw new AppError("CONSTRAINT_FAILED", "重写结果包含禁用词，原内容仍保留。请调整要求后重试。", 422);
  }
  if (!input.brief.emoji && texts.some((text) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(text))) {
    throw new AppError("CONSTRAINT_FAILED", "重写结果包含不允许的 Emoji，原内容仍保留。请重试。", 422);
  }
  return out;
}

export async function partialRewrite(input: PartialRewriteRequest, images: { id: string; dataUrl: string }[], signal: AbortSignal, aiSource: AiSource = "relay"): Promise<PartialRewriteResult> {
  input = { ...input, brief: await bindWritingStyle(input.brief, typeof aiSource === "object" ? aiSource.owner : "local-owner") };
  const client = await createProvider(aiSource);
  const {model,providerName} = client;
  const content: ResponseInputContent[] = [{ type: "input_text", text: buildPartialRewritePrompt(input) }];
  images.forEach((image, index) => {
    content.push({ type: "input_text", text: `图片 ${index + 1}，imageId=${image.id}` });
    content.push({ type: "input_image", image_url: image.dataUrl, detail: "auto" });
  });
  try {
    const response = await client.responses.parse({ model: model, store: false, max_output_tokens: 5000,
      input: [{ role: "system", content: PARTIAL_REWRITE_SYSTEM_PROMPT }, { role: "user", content }],
      text: { format: zodTextFormat(partialModelResultSchema, "xhs_partial_rewrite") },
    }, { signal });
    if (signal.aborted) throw new AppError("CANCELLED", "本次重写已取消，原内容仍然保留。", 499);
    if (response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))) throw new AppError("REFUSAL", "模型无法处理这次重写，请调整要求。原内容仍然保留。", 422);
    if (response.status !== "completed" || !response.output_parsed) throw failure();
    return validatePartialResult(input, response.output_parsed);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerError(error, providerName);
  }
}

import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import type { Brief } from "../schema";
import { rewriteResultSchema, type RewriteDirection } from "../rewrite-schema";
import { REWRITE_SYSTEM_PROMPT, buildRewritePrompt } from "../rewrite-prompt";
import { formatGeneratedParagraphs, splitTerms } from "../format";
import { AppError } from "../errors";
import { providerError } from "./provider-errors";
import type { TravelResearch } from "../travel-research";
import { createProvider } from "./ai/provider";
import type { AiSource } from "./ai-source";
import { bindWritingStyle } from "./personal-style-store";

export async function rewriteBody(brief: Brief, body: string, direction: RewriteDirection, instruction: string, images: { id: string; dataUrl: string }[], signal: AbortSignal, research?: TravelResearch, aiSource: AiSource = "relay") {
  brief = await bindWritingStyle(brief, typeof aiSource === "object" ? aiSource.owner : "local-owner");
  const client = await createProvider(aiSource);
  const {model,providerName} = client;
  const content: ResponseInputContent[] = [{ type: "input_text", text: buildRewritePrompt(brief, body, direction, instruction, research) }];
  images.forEach((image, index) => {
    content.push({ type: "input_text", text: `图片 ${index + 1}，imageId=${image.id}` });
    content.push({ type: "input_image", image_url: image.dataUrl, detail: "auto" });
  });
  try {
    const response = await client.responses.parse({
      model: model, store: false, max_output_tokens: 4000,
      input: [{ role: "system", content: REWRITE_SYSTEM_PROMPT }, { role: "user", content }],
      text: { format: zodTextFormat(rewriteResultSchema, "xhs_rewrite") },
    }, { signal });
    if (signal.aborted) throw new AppError("CANCELLED", "本次重写已取消，原正文仍然保留。", 499);
    if (response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"))) throw new AppError("REFUSAL", "模型无法处理这次重写，请调整要求后重试。原正文仍然保留。", 422);
    const bodyResult = response.output_parsed?.body?.trim();
    if (response.status !== "completed" || !bodyResult || bodyResult.length > 6000) throw new AppError("INCOMPLETE", "重写结果不完整，请重试。原正文仍然保留。", 502);
    if (research?.sources.some(source => bodyResult.includes(source.url))) throw new AppError("INVALID_RESULT", "重写结果混入参考链接，原正文仍保留，请重试。", 502);
    if (splitTerms(brief.forbidden).some((term) => bodyResult.includes(term))) throw new AppError("CONSTRAINT_FAILED", "重写结果包含禁用词，请调整要求或重试。原正文仍然保留。", 422);
    if (!brief.emoji && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(bodyResult)) throw new AppError("CONSTRAINT_FAILED", "重写结果未遵守不使用 Emoji 的要求，请重试。原正文仍然保留。", 422);
    return formatGeneratedParagraphs(bodyResult);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerError(error, providerName);
  }
}

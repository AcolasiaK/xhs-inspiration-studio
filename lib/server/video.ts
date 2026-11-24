import type { AiSource } from "./ai-source";
import "server-only";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { AppError } from "../errors";
import { shotSchema, validateShot, validateVideoPlan, videoPlanSchema, type VideoRequest } from "../video/schema";
import { VIDEO_PROMPT, videoUserPrompt } from "../video/prompt";
import { providerError } from "./provider-errors";
import { createProvider } from "./ai/provider";
import { generationTimeouts } from "./generation-timeouts";
import { bindWritingStyle } from "./personal-style-store";

export async function generateVideo(request: VideoRequest, signal: AbortSignal, aiSource: AiSource = "relay") {
  request = { ...request, input: { ...request.input, brief: await bindWritingStyle(request.input.brief, typeof aiSource === "object" ? aiSource.owner : "local-owner") } };
  const client = await createProvider(aiSource, { timeoutMs: generationTimeouts(undefined, undefined, aiSource).modelMs });
  const {model,providerName} = client;
  try {
    const common = { model, store: false, max_output_tokens: request.action === "rewrite" ? 2000 : 8000,
      input: [{ role: "system" as const, content: VIDEO_PROMPT }, { role: "user" as const, content: videoUserPrompt(request) }] };
    const response = request.action === "rewrite"
      ? await client.responses.parse({ ...common, text: { format: zodTextFormat(z.object({ shot: shotSchema }), "video_shot") } }, { signal })
      : await client.responses.parse({ ...common, text: { format: zodTextFormat(z.object({ plan: videoPlanSchema }), "video_plan") } }, { signal });
    if (signal.aborted) throw new AppError("CANCELLED", "请求已取消，原方案仍保留。", 499);
    if (response.output.some(item => item.type === "message" && item.content.some(part => part.type === "refusal"))) throw new AppError("REFUSAL", "AI 无法处理这次要求，请调整选题后重试。", 422);
    if (response.status !== "completed" || !response.output_parsed) throw new AppError("INVALID_RESULT", "方案未完整返回，原内容仍保留。请简化要求后重试。", 502);
    try {
      const value = response.output_parsed;
      if (request.action === "rewrite") {
        if (!("shot" in value) || !request.current) throw new Error("重写镜头结构不完整。");
        return { shot: validateShot(request.input, request.current, request.targetId, value.shot) };
      }
      if (!("plan" in value)) throw new Error("方案结构不完整。");
      return { plan: validateVideoPlan(request.input, value.plan) };
    } catch (error) { throw new AppError("INVALID_RESULT", error instanceof Error ? error.message : "生成结果校验失败，原内容仍保留。", 502); }
  } catch (error) { throw providerError(error, providerName); }
}

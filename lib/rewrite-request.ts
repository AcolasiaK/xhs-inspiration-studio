import { cloudJobFetch } from "./cloud/jobs-client";
import { isCloudClient } from "./cloud/client";
import { MAX_REQUEST_BYTES } from "./constants";
import { compressImages } from "./images";
import { generationMetaSchema, type Brief } from "./schema";
import type { Draft } from "./drafts";
import type { StudioImage } from "./types";
import type { TravelResearch } from "./travel-research";
import { aiSourceHeader, getAiSource, type AiSource } from "./ai-source";

export type RewriteDirection = "natural" | "concise" | "appealing" | "detailed" | "custom";
type RewriteOptions = {
  brief: Brief; body: string; direction: RewriteDirection; instruction: string; images: StudioImage[]; accessToken?: string; research?: TravelResearch;
  controller: AbortController; onProgress: (done: number, total: number) => void; onRequestStarted: () => void;
  compress?: typeof compressImages; request?: typeof fetch; timeoutMs?: number; aiSource?: AiSource;
};

/** 请求只返回待确认的正文，不修改任何草稿；注入依赖用于无付费的模拟测试。 */
export async function submitRewrite(options: RewriteOptions): Promise<string> {
  const source = options.aiSource ?? getAiSource();
  const { brief, body, direction, instruction, images, accessToken = "", controller, research } = options;
  const cancelled = () => new Error("重写已取消，原正文和其他内容仍保留。 ");
  if (controller.signal.aborted) throw cancelled();
  const compressed = await (options.compress ?? compressImages)(images, (done, total) => {
    if (!controller.signal.aborted) options.onProgress(done, total);
  });
  if (controller.signal.aborted) throw cancelled();
  if (compressed.length !== images.length) throw new Error("图片处理不完整，原正文仍保留。请重试。");
  const form = new FormData();
  form.set("payload", JSON.stringify({ brief, body, direction, instruction, research, imageIds: images.map((image) => image.id), mode: "live" }));
  compressed.forEach((blob, index) => form.append("images", blob, `${images[index].id}.jpg`));
  if ((await new Response(form).blob()).size > MAX_REQUEST_BYTES) throw new Error("请求体积过大，请减少图片后重新生成原笔记。原正文仍保留。");
  if (controller.signal.aborted) throw cancelled();
  const timeout = new AbortController();
  
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? (isCloudClient() ? 600_000 : 195_000));
  try {
    options.onRequestStarted();
    const headers: Record<string, string> = { "X-Client-Request-Id": crypto.randomUUID(), ...aiSourceHeader(source) };
    if (accessToken.trim()) headers["x-access-token"] = accessToken.trim();
    const response = await (options.request ?? (isCloudClient() ? cloudJobFetch : fetch))("/api/rewrite", { method: "POST", body: form, headers, signal: AbortSignal.any([controller.signal, timeout.signal]) });
    const payload = await response.json().catch(() => null);
    if (controller.signal.aborted) throw cancelled();
    if (timeout.signal.aborted) throw new Error("重写等待超时，原正文和其他内容仍保留，请稍后重试。");
    if (!response.ok) {
      const message = typeof payload?.error?.message === "string" && payload.error.message.length <= 500 ? payload.error.message
        : response.status === 502 ? "AI 服务返回异常（HTTP 502），原正文仍保留，请稍后重试。"
          : "重写暂时失败，原正文仍保留，请稍后重试。";
      throw new Error(message);
    }
    if (typeof payload?.body !== "string" || !payload.body.trim() || payload.body.length > 6000 || !generationMetaSchema.safeParse(payload.meta).success) {
      throw new Error("重写结果不完整，原正文仍保留，请重试。");
    }
    return payload.body;
  } catch (error) {
    if (controller.signal.aborted) throw cancelled();
    if (timeout.signal.aborted) throw new Error("重写等待超时，原正文和其他内容仍保留，请稍后重试。");
    if (error instanceof TypeError) throw new Error("网络连接失败，原正文和其他内容仍保留，请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

/** 仅在同一份原文与生成版本仍然存在时应用，避免覆盖后来编辑。 */
export function applyRewriteIfCurrent(current: Draft, draftId: string, originalBody: string, generationVersion: string, rewritten: string, expectedResearch?: TravelResearch | null): Draft {
  if (current.id !== draftId || !current.generation || current.generation.meta.completedAt !== generationVersion || current.generation.result.body !== originalBody) return current;
  if (expectedResearch !== undefined && JSON.stringify(current.generation.research ?? null) !== JSON.stringify(expectedResearch)) return current;
  return { ...current, hasUserEdits: true, generation: { ...current.generation, result: { ...current.generation.result, body: rewritten } } };
}

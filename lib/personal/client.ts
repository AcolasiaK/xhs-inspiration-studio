import { aiSourceHeader, getAiSource, type AiSource } from "@/lib/ai-source";
import { cloudJobFetch } from "@/lib/cloud/jobs-client";
import { isCloudClient } from "@/lib/cloud/client";
import { MAX_REQUEST_BYTES } from "@/lib/constants";
import { compressImages } from "@/lib/images";
import { personalRequestSchema, type PersonalRequest } from "./schema";
import type { StudioImage } from "@/lib/types";

export class PersonalRequestError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); this.name = "PersonalRequestError"; }
}
export type PersonalRequestPhase = "preparing" | "requesting" | "validating";

/** Send a frozen input snapshot; no draft is changed until the caller validates a response. */
export async function personalRequest(payload: PersonalRequest, images: StudioImage[], controller: AbortController, options?: {compress?:typeof compressImages;request?:typeof cloudJobFetch;source?:AiSource;onPhase?:(phase:PersonalRequestPhase)=>void}) {
  const source = options?.source ?? getAiSource();
  const parsed = personalRequestSchema.parse(payload);
  if (images.length !== parsed.imageIds.length || images.some((image, i) => image.id !== parsed.imageIds[i])) throw new Error("图片与请求不一致，原内容仍保留。");
  if (controller.signal.aborted) throw new PersonalRequestError("CANCELLED", "本次操作已取消，原内容仍保留。");
  options?.onPhase?.("preparing");
  const blobs = await (options?.compress ?? compressImages)(images, () => undefined);
  if (controller.signal.aborted) throw new PersonalRequestError("CANCELLED", "本次操作已取消，原内容仍保留。");
  if (blobs.length !== images.length) throw new Error("图片处理结果不完整，原内容仍保留。");
  const form = new FormData(); form.set("payload", JSON.stringify(parsed));
  blobs.forEach((blob, i) => form.append("images", blob, `${parsed.imageIds[i]}.jpg`));
  if ((await new Response(form).blob()).size > MAX_REQUEST_BYTES) throw new Error("图片和文字过大，请减少图片或精简要求。");
  if (controller.signal.aborted) throw new PersonalRequestError("CANCELLED", "本次操作已取消，原内容仍保留。");
  
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), isCloudClient() ? 600_000 : 195_000);
  try {
    options?.onPhase?.("requesting");
    const response = await (options?.request ?? cloudJobFetch)("/api/personal", { method: "POST", body: form, headers: aiSourceHeader(source), signal: AbortSignal.any([controller.signal, timeout.signal]) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new PersonalRequestError(typeof data?.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(data.error.code) ? data.error.code : "REQUEST_FAILED", typeof data?.error?.message === "string" && data.error.message.length <= 500 ? data.error.message : "操作暂时失败，已有内容保留。", response.status);
    if (controller.signal.aborted) throw new PersonalRequestError("CANCELLED", "本次操作已取消，原内容仍保留。");
    if (timeout.signal.aborted) throw new PersonalRequestError("TIMEOUT", "等待超时，原内容仍保留，请稍后重试。");
    options?.onPhase?.("validating");
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new PersonalRequestError("CANCELLED", "本次操作已取消，原内容仍保留。");
    if (timeout.signal.aborted) throw new PersonalRequestError("TIMEOUT", "等待超时，原内容仍保留，请稍后重试。");
    if (error instanceof TypeError) throw new PersonalRequestError("NETWORK", "网络连接失败，原内容仍保留。请检查网络后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

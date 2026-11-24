import { aiSourceHeader, getAiSource } from "./ai-source";
import { cloudJobFetch } from "./cloud/jobs-client";
import { isCloudClient } from "./cloud/client";
import { MAX_REQUEST_BYTES } from "./constants";
import { compressImages } from "./images";
import { generationMetaSchema, type Brief, type GenerationMode } from "./schema";
import type { ApiResponse, StudioImage } from "./types";
import type { Draft, GenerationInput } from "./drafts";
import { validateResult } from "./validate-result";
import { isRequestId, recordClientDiagnostic, safeErrorCode, safeServerStage, SERVER_STAGES, type ServerStage } from "./client-diagnostics";
import { travelResearchSchema } from "./travel-research";
import type { TravelResearch } from "./travel-research";

export const GENERATION_CLIENT_TIMEOUT_MS = 195_000;

export class GenerationRequestError extends Error {
  constructor(public code: string, message: string, public requestId?: string, public stage?: ServerStage | "image_compression" | "api_request" | "client_validation", public httpStatus?: number) { super(message); }
}

export function generationErrorMessage(error: unknown): string {
  let message = error instanceof TypeError ? "网络连接失败，请检查网络后重试。已有内容已保留。"
    : error instanceof Error ? error.message : "生成失败，请重试。";
  if (error instanceof GenerationRequestError && isRequestId(error.requestId)) {
    const serverStage = safeServerStage(error.stage);
    const phase = error.stage === "image_compression" ? "图片处理" : error.stage === "client_validation" ? "页面结果校验"
      : serverStage ? SERVER_STAGES[serverStage] : "接口请求";
    message += `（阶段：${phase}；本次编号：${error.requestId}）`;
  }
  return message;
}

type RequestOptions = {
  brief: Brief; mode: GenerationMode; images: StudioImage[]; accessToken?: string;
  aiSource?: string;
  controller: AbortController;
  requestId?: string;
  onProgress: (done: number, total: number) => void;
  onRequestStarted: () => void;
  // 可注入依赖，便于无付费请求地测试真实请求编排。
  compress?: typeof compressImages; request?: typeof fetch; timeoutMs?: number;
};

/** 提交一次浏览器请求，只有输入、协议和结果全部通过校验才返回。 */
export async function submitGeneration(options: RequestOptions) {
  const { brief, mode, images, accessToken = "", controller, onProgress, onRequestStarted } = options;
  const compress = options.compress ?? compressImages;
  const send = options.request ?? (isCloudClient() ? cloudJobFetch : fetch);
  const requestId = isRequestId(options.requestId) ? options.requestId.toLowerCase() : crypto.randomUUID();
  // 原顺序及稳定 ID 是这次提交的唯一关联依据。
  const imageIds = images.map((image) => image.id);
  const cancelled = (stage: "image_compression" | "api_request") => new GenerationRequestError("CANCELLED", "本次生成已取消。图片、输入和已有结果已保留。", requestId, stage);
  const checkCancelled = () => { if (controller.signal.aborted) throw cancelled("image_compression"); };
  const source = options.aiSource ?? getAiSource();
  const compressionStarted = performance.now();
  let form: FormData;
  try {
    checkCancelled();
    const compressed = await compress(images, (done, total) => { if (!controller.signal.aborted) onProgress(done, total); });
    checkCancelled();
    if (compressed.length !== imageIds.length) throw new Error("图片处理结果不完整，请重试。已有内容已保留。");
    form = new FormData();
    form.set("payload", JSON.stringify({ brief, mode, imageIds }));
    compressed.forEach((blob, index) => form.append("images", blob, `${imageIds[index]}.jpg`));
    const measured = await new Response(form).blob();
    checkCancelled();
    if (measured.size > MAX_REQUEST_BYTES) throw new GenerationRequestError("TOO_LARGE", "请求体积过大，请减少图片数量。", requestId, "image_compression");
    recordClientDiagnostic({ requestId, phase: "image_compression", result: "success", elapsedMs: performance.now() - compressionStarted });
  } catch (error) {
    const mapped = controller.signal.aborted ? cancelled("image_compression")
      : error instanceof GenerationRequestError ? error
        : new GenerationRequestError("COMPRESSION_FAILED", error instanceof Error ? error.message : "图片处理失败，请重试。", requestId, "image_compression");
    recordClientDiagnostic({ requestId, phase: "image_compression", result: mapped.code === "CANCELLED" ? "cancelled" : "failed", elapsedMs: performance.now() - compressionStarted, code: mapped.code });
    throw mapped;
  }

  const timeoutController = new AbortController();
  const signal = AbortSignal.any([controller.signal, timeoutController.signal]);
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? (isCloudClient() ? 600_000 : GENERATION_CLIENT_TIMEOUT_MS));
  const checkStopped = () => {
    if (controller.signal.aborted) throw cancelled("api_request");
    if (timeoutController.signal.aborted) throw new GenerationRequestError("TIMEOUT", "等待超时，请稍后重试。图片、输入和已有结果已保留。", requestId, "api_request");
  };
  const requestStarted = performance.now();
  let httpStatus: number | undefined;
  try {
    onRequestStarted();
    const headers: Record<string, string> = { "X-Client-Request-Id": requestId };
    Object.assign(headers, aiSourceHeader(source));
    if (mode === "live" && accessToken) headers["x-access-token"] = accessToken.trim();
    const response = await send("/api/generate", {
      method: "POST", body: form, signal, headers,
    });
    httpStatus = response.status;
    checkStopped();
    const payload = await response.json().catch(() => null);
    checkStopped();
    if (!response.ok) {
      // 响应 JSON 不可信：只使用受控阶段，且只在关联 ID 与本次请求一致时显示服务端阶段。
      const serverId = payload?.error?.requestId;
      const stage = isRequestId(serverId) && serverId.toLowerCase() === requestId ? safeServerStage(payload?.error?.stage) : undefined;
      const message = typeof payload?.error?.message === "string" && payload.error.message.length <= 500 ? payload.error.message
        : response.status === 413 ? "上传内容过大，请减少图片。" : "服务暂时不可用，请稍后重试。";
      throw new GenerationRequestError(safeErrorCode(payload?.error?.code), message, requestId, stage ?? "api_request", response.status);
    }
    const data = payload as ApiResponse;
    let result;
    try { result = validateResult(data?.result, imageIds, undefined, mode === "live" ? brief.writingStyle : undefined); }
    catch (error) { throw new GenerationRequestError("CLIENT_VALIDATION_FAILED", error instanceof Error ? error.message : "生成结果不完整，请重试。", requestId, "client_validation", response.status); }
    if (data.mode !== mode) throw new GenerationRequestError("CLIENT_VALIDATION_FAILED", "生成模式不一致，请刷新页面重试。", requestId, "client_validation", response.status);
    const metadata = generationMetaSchema.safeParse(data.meta);
    if (!metadata.success) throw new GenerationRequestError("CLIENT_VALIDATION_FAILED", "生成记录不完整，请刷新页面后重试。已有内容已保留。", requestId, "client_validation", response.status);
    const research = data.research === undefined ? undefined : travelResearchSchema.safeParse(data.research);
    if (research && !research.success) throw new GenerationRequestError("CLIENT_VALIDATION_FAILED", "参考来源信息不完整，已有内容已保留。", requestId, "client_validation", response.status);
    checkStopped();
    recordClientDiagnostic({ requestId, phase: "api_request", result: "success", elapsedMs: performance.now() - requestStarted, httpStatus });
    return { result, metadata: metadata.data, imageIds, research: research?.data };
  } catch (error) {
    // 网络层可能用不同错误表示中断；根据真实信号区分主动取消和计时器超时。
    let mapped: GenerationRequestError;
    if (controller.signal.aborted) mapped = cancelled("api_request");
    else if (timeoutController.signal.aborted) mapped = new GenerationRequestError("TIMEOUT", "等待超时，请稍后重试。图片、输入和已有结果已保留。", requestId, "api_request");
    else if (error instanceof GenerationRequestError) mapped = error;
    else if (error instanceof TypeError) mapped = new GenerationRequestError("NETWORK_ERROR", "网络连接失败，请检查网络后重试。已有内容已保留。", requestId, "api_request");
    else mapped = new GenerationRequestError("UNKNOWN", "生成暂时失败，请重试。已有内容已保留。", requestId, "api_request");
    recordClientDiagnostic({ requestId, phase: "api_request", result: mapped.code === "TIMEOUT" ? "timeout" : mapped.code === "CANCELLED" ? "cancelled" : "failed", elapsedMs: performance.now() - requestStarted, code: mapped.code, httpStatus });
    throw mapped;
  } finally { clearTimeout(timer); }
}

type Lock = { current: boolean };
/** 对话框两种选择共用同步锁；保存失败时不会发起生成。 */
export async function runRegenerationChoice(lock: Lock, preserve: boolean, saveCopy: () => Promise<boolean>, start: () => Promise<void>) {
  if (lock.current) return false;
  lock.current = true;
  try {
    if (preserve && !await saveCopy()) return false;
    await start();
    return true;
  } finally { lock.current = false; }
}

/** 防止旧组件的迟到响应写进另一个已打开的草稿。 */
export function applyValidatedGeneration(current: Draft, draftId: string, output: Omit<Awaited<ReturnType<typeof submitGeneration>>, "research"> & {research?: TravelResearch}, mode: GenerationMode, images: StudioImage[], submittedInput: GenerationInput): Draft {
  if (current.id !== draftId) return current;
  return { ...current, generation: { result: output.result, mode, imageIds: output.imageIds, meta: output.metadata, ...(output.research ? {research: output.research} : {}) },
    resultImages: images, generatedInput: submittedInput, selectedTitleIndex: 0, hasUserEdits: false };
}

import { getAiSource, type AiSource } from "@/lib/server/ai-source";
import { cloudError } from "@/lib/cloud/server/config";
import { isCloudMode } from "@/lib/cloud/mode";
import { submitCloudJob } from "@/lib/cloud/server/submit";
import { AppError } from "@/lib/errors";
import { randomUUID } from "node:crypto";
import { createDemoResult } from "@/lib/demo";
import { validateResult } from "@/lib/validate-result";
import { checkRateLimit, assertAppAccess, assertLocalRequest } from "@/lib/server/guard";
import { getServerConfig } from "@/lib/server/config";
import { generateContent, GenerationStageError } from "@/lib/server/openai";
import { parseUpload, readBoundedFormData } from "@/lib/server/uploads";
import { generationTimeouts } from "@/lib/server/generation-timeouts";
import { searchTravelInfo } from "@/lib/server/travel-search";

export const runtime = "nodejs";
export const maxDuration = 200;
// 只接受固定长度、固定字符集的 UUID，避免把任意请求头写入日志。
const SAFE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function POST(request: Request) {
  if (isCloudMode()) return submitCloudJob(request, "generate");
  let aiSource: AiSource;
  try { aiSource = await getAiSource(request); } catch(error) { return cloudError(error); }
  const headers = { "Cache-Control": "no-store" };
  const startedAt = performance.now();
  const { totalMs: requestBudgetMs, modelMs } = generationTimeouts(undefined, undefined, aiSource);
  // 从路由入口计时，上传读取、图片校验、主生成和补正共享同一个期限。
  const deadline = AbortSignal.timeout(requestBudgetMs);
  const budgetSignal = AbortSignal.any([request.signal, deadline]);
  const clientId = request.headers.get("X-Client-Request-Id");
  const requestId = clientId && SAFE_REQUEST_ID.test(clientId) ? clientId : randomUUID();
  let stage = "read_upload";
  let mode: unknown;
  function assertBudget() {
    // 用户取消优先于期限到期，绝不把用户取消误判成服务商超时。
    if (request.signal.aborted) throw new AppError("CANCELLED", "本次生成已取消。已有内容已保留。", 499);
    if (deadline.aborted || performance.now() - startedAt >= requestBudgetMs) throw new AppError("TIMEOUT", "服务端处理超时，请稍后重试。已有内容已保留。", 504);
  }
  async function withinBudget<T>(operation: () => Promise<T>): Promise<T> {
    assertBudget();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { try { assertBudget(); } catch (error) { reject(error); } };
      budgetSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(operation), aborted]);
      assertBudget();
      return result;
    } catch (error) { assertBudget(); throw error; }
    finally { if (onAbort) budgetSignal.removeEventListener("abort", onAbort); }
  }
  try {
    assertBudget();
    assertLocalRequest(request);
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) throw new AppError("INVALID_ORIGIN", "请从本工具页面提交请求。", 403);
    checkRateLimit("uploads", 30);
    const uploadStartedAt = performance.now();
    const form = await withinBudget(() => readBoundedFormData(request, budgetSignal));
    // 在解码图片、调用 AI 前完成真实模式的访问检查。
    try { mode = JSON.parse(String(form.get("payload"))).mode; } catch { throw new AppError("INVALID_FORM", "创作要求无法读取，请重新提交。"); }
    if (mode === "live") console.info(`[generate_stage] requestId=${requestId} stage=read_upload status=success elapsedMs=${Math.round(performance.now() - uploadStartedAt)}`);
    if (mode === "live") {
      stage = "access_check";
      const config = getServerConfig();
          assertAppAccess(request, config);
      checkRateLimit("live", 6);
    }
    stage = "input_validation";
    const validationStartedAt = performance.now();
    const input = await withinBudget(() => parseUpload(form));
    if (input.mode === "live") console.info(`[generate_stage] requestId=${requestId} stage=input_validation status=success elapsedMs=${Math.round(performance.now() - validationStartedAt)}`);
    stage = input.mode === "demo" ? "demo" : "generation";
    const research = input.mode === "live" && input.brief.creationTypes.includes("travel")
      ? await withinBudget(() => searchTravelInfo({place: input.brief.travelSearchPlace, enabled: input.brief.travelSearch, signal: budgetSignal})) : undefined;
    const result = input.mode === "demo"
      ? validateResult(createDemoResult(input.imageIds), input.imageIds)
      : await generateContent(input.brief, input.images, request.signal, requestId, { signal: deadline, startedAt, maxDurationMs: requestBudgetMs, modelTimeoutMs: modelMs }, research, aiSource);
    assertBudget();
    const meta = { durationMs: Math.round(performance.now() - startedAt), completedAt: new Date().toISOString() };
    if (input.mode === "live") console.info(`[generate] requestId=${requestId} mode=live stage=completed status=success durationMs=${meta.durationMs}`);
    return Response.json({ result, mode: input.mode, meta, ...(research ? {research} : {}) }, { headers: { ...headers, "X-Request-Id": requestId } });
  } catch (error) {
    const known = error instanceof AppError ? error : new AppError("SERVER_ERROR", "暂时无法生成，请稍后再试。已有内容已保留。", 500);
    // 只记录错误代码，避免将用户图片、输入、口令或供应商响应写入日志。
    const failureStage = known instanceof GenerationStageError ? known.stage : stage;
    const source = known instanceof GenerationStageError ? known.source : "application";
    const providerStatus = known instanceof GenerationStageError ? known.providerStatus : undefined;
    if (mode === "live" || known.status >= 500) console.error(`[generate] requestId=${requestId} mode=${mode === "live" ? "live" : "other"} stage=${failureStage} status=failed source=${source} code=${known.code} providerStatus=${providerStatus ?? "none"} durationMs=${Math.round(performance.now() - startedAt)}`);
    return Response.json({ error: { code: known.code, message: known.message, requestId, stage: failureStage } }, {
      status: known.status,
      headers: { ...headers, "X-Request-Id": requestId, ...(known.status === 429 && known.code !== "PROVIDER_QUOTA" ? { "Retry-After": "60" } : {}) },
    });
  }
}

import { isCloudMode } from "@/lib/cloud/mode";
import { submitCloudJob } from "@/lib/cloud/server/submit";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { inputIssue, videoRequestSchema } from "@/lib/video/schema";
import { getServerConfig } from "@/lib/server/config";
import { checkRateLimit, assertAppAccess, assertLocalRequest } from "@/lib/server/guard";
import { generateVideo } from "@/lib/server/video";
import { getAiSource, type AiSource } from "@/lib/server/ai-source";

export const runtime = "nodejs";
export const maxDuration = 200;
const MAX_BYTES = 256 * 1024;
export async function POST(request: Request) {
  let aiSource: AiSource;
  try { aiSource = await getAiSource(request); }
  catch (error) {
    const known = error instanceof AppError ? error : new AppError("INVALID_FORM", "请选择有效的 AI 生成方式。", 400);
    return Response.json({error:{code:known.code,message:known.message}}, {status:known.status,headers:{"Cache-Control":"no-store"}});
  }
  if (isCloudMode()) return submitCloudJob(request, "video");
  const started = performance.now(), requestId = randomUUID();
  const deadline = AbortSignal.timeout(190_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const headers = { "Cache-Control": "no-store", "X-Request-Id": requestId };
  let stage = "access_check";
  const assertActive = () => {
    if (request.signal.aborted) throw new AppError("CANCELLED", "请求已取消，原内容仍保留。", 499);
    if (deadline.aborted) throw new AppError("TIMEOUT", "视频策划等待超时，请稍后重试。原内容仍保留。", 504);
  };
  async function withinBudget<T>(operation: () => Promise<T>): Promise<T> {
    assertActive();
    let abort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => { abort = () => { try { assertActive(); } catch (error) { reject(error); } }; signal.addEventListener("abort", abort, { once: true }); });
    try { const result = await Promise.race([operation(), aborted]); assertActive(); return result; }
    catch (error) { assertActive(); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  try {
    assertActive();
    assertLocalRequest(request);
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) throw new AppError("INVALID_ORIGIN", "请从本工具页面提交。", 403);
    checkRateLimit("video_input", 30);
    const config = getServerConfig();
    assertAppAccess(request, config);
    stage = "input_validation";
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INVALID_FORM", "视频策划仅接收文字 JSON，不支持文件上传。", 415);
    if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw new AppError("TOO_LARGE", "文字过长，请精简后重试。", 413);
    const raw = await withinBudget(async () => {
      const reader = request.body?.getReader();
      if (!reader) throw new AppError("INVALID_FORM", "没有收到输入内容。");
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { cancel(); throw new AppError("TOO_LARGE", "文字过长，请精简后重试。", 413); } chunks.push(value); }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new AppError("INVALID_FORM", "输入内容无法读取，请重试。"); }
      } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
    });
    const parsed = videoRequestSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("INVALID_FORM", "请检查输入长度、视频类型和时长（10～600 秒）。");
    const data = parsed.data, issue = inputIssue(data.input);
    if (issue) throw new AppError("INVALID_FORM", issue);
    if (data.action === "rewrite" && (!data.current || !data.current.shots.some(s => s.shotId === data.targetId))) throw new AppError("INVALID_FORM", "找不到要重写的镜头，请重新打开方案。");
    checkRateLimit("live", 6);
    stage = data.action === "rewrite" ? "shot_rewrite" : "plan_generation";
    const result = await withinBudget(() => generateVideo(data, signal, aiSource));
    const durationMs = Math.round(performance.now() - started);
    console.info(`[video] requestId=${requestId} stage=${stage} code=SUCCESS durationMs=${durationMs}`);
    return Response.json({ ...result, meta: { durationMs, completedAt: new Date().toISOString() } }, { headers });
  } catch (error) {
    const known = error instanceof AppError ? error : new AppError("SERVER_ERROR", "视频策划暂时失败，原内容仍保留。", 500);
    console.error(`[video] requestId=${requestId} stage=${stage} code=${known.code} httpStatus=${known.status} durationMs=${Math.round(performance.now()-started)}`);
    return Response.json({ error: { code: known.code, message: known.message, requestId, stage } }, { status: known.status, headers });
  }
}

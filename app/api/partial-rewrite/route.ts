import { isCloudMode } from "@/lib/cloud/mode";
import { submitCloudJob } from "@/lib/cloud/server/submit";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { partialRewriteRequestSchema } from "@/lib/partial-rewrite-schema";
import { checkRateLimit, assertAppAccess, assertLocalRequest } from "@/lib/server/guard";
import { getServerConfig } from "@/lib/server/config";
import { parseUpload, readBoundedFormData } from "@/lib/server/uploads";
import { partialRewrite } from "@/lib/server/partial-rewrite";
import { getAiSource, type AiSource } from "@/lib/server/ai-source";

export const runtime = "nodejs";
export const maxDuration = 200;
const SAFE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function POST(request: Request) {
  let aiSource: AiSource;
  try { aiSource = await getAiSource(request); } catch (error) { const e = error as AppError; return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status }); }
  if (isCloudMode()) return submitCloudJob(request, "partial");
  const BUDGET_MS = 190_000;
  const startedAt = performance.now();
  const deadline = AbortSignal.timeout(BUDGET_MS);
  const signal = AbortSignal.any([request.signal, deadline]);
  const candidate = request.headers.get("X-Client-Request-Id");
  const requestId = candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  const headers = { "Cache-Control": "no-store", "X-Request-Id": requestId };
  let stage = "read_upload";
  function assertBudget() {
    if (request.signal.aborted) throw new AppError("CANCELLED", "本次重写已取消，原内容仍然保留。", 499);
    if (deadline.aborted || performance.now() - startedAt >= BUDGET_MS) throw new AppError("TIMEOUT", "重写超时，请稍后重试。原内容仍然保留。", 504);
  }
  async function withinBudget<T>(operation: () => Promise<T>): Promise<T> {
    assertBudget();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { try { assertBudget(); } catch (error) { reject(error); } };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(operation), aborted]);
      assertBudget();
      return result;
    } catch (error) { assertBudget(); throw error; }
    finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }
  try {
    assertBudget();
    assertLocalRequest(request);
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) throw new AppError("INVALID_ORIGIN", "请从本工具页面提交请求。", 403);
    checkRateLimit("uploads", 30);
    const form = await withinBudget(() => readBoundedFormData(request, signal));
    stage = "access_check";
    const config = getServerConfig();
    assertAppAccess(request, config);
    checkRateLimit("live", 6);
    stage = "input_validation";
    let raw: unknown;
    try { raw = JSON.parse(String(form.get("payload"))); } catch { throw new AppError("INVALID_FORM", "重写要求无法读取，请重试。"); }
    const parsed = partialRewriteRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const tagIssue = parsed.error.issues.some((issue) => issue.message === "请先整理为 10 个不重复的有效话题，再重写单个话题。");
      throw new AppError("INVALID_FORM", tagIssue ? "请先整理为 10 个不重复的有效话题，再重写单个话题；也可以重新生成全部话题。" : "请检查原内容、图片对应关系、重写方向及补充要求后重试。");
    }
    const input = await withinBudget(() => parseUpload(form));
    stage = "model_request";
    const result = await withinBudget(() => partialRewrite(parsed.data, input.images, signal, aiSource));
    const durationMs = Math.round(performance.now() - startedAt);
    console.info(`[partial_rewrite] requestId=${requestId} stage=completed status=success durationMs=${durationMs}`);
    return Response.json({ result, meta: { durationMs, completedAt: new Date().toISOString() } }, { headers });
  } catch (error) {
    const known = error instanceof AppError ? error : new AppError("SERVER_ERROR", "暂时无法重写，原内容仍然保留。", 500);
    console.error(`[partial_rewrite] requestId=${requestId} stage=${stage} status=failed code=${known.code} durationMs=${Math.round(performance.now() - startedAt)}`);
    return Response.json({ error: { code: known.code, message: known.message, requestId, stage } }, { status: known.status, headers });
  }
}

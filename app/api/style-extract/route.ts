import { isCloudMode } from "@/lib/cloud/mode";
import { submitCloudJob } from "@/lib/cloud/server/submit";
import { readJson } from "@/lib/cloud/server/config";
import { styleExtractRequestSchema } from "@/lib/style-extract-schema";
import { extractStyle } from "@/lib/server/style-extract";
import { assertAppAccess, assertLocalRequest, checkRateLimit } from "@/lib/server/guard";
import { AppError } from "@/lib/errors";
import { getAiSource, type AiSource } from "@/lib/server/ai-source";

export const runtime = "nodejs";
export const maxDuration = 200;
export async function POST(request: Request) {
  let aiSource: AiSource;
  try { aiSource = await getAiSource(request); } catch (error) { const e = error as AppError; return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status }); }
  if(isCloudMode()) return submitCloudJob(request,"style_extract");
  const deadline=AbortSignal.timeout(190_000);
  const signal=AbortSignal.any([request.signal,deadline]);
  try {
    assertLocalRequest(request);
    const origin=request.headers.get("origin");if(origin && new URL(origin).host!==request.headers.get("host"))throw new AppError("INVALID_ORIGIN","请从本工具页面操作。",403);
    checkRateLimit("style_extract_input",30);
    assertAppAccess(request);
    const parsed=styleExtractRequestSchema.safeParse(await readJson(request,32*1024));
    if(!parsed.success)throw new AppError("INVALID_FORM","请输入不超过 6000 字的参考文案并选择有效的参考方向。",400);
    checkRateLimit("live",6);
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AppError(request.signal.aborted ? "CANCELLED" : "TIMEOUT", request.signal.aborted ? "已取消提取，当前内容未改变。" : "风格提取超时，当前内容未改变。", request.signal.aborted ? 499 : 504));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, {once:true});
    });
    let preferences;
    try { preferences=await Promise.race([extractStyle(parsed.data,signal,aiSource),stopped]); }
    finally { if(onAbort)signal.removeEventListener("abort",onAbort); }
    if(request.signal.aborted)throw new AppError("CANCELLED","已取消提取，当前内容未改变。",499);
    if(deadline.aborted)throw new AppError("TIMEOUT","风格提取超时，当前内容未改变。",504);
    return Response.json({preferences},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    const known=deadline.aborted&&!request.signal.aborted?new AppError("TIMEOUT","风格提取超时，当前内容未改变。",504):error instanceof AppError?error:new AppError("SERVER_ERROR","风格提取失败，当前内容未改变。",500);
    return Response.json({error:{code:known.code,message:known.message}},{status:known.status,headers:{"Cache-Control":"no-store"}});
  }
}

import { randomUUID } from "node:crypto";
import { isCloudMode } from "@/lib/cloud/mode";
import { submitCloudJob } from "@/lib/cloud/server/submit";
import { AppError } from "@/lib/errors";
import { personalRequestSchema } from "@/lib/personal/schema";
import { getAiSource, type AiSource } from "@/lib/server/ai-source";
import { assertAppAccess, assertLocalRequest, checkRateLimit } from "@/lib/server/guard";
import { parseImageFiles, readBoundedFormData } from "@/lib/server/uploads";
import { runPersonal } from "@/lib/server/personal";

export const runtime="nodejs";
export const maxDuration=200;
export async function POST(request:Request){
  let source:AiSource;
  try{source=await getAiSource(request);}catch(error){const e=error instanceof AppError?error:new AppError("INVALID_FORM","AI 来源无效。",400);return Response.json({error:{code:e.code,message:e.message}},{status:e.status});}
  if(isCloudMode())return submitCloudJob(request,"personal");
  const start=performance.now(),deadline=AbortSignal.timeout(190_000),signal=AbortSignal.any([request.signal,deadline]);
  const requestedId=request.headers.get("X-Client-Request-Id"),requestId=requestedId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestedId)?requestedId:randomUUID();
  try{
    assertLocalRequest(request);const origin=request.headers.get("origin");if(origin&&new URL(origin).host!==request.headers.get("host"))throw new AppError("INVALID_ORIGIN","请从本工具页面操作。",403);
    assertAppAccess(request);checkRateLimit("uploads",30);checkRateLimit("live",6);
    const form=await readBoundedFormData(request,signal);let raw:unknown;try{raw=JSON.parse(String(form.get("payload")));}catch{throw new AppError("INVALID_FORM","个人创作要求无法读取。",400);}
    const parsed=personalRequestSchema.safeParse(raw);if(!parsed.success)throw new AppError("INVALID_FORM",parsed.error.issues.find(i=>i.message.includes("风格"))?.message||"请检查经历、图片和已确认的提示词。",400);
    const images=await parseImageFiles(form,parsed.data.imageIds);
    const result=await runPersonal(parsed.data,images,signal,source);
    if(request.signal.aborted)throw new AppError("CANCELLED","已取消，已有内容保留。",499);
    if(deadline.aborted)throw new AppError("TIMEOUT","个人创作超时，已有内容保留。",504);
    return Response.json({...result,meta:{durationMs:Math.round(performance.now()-start),completedAt:new Date().toISOString()}},{headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
  }catch(error){
    const e=request.signal.aborted?new AppError("CANCELLED","已取消，已有内容保留。",499):deadline.aborted?new AppError("TIMEOUT","个人创作超时，已有内容保留。",504):error instanceof AppError?error:new AppError("SERVER_ERROR","暂时无法完成个人创作，已有内容保留。",500);
    console.error(`[personal] requestId=${requestId} code=${e.code} status=${e.status} elapsedMs=${Math.round(performance.now()-start)}`);
    return Response.json({error:{code:e.code,message:e.message,requestId}},{status:e.status,headers:{"Cache-Control":"no-store","X-Request-Id":requestId}});
  }
}

import { selectProfile } from "@/lib/server/ai/selection";
import { createProvider } from "@/lib/server/ai/provider";
import { seal } from "@/lib/server/ai/store";
import "server-only";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { createDemoResult } from "@/lib/demo";
import { validateResult } from "@/lib/validate-result";
import { rewriteRequestSchema } from "@/lib/rewrite-schema";
import { partialRewriteRequestSchema } from "@/lib/partial-rewrite-schema";
import { inputIssue, videoRequestSchema } from "@/lib/video/schema";
import { stylePreferencesSchema, PRESET_STYLES } from "@/lib/styles";
import { readBoundedFormData, parseUpload, parseImageFiles } from "@/lib/server/uploads";
import { personalRequestSchema } from "@/lib/personal/schema";
import { bindPersonalRules } from '@/lib/server/personal-style-store';
import { assertOrigin, cloudError, readJson } from "./config";
import { requireUser } from "./auth";
import { enqueue, shortLimit, type JobInput, type Kind } from "./jobs";
import { readShared } from "./hotspots";
import { styleExtractRequestSchema } from "@/lib/style-extract-schema";

function requestId(request:Request){return request.headers.get("X-Client-Request-Id")||randomUUID();}
/** Validate and persist inputs before responding; never put content or secrets in diagnostic logs. */
export async function submitCloudJob(request:Request,kind:Kind,hotspotInput?:unknown) {
 try {
  assertOrigin(request);const user=await requireUser(request,{requireIdentity:true});await shortLimit(user.id);
  let payload:JobInput;
  if(kind==="personal") {
   const form=await readBoundedFormData(request,request.signal);let raw:unknown;try{raw=JSON.parse(String(form.get("payload")));}catch{throw new AppError("INVALID_FORM","个人创作要求无法读取。",400);}
   const parsed=personalRequestSchema.safeParse(raw);if(!parsed.success)throw new AppError("INVALID_FORM",parsed.error.issues.find(i=>i.message.includes("风格"))?.message||"请检查经历、图片和已确认的提示词。",400);
   const images=await parseImageFiles(form,parsed.data.imageIds);payload={kind,input:await bindPersonalRules(parsed.data,user.id),images};
  } else if(kind==="video") {
   const parsed=videoRequestSchema.safeParse(await readJson(request,256*1024));if(!parsed.success)throw new AppError("INVALID_FORM","请检查输入长度、视频类型和时长。",400);
   const issue=inputIssue(parsed.data.input);if(issue)throw new AppError("INVALID_FORM",issue,400);
   if(parsed.data.action==="rewrite"&&(!parsed.data.current||!parsed.data.current.shots.some(s=>s.shotId===parsed.data.targetId)))throw new AppError("INVALID_FORM","找不到要重写的镜头。",400);
   payload={kind,input:parsed.data};
  } else if(kind==="style_extract") {
   const parsed=styleExtractRequestSchema.safeParse(await readJson(request,32*1024));if(!parsed.success)throw new AppError("INVALID_FORM","请输入不超过 6000 字的参考文案并选择有效的参考方向。",400);
   payload={kind,input:parsed.data};
  } else if(kind==="hotspots") {
   const raw=(hotspotInput ?? await readJson(request,16_384)) as {style?:unknown};const style=stylePreferencesSchema.safeParse(raw.style??PRESET_STYLES[0].preferences);if(!style.success)throw new AppError("INVALID_FORM","请检查风格要求。",400);
   const shared=await readShared();if(!shared.items.length)throw new AppError("NO_HOTSPOTS","当前没有可用热点，请先更新。",400);
   payload={kind,items:shared.items,version:shared.version,style:style.data};
  } else {
   const form=await readBoundedFormData(request,request.signal);let raw:unknown;try{raw=JSON.parse(String(form.get("payload")));}catch{throw new AppError("INVALID_FORM","创作要求无法读取，请重新提交。",400);}
   const upload=await parseUpload(form);
   if(kind==="generate"&&upload.mode==="demo")return Response.json({result:validateResult(createDemoResult(upload.imageIds),upload.imageIds),mode:"demo",meta:{durationMs:0,completedAt:new Date().toISOString()}},{headers:{"Cache-Control":"no-store"}});
   if(upload.mode!=="live")throw new AppError("INVALID_FORM","请使用真实生成模式。",400);
   if(kind==="generate")payload={kind,brief:upload.brief,images:upload.images,imageIds:upload.imageIds};
   else if(kind==="rewrite"){const p=rewriteRequestSchema.safeParse(raw);if(!p.success)throw new AppError("INVALID_FORM","请检查原正文、重写方向及补充要求。",400);payload={kind,brief:p.data.brief,body:p.data.body,direction:p.data.direction,instruction:p.data.instruction,images:upload.images,research:p.data.research};}
   else {const p=partialRewriteRequestSchema.safeParse(raw);if(!p.success)throw new AppError("INVALID_FORM","请检查内容、图片对应关系和重写要求。",400);payload={kind:"partial",input:p.data,images:upload.images};}
  }
  const selection=await selectProfile(user.id,request.headers.get('X-AI-Profile'));
  await createProvider(selection);
  payload={...payload,aiSnapshot:await seal(selection,user.id)};
  const job=await enqueue(user.id,requestId(request),payload,request.signal);
  return Response.json({jobId:job.id,state:"queued"},{status:202,headers:{"Cache-Control":"no-store"}});
 }catch(error){return cloudError(error);}
}

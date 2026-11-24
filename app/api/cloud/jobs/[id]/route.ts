import { isCloudMode } from "@/lib/cloud/mode";
import { assertOrigin, cloudError } from "@/lib/cloud/server/config";
import { requireUser } from "@/lib/cloud/server/auth";
import { cancelJob, jobState } from "@/lib/cloud/server/jobs";
import { AppError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/server/guard";
export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{if(!isCloudMode())throw new AppError("NOT_FOUND","任务不存在。",404);const user=await requireUser(request,{requireIdentity:true});checkRateLimit(`cloud_job_poll:${user.id}`,120);return Response.json(await jobState(user.id,(await params).id),{headers:{"Cache-Control":"no-store"}});}catch(error){return cloudError(error);}}
export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){try{if(!isCloudMode())throw new AppError("NOT_FOUND","任务不存在。",404);assertOrigin(request);const user=await requireUser(request,{requireIdentity:true});return Response.json(await cancelJob(user.id,(await params).id),{headers:{"Cache-Control":"no-store"}});}catch(error){return cloudError(error);}}

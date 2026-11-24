import { createHash,timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { isCloudMode } from "@/lib/cloud/mode";
import { cloudConfig,cloudError } from "@/lib/cloud/server/config";
import { cleanupCloudJobs,cleanupJobUploads } from "@/lib/cloud/server/jobs";
import { getDataService } from "@/lib/cloud/server/data";
import { recordCron,updateCloudHotspots } from "@/lib/cloud/server/hotspots";
import { cleanupExpiredAuthRecords } from "@/lib/cloud/server/auth";
export const runtime="nodejs";
export async function POST(request:Request){try{if(!isCloudMode())throw new AppError("NOT_FOUND","请求不存在。",404);const expected=cloudConfig().cronSecret,provided=request.headers.get("authorization")?.replace(/^Bearer /," ").trim()||"";const hash=(s:string)=>createHash("sha256").update(s).digest();if(expected.length<32||!timingSafeEqual(hash(expected),hash(provided)))throw new AppError("UNAUTHORIZED","定时请求未授权。",401);await recordCron();await updateCloudHotspots(false);const assets=await (await getDataService()).cleanup(Date.now(),4);const uploads=await cleanupJobUploads();const jobs=await cleanupCloudJobs();const auth=await cleanupExpiredAuthRecords();return Response.json({ok:true,assets,uploads,jobs,auth},{headers:{"Cache-Control":"no-store"}});}catch(error){return cloudError(error);}}

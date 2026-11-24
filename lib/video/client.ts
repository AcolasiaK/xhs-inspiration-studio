import { cloudJobFetch } from "../cloud/jobs-client";
import { isCloudClient } from "../cloud/client";
import { aiSourceHeader, getAiSource } from "../ai-source";
import { videoPlanSchema,shotSchema,validateShot,validateVideoPlan,type VideoRequest } from "./schema";
export async function requestVideo(request:VideoRequest,accessToken:string,controller:AbortController,timeoutMs:number,source=getAiSource()){
 const timeout=AbortSignal.timeout(isCloudClient()?600_000:timeoutMs),signal=AbortSignal.any([controller.signal,timeout]);
 try{
  const response=await (isCloudClient()?cloudJobFetch:fetch)("/api/video",{method:"POST",headers:{"Content-Type":"application/json",...aiSourceHeader(source),...(accessToken.trim()?{"X-Access-Token":accessToken.trim()}:{})},body:JSON.stringify(request),signal});
  const data=await response.json().catch(()=>null);
  if(signal.aborted)throw new Error("ABORTED");
  if(!response.ok){const message=data?.error?.message;throw new Error(typeof message==="string"?message:response.status===502?"AI 服务返回异常（HTTP 502），请稍后重试。":`请求失败（HTTP ${response.status}）。`);}
  if(request.action==="rewrite"){
   if(!request.current)throw new Error("原镜头已不存在。");
   return {shot:validateShot(request.input,request.current,request.targetId,shotSchema.parse(data?.shot))};
  }
  const plan=validateVideoPlan(request.input,videoPlanSchema.parse(data?.plan));
  if(!Number.isFinite(data?.meta?.durationMs)||typeof data?.meta?.completedAt!=="string")throw new Error("返回结果缺少完成信息。");
  return {plan,meta:{durationMs:data.meta.durationMs as number,completedAt:data.meta.completedAt as string}};
 }catch(error){
  if(controller.signal.aborted)throw new Error("本次请求已取消，已有内容仍保留。");
  if(timeout.aborted)throw new Error("视频策划等待超时，已有内容仍保留。请稍后重试。");
  if(error instanceof TypeError)throw new Error("网络连接失败，已有内容仍保留。请检查网络后重试。");
  if(error instanceof Error&&error.name==="ZodError")throw new Error("返回结果不完整，已有内容仍保留。");
  throw error;
 }
}

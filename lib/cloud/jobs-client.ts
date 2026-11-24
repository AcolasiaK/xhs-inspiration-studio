import { cloudFetch, isCloudClient } from "./client";
const WAIT_MS=600_000;
function wait(ms:number,signal?:AbortSignal|null) {return new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new DOMException("aborted","AbortError"));return;}const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},ms);function abort(){clearTimeout(timer);reject(new DOMException("aborted","AbortError"));}signal?.addEventListener("abort",abort,{once:true});});}
/** In local mode use ordinary fetch; in cloud mode submit once and poll an owner-scoped durable job. */
export async function cloudJobFetch(input:RequestInfo|URL,init:RequestInit={}) {
 if(!isCloudClient())return fetch(input,init);
 const headers=new Headers(init.headers);const requestId=headers.get("X-Client-Request-Id")||crypto.randomUUID();headers.set("X-Client-Request-Id",requestId);
 let response:Response;
 try { response=await cloudFetch(input,{...init,headers}); }
 catch(error) {
  // A dropped submission response may still have created a job; use the same id to cancel it.
  void cloudFetch(`/api/cloud/jobs/${encodeURIComponent(requestId)}`,{method:"DELETE",keepalive:true}).catch(()=>undefined);
  throw error;
 }
 if(response.status!==202)return response;
 const accepted=await response.json();const id=accepted?.jobId;if(typeof id!=="string"||!/^[-0-9a-f]{36}$/i.test(id))throw new Error("后台任务创建失败，原内容仍保留。");
 const deadline=Date.now()+WAIT_MS;let completed=false;
 try{
  while(Date.now()<deadline){
   await wait(1200,init.signal);const r=await cloudFetch(`/api/cloud/jobs/${encodeURIComponent(id)}`,{signal:init.signal});const data=await r.json().catch(()=>null);
   if(!r.ok)return Response.json({error:data?.error??{message:"无法读取任务状态，原内容仍保留。"}},{status:r.status});
   if(data?.state==="succeeded"){completed=true;return Response.json(data.result,{status:200});}
   if(data?.state==="failed"||data?.state==="cancelled"){completed=true;return Response.json({error:data?.error??{code:"CANCELLED",message:"任务已取消，原内容仍保留。"}},{status:data?.error?.status||499});}
   if(data?.state!=="queued"&&data?.state!=="running")throw new Error("任务状态无法识别，原内容仍保留。");
  }
  throw new Error("等待后台任务超时，原内容仍保留。可以稍后重新查看。");
 }finally{
  // Cancellation cannot promise that an already-dispatched model request incurs no cost.
  if(!completed)void cloudFetch(`/api/cloud/jobs/${encodeURIComponent(id)}`,{method:"DELETE",keepalive:true}).catch(()=>undefined);
 }
}

import { unseal, type Sealed } from "@/lib/server/ai/store";
import type { Snapshot, AiSource } from "@/lib/server/ai/selection";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { getRepository, type Transaction } from "./repository";
import { getBlobs } from "./blobs";
import { generateContent, GenerationStageError, type FailureSource, type GenerationStage } from "@/lib/server/openai";
import { rewriteBody } from "@/lib/server/rewrite";
import { partialRewrite } from "@/lib/server/partial-rewrite";
import { generateVideo } from "@/lib/server/video";
import { generateHotspotSuggestions } from "@/lib/server/hotspots-ai";
import { extractStyle } from "@/lib/server/style-extract";
import type { StyleExtractRequest } from "@/lib/style-extract-schema";
import type { TravelResearch } from "@/lib/travel-research";
import type { Brief } from "@/lib/schema";
import type { RewriteDirection } from "@/lib/rewrite-schema";
import type { PartialRewriteRequest } from "@/lib/partial-rewrite-schema";
import type { VideoRequest } from "@/lib/video/schema";
import type { Hotspot } from "@/lib/server/hotspots-types";
import type { StylePreferences } from "@/lib/styles";
import { cloudHotspotState, storeSuggestionsInTransaction } from "./hotspots";
import { cloudConfig } from "./config";
import { searchTravelInfo } from "@/lib/server/travel-search";
import { atWorkerStage, classifyWorkerError, workerLogLine, type WorkerStage } from "./worker-diagnostics";
import type { PersonalRequest } from "@/lib/personal/schema";
import { runPersonal } from "@/lib/server/personal";

export type Kind = "generate" | "rewrite" | "partial" | "video" | "hotspots" | "style_extract" | "personal";
type Images = {id:string;dataUrl:string}[];
type BusinessInput = { kind:"generate"; brief:Brief; images:Images; imageIds:string[] } | {kind:"rewrite";brief:Brief;body:string;direction:RewriteDirection;instruction:string;images:Images;research?:TravelResearch} | {kind:"partial";input:PartialRewriteRequest;images:Images} | {kind:"video";input:VideoRequest} | {kind:"hotspots";items:Hotspot[];style:StylePreferences;version:string} | {kind:"style_extract"; input:StyleExtractRequest} | {kind:"personal";input:PersonalRequest;images:Images};
export type JobInput = BusinessInput & {aiSnapshot?: Sealed};
export type State = "queued"|"running"|"succeeded"|"failed"|"cancelled";
type JobError = {code:string;message:string;status:number;requestId:string;stage?:GenerationStage;source?:FailureSource;providerStatus?:number};
type Job = { id:string;owner:string;kind:Kind;state:State;digest:string;inputRef:string;inputIntentId?:string;resultRef?:string;resultIntentId?:string;createdAt:number;startedAt?:number;finishedAt?:number;leaseUntil?:number;lease?:string;expiresAt?:number;error?:JobError | {code:string;message:string;status:number} };
const ACTIVE="active-job", LIMIT=180_000, LEASE=210_000, QUEUE=300_000;
const KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const idFor=(owner:string,id:string)=>`${owner}:${id.toLowerCase()}`;
const hash=(data:Buffer)=>createHash("sha256").update(data).digest("hex");
const STAGES=new Set<GenerationStage>(["initial_request","initial_validation","tag_repair_request","tag_validation"]);
const SOURCES=new Set<FailureSource>(["provider_http","transport_or_response","model_output_validation","request_budget","request_cancel","application"]);
function safeStatus(error:unknown,requestId:string,timeout=false):JobError {
  if(timeout)return {code:"TIMEOUT",message:"后台处理达到总时限，原内容仍保留，请稍后重试。",status:504,requestId,source:"request_budget"};
  if(error instanceof AppError){const safeCodes=new Set(["VISION_UNSUPPORTED","STRUCTURED_UNSUPPORTED","VISION_UNVERIFIED","PROTOCOL_UNSUPPORTED","UNSAFE_ADDRESS","NETWORK_CONFIG","AI_PROXY_UNAVAILABLE","DNS_RESOLUTION_FAILED","DNS_LOOKUP_FAILED","TIMEOUT","PROVIDER_UNAVAILABLE","INVALID_KEY","INVALID_KEY_FORMAT","PROVIDER_QUOTA","PROVIDER_LIMIT","MODEL_UNAVAILABLE","INVALID_BASE_URL","ENDPOINT_NOT_FOUND","ENDPOINT_REDIRECT","PROVIDER_INCOMPATIBLE","PROVIDER_NETWORK","NOT_CONFIGURED","INVALID_FORM","INVALID_RESULT","HASHTAG_COUNT","CONSTRAINT_FAILED","REFUSAL","INCOMPLETE","CANCELLED","NO_HOTSPOTS","STALE_HOTSPOTS"]);if(safeCodes.has(error.code)){
    const result:JobError={code:error.code,message:error.message.slice(0,500),status:Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:502,requestId};
    if(error instanceof GenerationStageError){if(STAGES.has(error.stage))result.stage=error.stage;if(SOURCES.has(error.source))result.source=error.source;if(Number.isInteger(error.providerStatus)&&error.providerStatus!>=100&&error.providerStatus!<=599)result.providerStatus=error.providerStatus;}
    return result;
  }}
  return {code:"GENERATION_FAILED",message:"后台生成暂时失败，原内容仍保留，请稍后重试。",status:502,requestId};
}
// 只接受内部固定状态和已经校验过的 UUID；不输出输入、结果、原始异常或身份信息。
function logJob(job:Pick<Job,"id"|"kind"|"createdAt">,status:"queued"|"running"|"succeeded"|"failed"|"cancelled",extra?:JobError) {
  if(!KEY.test(job.id))return;
  const elapsed=Math.max(0,Math.round(Date.now()-job.createdAt));
  const stage=extra?.stage??(status==="failed"&&extra?.source==="request_budget"?"job_timeout":"job");
  console.info(`[cloud_job] requestId=${job.id} kind=${job.kind} status=${status} stage=${stage} code=${extra?.code??"NONE"} source=${extra?.source??"none"} providerStatus=${extra?.providerStatus??"none"} elapsedMs=${elapsed}`);
}
export async function shortLimit(owner:string) {
  const db=await getRepository(), now=Date.now();
  await db.transaction(async tx=>{
    const key=`requests:${owner}`, r=await tx.get<{start:number;count:number}>("rate",key);
    const next=!r||now-r.start>=60_000?{start:now,count:1}:{...r,count:r.count+1};
    if(next.count>30)throw new AppError("RATE_LIMIT","操作有些频繁，请稍等一分钟再试。",429);
    await tx.put("rate",key,next,owner);
  });
}
async function removeIfExists(tx:Transaction,bucket:string,id:string){if(await tx.get(bucket,id))await tx.remove(bucket,id);}
async function clearActive(tx:Transaction,owner:string,id:string) { const active=await tx.get<{id:string}>(ACTIVE,owner);if(active?.id===id)await tx.remove(ACTIVE,owner); }
async function finishJob(tx:Transaction,job:Job,now:number){
 const key=idFor(job.owner,job.id);await tx.put("jobs",key,{...job,expiresAt:now+24*60*60_000},job.owner);
 if(job.inputIntentId){const intentKey=`${job.owner}:${job.inputIntentId}`,intent=await tx.get<UploadIntent>("job-uploads",intentKey);if(intent?.state==="linked")await tx.put("job-uploads",intentKey,{...intent,expiresAt:now+15*60_000},job.owner);}
 await removeIfExists(tx,"job-queue",key);await removeIfExists(tx,"job-reap",key);await clearActive(tx,job.owner,job.id);
}
async function expire(tx:Transaction,job:Job,now:number) {
  if((job.state==="running"&&now>(job.leaseUntil??0))||(job.state==="queued"&&now-job.createdAt>QUEUE)) {
    const next:Job={...job,state:"failed",finishedAt:now,expiresAt:now+24*60*60_000,error:{code:"TIMEOUT",message:"后台处理未能完成，原内容仍保留。请稍后手动重试。",status:504}};
    await finishJob(tx,next,now);return next;
  }
  return job;
}
type UploadIntent={id:string;owner:string;jobId:string;kind:"input"|"result";state:"uploading"|"ready"|"linked"|"deleting"|"deleted";createdAt:number;expiresAt?:number;ref?:string;lease?:string;leaseUntil?:number};
async function prepareObject(owner:string,jobId:string,kind:"input"|"result",bytes:Buffer){
  const db=await getRepository(),blobs=await getBlobs(),id=randomUUID(),key=`${owner}:${id}`;
  const now=Date.now(),intent:UploadIntent={id,owner,jobId,kind,state:"uploading",createdAt:now,expiresAt:now+60*60_000};
  await db.put("job-uploads",key,intent,owner);
  const ref=await blobs.put(`jobs/${owner}/${jobId}-${kind}-${id}.json`,bytes);
  // Persist the receipt before linking. Failed or uncertain transactions retain the private object.
  await db.transaction(async tx=>{const current=await tx.get<UploadIntent>("job-uploads",key);if(!current||current.state!=="uploading")throw new AppError("UPLOAD_EXPIRED","任务上传已过期，请重试。",409);await tx.put("job-uploads",key,{...current,state:"ready",ref},owner);});
  return {id,ref};
}
async function linkObject(tx:Transaction,owner:string,intentId:string,ref:string,expiresAt?:number){
  const key=`${owner}:${intentId}`,intent=await tx.get<UploadIntent>("job-uploads",key);
  if(!intent||intent.owner!==owner||intent.state!=="ready"||intent.ref!==ref)throw new AppError("UPLOAD_EXPIRED","任务上传已过期，请重试。",409);
  const linked:UploadIntent={...intent,state:"linked"};if(expiresAt===undefined)delete linked.expiresAt;else linked.expiresAt=expiresAt;await tx.put("job-uploads",key,linked,owner);
}
async function snapshotIdentity(value:Sealed,owner:string){const s=await unseal<Snapshot>(value,owner);return {id:s.profile?.id,revision:s.profile?.revision};}
export async function enqueue(owner:string,id:string,payload:JobInput,signal?:AbortSignal) {
  if(signal?.aborted)throw new AppError("CANCELLED","请求已取消，原内容仍保留。",499);
  if(!KEY.test(id))throw new AppError("INVALID_FORM","请求编号不正确，请刷新后重试。");
  const db=await getRepository(),bytes=Buffer.from(JSON.stringify(payload));
  if(bytes.length>6*1024*1024)throw new AppError("TOO_LARGE","图片与要求过大，请减少图片。",413);
  // GCM uses a fresh IV per submission. Hash the selected identity/revision, not its random ciphertext.
  const digestInput=payload.aiSnapshot?{...payload,aiSnapshot:await snapshotIdentity(payload.aiSnapshot,owner)}:payload;
  const digest=hash(Buffer.from(JSON.stringify(digestInput))),key=idFor(owner,id);
  // Reject the usual repeated/busy case before allocating a private upload.
  const existing=await db.transaction(async tx=>{
    const old=await tx.get<Job>("jobs",key);if(old){if(old.digest!==digest||old.kind!==payload.kind)throw new AppError("CONFLICT","请求编号已被其他内容使用，请重新发起。",409);return true;}
    const active=await tx.get<{id:string}>(ACTIVE,owner);if(active){const current=await tx.get<Job>("jobs",idFor(owner,active.id));if(current){const resolved=await expire(tx,current,Date.now());if(resolved.state==="queued"||resolved.state==="running")throw new AppError("BUSY","已有生成正在处理中，请等待结束后再操作。",409);}else await tx.remove(ACTIVE,owner);}return false;
  });
  if(existing){wakeCloudWorker();return {id:id.toLowerCase(),duplicate:true};}
  const upload=await prepareObject(owner,id.toLowerCase(),"input",bytes);let duplicate=false;
  // A failed/ambiguous commit leaves the intent and private object for safe deferred cleanup.
  await db.transaction(async tx=>{
    if(signal?.aborted)throw new AppError("CANCELLED","请求已取消，原内容仍保留。",499);
    const now=Date.now(),old=await tx.get<Job>("jobs",key);
    if(old){if(old.digest!==digest||old.kind!==payload.kind)throw new AppError("CONFLICT","请求编号已被其他内容使用，请重新发起。",409);duplicate=true;return;}
    const active=await tx.get<{id:string}>(ACTIVE,owner);
    if(active){const current=await tx.get<Job>("jobs",idFor(owner,active.id));if(current){const resolved=await expire(tx,current,now);if(resolved.state==="queued"||resolved.state==="running")throw new AppError("BUSY","已有生成正在处理中，请等待结束后再操作。",409);}else await tx.remove(ACTIVE,owner);}
    const rate=await tx.get<{start:number;count:number}>("rate",`generate:${owner}`);
    const next=!rate||now-rate.start>=60_000?{start:now,count:1}:{...rate,count:rate.count+1};
    if(next.count>6)throw new AppError("RATE_LIMIT","操作过于频繁，请稍等一分钟再试。",429);
    await linkObject(tx,owner,upload.id,upload.ref);
    const job:Job={id:id.toLowerCase(),owner,kind:payload.kind,state:"queued",digest,inputRef:upload.ref,inputIntentId:upload.id,createdAt:now};
    await tx.put("rate",`generate:${owner}`,next,owner);await tx.put("jobs",key,job,owner);await tx.put("job-queue",key,{id:job.id,owner,expiresAt:now},owner);await tx.put(ACTIVE,owner,{id:job.id},owner);
  });
  if(!duplicate)logJob({id:id.toLowerCase(),kind:payload.kind,createdAt:Date.now()},"queued");
  wakeCloudWorker();return {id:id.toLowerCase(),duplicate};
}
export async function jobState(owner:string,id:string) {
  if(!KEY.test(id))throw new AppError("NOT_FOUND","任务不存在。",404);
  const db=await getRepository(),key=idFor(owner,id),initial=await db.get<Job>("jobs",key);if(!initial||initial.owner!==owner)throw new AppError("NOT_FOUND","任务不存在。",404);
  // Normal polling is read-only; open a transaction only if the job actually needs to expire.
  const now=Date.now(),needsExpiry=(initial.state==="running"&&now>(initial.leaseUntil??0))||(initial.state==="queued"&&now-initial.createdAt>QUEUE);
  const job=needsExpiry?await db.transaction(async tx=>{const j=await tx.get<Job>("jobs",key);if(!j||j.owner!==owner)throw new AppError("NOT_FOUND","任务不存在。",404);return expire(tx,j,Date.now());}):initial;
  if(job.state==="succeeded"&&job.resultRef){const bytes=await (await getBlobs()).get(job.resultRef);const value=JSON.parse(bytes.toString("utf8"));if(job.kind==="hotspots"){return {id:job.id,state:job.state,result:await cloudHotspotState(owner,value.version)};}return {id:job.id,state:job.state,result:value};}
  return {id:job.id,state:job.state,...(job.error?{error:job.error}:{})};
}
export async function cancelJob(owner:string,id:string) {
  if(!KEY.test(id))throw new AppError("NOT_FOUND","任务不存在。",404);
  const db=await getRepository();const result=await db.transaction(async tx=>{const key=idFor(owner,id),job=await tx.get<Job>("jobs",key);if(!job||job.owner!==owner)throw new AppError("NOT_FOUND","任务不存在。",404);if(job.state==="queued"||job.state==="running"){const now=Date.now();await finishJob(tx,{...job,state:"cancelled",finishedAt:now},now);return {state:"cancelled" as const,job};}return {state:job.state,job:null};});if(result.job)logJob(result.job,"cancelled");return {state:result.state};
}
type ExecutionSignals={timeoutSignal:AbortSignal;cancelSignal:AbortSignal};
export type Execute = (input:JobInput,signal:AbortSignal,owner:string,requestId:string,signals?:ExecutionSignals)=>Promise<unknown>;
export const execute:Execute=async(input,signal,_owner,requestId,signals)=>{
  const start=performance.now(), meta=()=>({durationMs:Math.round(performance.now()-start),completedAt:new Date().toISOString()});
  const selected:AiSource=input.aiSnapshot?await unseal<Snapshot>(input.aiSnapshot,_owner):'relay';
  switch(input.kind){
    case "generate": {
      // 独立传递用户/租约取消和 worker 时限，避免总时限被误记为用户取消。
      const deadline=signals?.timeoutSignal ?? AbortSignal.timeout(LIMIT);
      const research=input.brief.creationTypes.includes("travel") ? await searchTravelInfo({place:input.brief.travelSearchPlace,enabled:input.brief.travelSearch,signal}) : undefined;
      const result=await generateContent(input.brief,input.images,signals?.cancelSignal ?? signal,requestId,{signal:deadline,startedAt:start,maxDurationMs:LIMIT,modelTimeoutMs:150_000},research,selected);return {result,mode:"live",meta:meta(),...(research?{research}:{})};
    }
    case "rewrite": return {body:await rewriteBody(input.brief,input.body,input.direction,input.instruction,input.images,signal,input.research,selected),meta:meta()};
    case "partial": return {result:await partialRewrite(input.input,input.images,signal,selected),meta:meta()};
    case "video": return {...await generateVideo(input.input,signal,selected),meta:meta()};
    case "hotspots": {const ideas=await generateHotspotSuggestions(input.items,input.style,signal,selected);return {version:input.version,ideas};}
    case "style_extract": return {preferences:await extractStyle(input.input,signal,selected)};
    case "personal": return {...await runPersonal(input.input,input.images,signal,selected,_owner,'queued'),meta:meta()};
  }
};
/** Claim is durable: a dispatched job is never put back into the queue after a crash. */
export async function runOne(executor:Execute=execute):Promise<boolean> {
  const db=await atWorkerStage("repository_init",()=>getRepository()),blobs=await atWorkerStage("storage_init",()=>getBlobs()),now=Date.now();
  type Pointer={id:string;owner:string;expiresAt:number};
  const expired=await atWorkerStage("queue_read",()=>db.scanExpired<Pointer>("job-reap",now,1));
  if(expired.length){const pointer=expired[0].value;await atWorkerStage("queue_claim",()=>db.transaction(async tx=>{const key=idFor(pointer.owner,pointer.id),j=await tx.get<Job>("jobs",key);if(j?.state==="running")await expire(tx,j,now);else await removeIfExists(tx,"job-reap",key);}));return true;}
  const waiting=await atWorkerStage("queue_read",()=>db.scanExpired<Pointer>("job-queue",now,1));if(!waiting.length)return false;const candidate=waiting[0].value;
  const lease=randomUUID();
  const claimed=await atWorkerStage("queue_claim",()=>db.transaction(async tx=>{const key=idFor(candidate.owner,candidate.id),j=await tx.get<Job>("jobs",key);if(!j){await removeIfExists(tx,"job-queue",key);return null;}const resolved=await expire(tx,j,Date.now());if(resolved.state!=="queued"){await removeIfExists(tx,"job-queue",key);return null;}const started=Date.now(),next:Job={...resolved,state:"running",startedAt:started,lease,leaseUntil:started+LEASE};await tx.put("jobs",key,next,j.owner);await removeIfExists(tx,"job-queue",key);await tx.put("job-reap",key,{id:j.id,owner:j.owner,expiresAt:started+LEASE},j.owner);return next;}));
  if(!claimed)return true;
  logJob(claimed,"running");
  const workerStartedAt=performance.now(),timeout=AbortSignal.timeout(LIMIT), cancelled=new AbortController(), signal=AbortSignal.any([timeout,cancelled.signal]);let onAbort:(()=>void)|undefined;
  const timedOut=()=>timeout.aborted||performance.now()-workerStartedAt>=LIMIT;
  const assertActive=()=>{if(timedOut())throw new AppError("TIMEOUT","后台处理达到总时限。",504);if(cancelled.signal.aborted)throw new AppError("CANCELLED","请求已取消。",499);};
  let checking=false,lastReadFailureLog=0;
  const watch=setInterval(()=>{
    if(checking)return;
    checking=true;
    void db.get<Job>("jobs",idFor(claimed.owner,claimed.id)).then(j=>{
      if(!j||j.state!=="running"||j.lease!==lease)cancelled.abort();
    }).catch(()=>{
      // 临时存储读取失败不能证明用户取消；保留任务并在下轮重试状态检查。
      const now=Date.now();if(now-lastReadFailureLog>=30_000){lastReadFailureLog=now;console.warn(`[cloud_job] requestId=${claimed.id} kind=${claimed.kind} status=running stage=state_check code=STATE_READ_FAILED elapsedMs=${Math.max(0,now-claimed.createdAt)}`);}
    }).finally(()=>{checking=false;});
  },2000);watch.unref();
  try {
    const raw=await blobs.get(claimed.inputRef);assertActive();const input=JSON.parse(raw.toString("utf8")) as JobInput;
    const latest=await db.get<Job>("jobs",idFor(claimed.owner,claimed.id));assertActive();if(latest?.state!=="running"||latest.lease!==lease)return true;
    const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(new AppError("CANCELLED","请求已取消。",499));if(signal.aborted)onAbort();else signal.addEventListener("abort",onAbort,{once:true});});
    const output=await Promise.race([executor(input,signal,claimed.owner,claimed.id,{timeoutSignal:timeout,cancelSignal:cancelled.signal}),aborted]);
    assertActive();
    const bytes=Buffer.from(JSON.stringify(output));if(bytes.length>2*1024*1024)throw new AppError("INVALID_RESULT","生成结果过大，请缩短要求。",502);
    assertActive();
    const outputObject=await prepareObject(claimed.owner,claimed.id,"result",bytes);
    assertActive();
    let committed=false;
    await db.transaction(async tx=>{assertActive();const j=await tx.get<Job>("jobs",idFor(claimed.owner,claimed.id));assertActive();if(j?.state!=="running"||j.lease!==lease||Date.now()>(j.leaseUntil??0))return;if(input.kind==="hotspots"){const o=output as {version:string;ideas:import("@/lib/server/hotspots-types").HotspotSuggestion[]};await storeSuggestionsInTransaction(tx,j.owner,o.version,o.ideas);assertActive();}const finished=Date.now();await linkObject(tx,j.owner,outputObject.id,outputObject.ref,finished+24*60*60_000);assertActive();await finishJob(tx,{...j,state:"succeeded",resultRef:outputObject.ref,resultIntentId:outputObject.id,finishedAt:finished},finished);assertActive();committed=true;});
    // Unlinked outputs are cleaned later after a transactional reference check.
    if(committed)logJob(claimed,"succeeded");
  } catch(error) {
    const safe=safeStatus(error,claimed.id,timedOut());let committed=false;
    await db.transaction(async tx=>{const j=await tx.get<Job>("jobs",idFor(claimed.owner,claimed.id));if(j?.state!=="running"||j.lease!==lease)return;const finished=Date.now();await finishJob(tx,{...j,state:"failed",error:safe,finishedAt:finished},finished);committed=true;});
    if(committed)logJob(claimed,"failed",safe);
  } finally { clearInterval(watch);if(onAbort)signal.removeEventListener("abort",onAbort); }
  return true;
}
/** First claim the intent transactionally; a job can link only a ready intent, never one being deleted. */
async function retireUpload(owner:string,intentId:string,now:number):Promise<"deleted"|"busy"|"failed"> {
 const db=await getRepository(),blobs=await getBlobs(),key=`${owner}:${intentId}`,lease=randomUUID();
 const candidate=await db.transaction(async tx=>{
  const current=await tx.get<UploadIntent>("job-uploads",key);if(!current)return null;
  if(current.state==="deleted")return current;
  if(current.state==="deleting"&&(current.leaseUntil??0)>now)return null;
  const job=await tx.get<Job>("jobs",idFor(owner,current.jobId));
  if(current.state==="linked"||(current.state==="deleting"&&job)){
   if(job&&(job.state==="queued"||job.state==="running"))return null;
   const minAge=current.kind==="result"?24*60*60_000:15*60_000;
   if(job?.finishedAt&&now-job.finishedAt<minAge)return null;
  } else if(now-current.createdAt<60*60_000)return null;
  const next:UploadIntent={...current,state:"deleting",lease,leaseUntil:now+60_000,expiresAt:now+60_000};await tx.put("job-uploads",key,next,owner);return next;
 });
 if(!candidate)return "busy";if(candidate.state==="deleted")return "deleted";
 try {
  if(candidate.ref)await blobs.remove(candidate.ref);
  await db.transaction(async tx=>{const current=await tx.get<UploadIntent>("job-uploads",key);if(current?.state==="deleting"&&current.lease===lease){const deleted:UploadIntent={...current,state:"deleted"};delete deleted.expiresAt;await tx.put("job-uploads",key,deleted,owner);}});return "deleted";
 }catch{return "failed";}
}
/** Clean abandoned uploads and terminal job inputs in bounded batches; failures remain retryable. */
export async function cleanupJobUploads(now=Date.now(),limit=4){
 const db=await getRepository(),rows=await db.scanExpired<UploadIntent>("job-uploads",now,limit);let removed=0,failed=0;
 for(const {value:i} of rows){
  if(removed+failed>=limit)break;const result=await retireUpload(i.owner,i.id,now);if(result==="deleted")removed++;else if(result==="failed")failed++;
 }
 return {removed,failed};
}
/** Retain results for 24 hours; do not drop metadata while a private object still needs deletion. */
export async function cleanupCloudJobs(now=Date.now()){
 const db=await getRepository(),blobs=await getBlobs(),rows=await db.scanExpired<Job>("jobs",now,4);let removed=0,failed=0;
 for(const {value:j} of rows){
  try{
   for(const [intentId,ref] of [[j.inputIntentId,j.inputRef],[j.resultIntentId,j.resultRef]] as const){
    if(intentId){const state=await retireUpload(j.owner,intentId,now);if(state!=="deleted")throw new Error("UPLOAD_CLEANUP_PENDING");}
    else if(ref)await blobs.remove(ref);
   }
   await db.transaction(async tx=>{const current=await tx.get<Job>("jobs",idFor(j.owner,j.id));if(current&&current.finishedAt===j.finishedAt&&current.state===j.state){await tx.remove("jobs",idFor(j.owner,j.id));if(j.inputIntentId)await tx.remove("job-uploads",`${j.owner}:${j.inputIntentId}`);if(j.resultIntentId)await tx.remove("job-uploads",`${j.owner}:${j.resultIntentId}`);}});removed++;
  }catch{failed++;await db.transaction(async tx=>{const current=await tx.get<Job>("jobs",idFor(j.owner,j.id));if(current&&current.finishedAt===j.finishedAt&&current.state===j.state)await tx.put("jobs",idFor(j.owner,j.id),{...current,expiresAt:now+60_000},j.owner);}).catch(()=>undefined);}
 }
 return {removed,failed};
}
export type Worker = { wake:()=>void; stop:()=>void };
/** Immediate wake on enqueue; a 30-second fallback recovers work after restarts or in other instances. */
export function createCloudWorker(run:()=>Promise<boolean>,intervalMs=30_000,check?:()=>void):Worker {
 let busy=false,pending=false,stopped=false,retry:ReturnType<typeof setTimeout>|undefined;
 const stop=()=>{stopped=true;pending=false;clearInterval(timer);if(retry)clearTimeout(retry);};
 async function tick(){
  if(stopped)return;if(busy){pending=true;return;}busy=true;let failed=false;let stage:WorkerStage="configuration";const started=performance.now();
  try{check?.();stage="poll";do{pending=false;if(await run())pending=true;}while(pending&&!stopped);}
  catch(error){
   failed=true;const diagnostic=classifyWorkerError(error,stage),line=workerLogLine(diagnostic,performance.now()-started);
   if(diagnostic.category==="configuration"){stop();console.warn(line);}else console.error(line);
  }
  finally{
   busy=false;
   if(pending&&!stopped){if(failed){retry=setTimeout(()=>void tick(),1000);retry.unref();}else void tick();}
  }
 }
 const timer=setInterval(()=>{pending=true;void tick();},intervalMs);timer.unref();
 pending=true;void tick();
 return {wake(){if(stopped)return;pending=true;void tick();},stop};
}
type WorkerGlobal=typeof globalThis & {__xhsWorker?:Worker};
export function wakeCloudWorker(){(globalThis as WorkerGlobal).__xhsWorker?.wake();}
export function startCloudWorker() {
 const g=globalThis as WorkerGlobal;
 if(!g.__xhsWorker)g.__xhsWorker=createCloudWorker(runOne,30_000,()=>{
  const config=cloudConfig();
  if(config.backend==="cloudbase"&&!process.env.CLOUDBASE_ENV_ID)throw new AppError("CLOUD_ENV_MISSING","云环境尚未配置。",503);
 });
}

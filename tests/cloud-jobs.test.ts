import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue,jobState,cancelJob,runOne,execute,cleanupCloudJobs,cleanupJobUploads,type JobInput } from "../lib/cloud/server/jobs";
import { getRepository } from "../lib/cloud/server/repository";
import { cloudHotspotState,updateCloudHotspots } from "../lib/cloud/server/hotspots";
import { AppError } from "../lib/errors";
import { emptyBrief } from "../lib/schema";
import { createDemoResult } from "../lib/demo";
import { GenerationStageError } from "../lib/server/openai";
import { videoInput } from "./video-fixture";
import { HOTSPOT_SOURCE_KEY } from "../lib/hotspot-metadata";
import { HotspotSourceError } from "../lib/server/hotspots-source";
import type { Hotspot } from "../lib/server/hotspots-types";
const original={...process.env};let dir="";
before(async()=>{dir=await mkdtemp(join(tmpdir(),"xhs-cloud-jobs-"));process.env={...process.env,APP_MODE:"cloud",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",APP_ORIGIN:"http://127.0.0.1:3002",CLOUD_SQLITE_PATH:join(dir,"test.db"),CLOUD_BLOB_PATH:join(dir,"blobs")};});
after(async()=>{process.env=original;await rm(dir,{recursive:true,force:true});});
const payload=():JobInput=>({kind:"video",input:{action:"generate",input:videoInput(),current:null,targetId:"",instruction:"测试要求"}});
const a=randomUUID(),b=randomUUID();

test("同一请求幂等、不同请求只允许每人一个活动任务，任务归属隔离",async()=>{
 const id=randomUUID();assert.equal((await enqueue(a,id,payload())).duplicate,false);assert.equal((await enqueue(a,id,payload())).duplicate,true);
 const changed=payload();if(changed.kind==="video")changed.input.instruction="不同内容";await assert.rejects(enqueue(a,id,changed),/编号/);
 await assert.rejects(enqueue(a,randomUUID(),payload()),/正在处理中/);await assert.rejects(jobState(b,id),/不存在/);await assert.rejects(cancelJob(b,id),/不存在/);
 const job=await jobState(a,id);assert.equal(job.state,"queued");const copy={plan:"模拟结果"};let calls=0;
 assert.equal(await runOne(async()=>{calls++;return copy;}),true);assert.equal(calls,1);assert.deepEqual((await jobState(a,id)).result,copy);assert.equal((await jobState(a,id)).state,"succeeded");
});

test("多 worker 原子领取，取消后迟到结果不能覆盖并可发起新任务",async()=>{
 const id=randomUUID();await enqueue(a,id,payload());let entered!:()=>void,release!:()=>void,calls=0;const start=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const worker=runOne(async()=>{calls++;entered();await wait;return {value:"late"};});await start;
 assert.equal((await jobState(a,id)).state,"running");await runOne(async()=>{calls++;return {};});assert.equal(calls,1);
 await cancelJob(a,id);release();await worker;const result=await jobState(a,id);assert.equal(result.state,"cancelled");assert.equal("result" in result,false);
 const next=randomUUID();await enqueue(a,next,payload());await runOne(async()=>({ok:true}));assert.equal((await jobState(a,next)).state,"succeeded");
});

test("供应商失败和未知异常安全分类且不输出原始响应",async()=>{
 const id=randomUUID();await enqueue(a,id,payload());await runOne(async()=>{throw new AppError("PROVIDER_UNAVAILABLE","模拟上游异常，原内容仍保留。",502);});const result=await jobState(a,id);assert.equal(result.state,"failed");assert.equal(result.error?.code,"PROVIDER_UNAVAILABLE");
 const other=randomUUID();await enqueue(a,other,payload());await runOne(async()=>{throw new Error("PRIVATE_RESPONSE_SHOULD_NOT_APPEAR");});assert.doesNotMatch(JSON.stringify(await jobState(a,other)),/PRIVATE_RESPONSE/);
});
test("后台任务保留安全的代理、网络和密钥格式错误分类",async()=>{
 for(const code of ['NETWORK_CONFIG','AI_PROXY_UNAVAILABLE','DNS_RESOLUTION_FAILED','DNS_LOOKUP_FAILED','INVALID_KEY_FORMAT']){
  const owner=randomUUID(),id=randomUUID(),message=`安全错误说明：${code}`;
  await enqueue(owner,id,payload());await runOne(async()=>{throw new AppError(code,message,503);});
  const result=await jobState(owner,id);
  assert.equal(result.state,'failed');assert.equal(result.error?.code,code);assert.equal(result.error?.message,message);assert.ok(result.error);assert.equal('requestId' in result.error&&result.error.requestId,id);
 }
});

test("云端真实调用链的首次请求和标签补全失败都使用同一编号并保留安全阶段",async()=>{
 const previous={key:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL,base:process.env.OPENAI_BASE_URL};
 process.env.OPENAI_API_KEY="synthetic-private-key";process.env.OPENAI_MODEL="synthetic-model";delete process.env.OPENAI_BASE_URL;
 const lines:string[]=[];const info=mock.method(console,"info",(...args:unknown[])=>{lines.push(args.map(String).join(" "));});const logError=mock.method(console,"error",(...args:unknown[])=>{lines.push(args.map(String).join(" "));});
 const owner=randomUUID(),imageId=randomUUID();
 const input:JobInput={kind:"generate",brief:{...emptyBrief,topic:"SYNTHETIC_PRIVATE_INPUT"},images:[{id:imageId,dataUrl:"data:image/jpeg;base64,cHJpdmF0ZQ=="}],imageIds:[imageId]};
 let calls=0,repair=false;
 const fetchMock=mock.method(globalThis,"fetch",async()=>{
  calls++;
  if(repair&&calls===1){const result=createDemoResult([imageId]);result.hashtags=["#不足"];return Response.json({id:"test-response",object:"response",status:"completed",output:[{id:"test-message",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(result),annotations:[]}]}]});}
  return Response.json({error:{message:"SYNTHETIC_PRIVATE_PROVIDER_RESPONSE"}},{status:502});
 });
 try{
  for(const expectedStage of ["initial_request","tag_repair_request"] as const){
   const id=randomUUID();await enqueue(owner,id,input);await runOne();const state=await jobState(owner,id);
   assert.equal(state.state,"failed");assert.ok(state.error);assert.equal(state.error.code,"PROVIDER_UNAVAILABLE");
   assert.equal("requestId" in state.error&&state.error.requestId,id);assert.equal("stage" in state.error&&state.error.stage,expectedStage);
   assert.equal("source" in state.error&&state.error.source,"provider_http");assert.equal("providerStatus" in state.error&&state.error.providerStatus,502);
   assert.ok(lines.some(line=>line.includes(`requestId=${id}`)&&line.includes(`stage=${expectedStage} status=started`)));
   assert.ok(lines.some(line=>line.includes(`requestId=${id}`)&&line.includes(`stage=${expectedStage}`)&&line.includes("providerStatus=502")));
   assert.equal(calls,repair?2:1);repair=true;calls=0;
  }
  assert.doesNotMatch(lines.join("\n"),/synthetic-private-key|SYNTHETIC_PRIVATE_INPUT|SYNTHETIC_PRIVATE_PROVIDER_RESPONSE|cHJpdmF0ZQ/);
 }finally{fetchMock.mock.restore();info.mock.restore();logError.mock.restore();if(previous.key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous.key;if(previous.model===undefined)delete process.env.OPENAI_MODEL;else process.env.OPENAI_MODEL=previous.model;if(previous.base===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=previous.base;}
});

test("风格提取任务走用户独立后台队列，结果只能由所有者读取",async()=>{
 const owner=randomUUID(),other=randomUUID(),id=randomUUID();
 const input:JobInput={kind:"style_extract",input:{referenceText:"合成参考文案",referenceAspects:["tone"]}};
 await enqueue(owner,id,input);await assert.rejects(jobState(other,id),/不存在/);
 let calls=0;await runOne(async()=>{calls++;return {preferences:{tone:"自然分享",audience:"",length:"medium",emoji:false,styleNotes:"口语化",forbidden:""}};});
 const state=await jobState(owner,id);assert.equal(state.state,"succeeded");assert.equal(calls,1);assert.equal((state.result as {preferences:{styleNotes:string}}).preferences.styleNotes,"口语化");
 await assert.rejects(jobState(other,id),/不存在/);
});

test("云端单次模型等待超时与总任务超时分别保留可信分类",async()=>{
 const owner=randomUUID();
 for(const stage of ["initial_request","tag_repair_request"] as const){
  const id=randomUUID();await enqueue(owner,id,payload());await runOne(async()=>{throw new GenerationStageError(new AppError("TIMEOUT","等待 AI 服务回复超时，原内容保留。",504),stage,"transport_or_response");});
  const state=await jobState(owner,id);assert.equal(state.state,"failed");assert.ok(state.error);assert.equal(state.error.code,"TIMEOUT");
  assert.equal("requestId" in state.error&&state.error.requestId,id);assert.equal("stage" in state.error&&state.error.stage,stage);
  assert.equal("source" in state.error&&state.error.source,"transport_or_response");
 }
});

test("模型执行时区分 worker 总时限和主动取消，安全日志不误判",async()=>{
 const previous={key:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL,base:process.env.OPENAI_BASE_URL};
 process.env.OPENAI_API_KEY="synthetic-key";process.env.OPENAI_MODEL="synthetic-model";delete process.env.OPENAI_BASE_URL;
 const lines:string[]=[];const info=mock.method(console,"info",(...args:unknown[])=>{lines.push(args.map(String).join(" "));});const logError=mock.method(console,"error",(...args:unknown[])=>{lines.push(args.map(String).join(" "));});
 const imageId=randomUUID(),input:JobInput={kind:"generate",brief:{...emptyBrief,topic:"模拟"},images:[{id:imageId,dataUrl:"data:image/jpeg;base64,cHJpdmF0ZQ=="}],imageIds:[imageId]};let entered!:()=>void;
 const fetchMock=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
  entered();const abort=()=>reject(new DOMException("模拟中断","AbortError"));if(init?.signal?.aborted)abort();else init?.signal?.addEventListener("abort",abort,{once:true});
 }));
 try{
  for(const cause of ["timeout","cancel"] as const){
   const timeout=new AbortController(),cancel=new AbortController(),id=randomUUID();let notify!:()=>void;const started=new Promise<void>(resolve=>{notify=resolve;});entered=notify;
   const pending=execute(input,AbortSignal.any([timeout.signal,cancel.signal]),randomUUID(),id,{timeoutSignal:timeout.signal,cancelSignal:cancel.signal});
   const result=assert.rejects(pending,error=>{
    assert.ok(error instanceof GenerationStageError);assert.equal(error.stage,"initial_request");assert.equal(error.source,cause==="timeout"?"request_budget":"request_cancel");assert.equal(error.code,cause==="timeout"?"TIMEOUT":"CANCELLED");return true;
   });
   await started;if(cause==="timeout")timeout.abort();else cancel.abort();await result;
   assert.ok(lines.some(line=>line.includes(`requestId=${id}`)&&line.includes(`source=${cause==="timeout"?"request_budget":"request_cancel"}`)));
  }
 }finally{fetchMock.mock.restore();info.mock.restore();logError.mock.restore();if(previous.key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous.key;if(previous.model===undefined)delete process.env.OPENAI_MODEL;else process.env.OPENAI_MODEL=previous.model;if(previous.base===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=previous.base;}
});

test("租约过期标记失败，不会自动重新派发模型请求",async()=>{
 const id=randomUUID();await enqueue(b,id,payload());const db=await getRepository();const job=await db.get<Record<string,unknown>>("jobs",`${b}:${id}`);assert.ok(job);await db.put("jobs",`${b}:${id}`,{...job,state:"running",lease:"dead-worker",leaseUntil:Date.now()-1},b);await db.remove("job-queue",`${b}:${id}`);await db.put("job-reap",`${b}:${id}`,{id,owner:b,expiresAt:Date.now()-1},b);
 let calls=0;await runOne(async()=>{calls++;return {};});assert.equal(calls,0);const state=await jobState(b,id);assert.equal(state.state,"failed");assert.equal(state.error?.code,"TIMEOUT");
});

test("热点更新按日去重、合并并发，失败仍保留旧数据及时间",async()=>{
 const sample:Hotspot={id:"synthetic",title:"测试热点",description:"模拟",url:"https://example.com",source:"测试来源",publishedAt:null,collectedAt:new Date().toISOString(),rank:1};
 let calls=0,release!:()=>void,entered!:()=>void;const first=new Promise<void>(r=>entered=r),block=new Promise<void>(r=>release=r);
 const collect=async()=>{calls++;entered();await block;return [sample];};const one=updateCloudHotspots(true,collect);await first;await updateCloudHotspots(true,collect);assert.equal(calls,1);release();await one;
 const before=await cloudHotspotState(a);assert.equal(before.items.length,1);assert.ok(before.lastSuccessAt);await updateCloudHotspots(false,async()=>{calls++;return [sample];});assert.equal(calls,1);
 await updateCloudHotspots(true,async()=>{throw new Error("PRIVATE_PROVIDER_DETAIL");});const after=await cloudHotspotState(a);assert.deepEqual(after.items,before.items);assert.equal(after.lastSuccessAt,before.lastSuccessAt);assert.ok(after.error);assert.doesNotMatch(JSON.stringify(after),/PRIVATE_PROVIDER_DETAIL/);
});

test("单人建议按用户隔离，并拒绝过期热点建议写入",async()=>{
 const repo=await getRepository(),shared=await repo.get<{version:string;items:Hotspot[]}>("shared","hotspots");assert.ok(shared);
 const input:JobInput={kind:"hotspots",items:shared.items,version:shared.version,style:{tone:"自然分享",audience:"",length:"medium",emoji:false,styleNotes:"",forbidden:""}};
 const id=randomUUID();await enqueue(a,id,input);await runOne(async()=>({version:shared.version,ideas:[{hotspotId:"synthetic",topic:"测试主题",angle:"测试角度",headline:"测试标题",imageIdea:"测试配图",reason:"测试"}]}));
 assert.equal((await cloudHotspotState(a)).suggestions.length,1);assert.equal((await cloudHotspotState(b)).suggestions.length,0);
 const stale=randomUUID();await enqueue(b,stale,input);await updateCloudHotspots(true,async()=>shared.items);await assert.rejects(jobState(a,id),/热点已经更新/);await runOne(async()=>({version:shared.version,ideas:[]}));assert.equal((await jobState(b,stale)).state,"failed");assert.equal((await cloudHotspotState(b)).suggestions.length,0);
});

test("超过 HTTP 网关时限的长任务仍保持后台处理中并可完成",async()=>{
 const originalNow=Date.now;let fake=originalNow();Date.now=()=>fake;
 try{
  const owner=randomUUID(),id=randomUUID();await enqueue(owner,id,payload());let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),block=new Promise<void>(r=>release=r);
  const pending=runOne(async()=>{entered();await block;return {ok:true};});await started;fake+=61_000;
  assert.equal((await jobState(owner,id)).state,"running");release();await pending;assert.equal((await jobState(owner,id)).state,"succeeded");
 }finally{Date.now=originalNow;}
});

test("云端视频接口在会话校验后返回任务编号，只有所有者能查询结果",async()=>{
 const c=randomUUID(),d=randomUUID();
 const {createHash,randomBytes}=await import("node:crypto"),{hashSecret}=await import("../lib/cloud/server/auth");
 const {POST}=await import("../app/api/video/route"),jobs=await import("../app/api/cloud/jobs/[id]/route");
 const digest=(v:string)=>createHash("sha256").update(v).digest("hex");const gateToken=randomBytes(32).toString("base64url"),aToken=randomBytes(32).toString("base64url"),bToken=randomBytes(32).toString("base64url"),gateHash=await hashSecret("synthetic-gate-password");
 process.env.SITE_ACCESS_HASH=gateHash;const repo=await getRepository();await repo.put("system","admin_bootstrapped",{done:true});await repo.put("gate_sessions",digest(gateToken),{expiresAt:Date.now()+60_000,version:digest(gateHash)});
 for(const [id,token] of [[c,aToken],[d,bToken]] as const){await repo.put("users",id,{id,username:id===c?"alice":"bob",role:"user",mustChange:false,normalized:id===c?"alice":"bob",passwordHash:gateHash,version:1,createdAt:new Date().toISOString()},id);await repo.put("user_sessions",digest(token),{expiresAt:Date.now()+60_000,userId:id,version:1},id);}
 process.env.OPENAI_API_KEY="test-only-placeholder";process.env.OPENAI_MODEL="test-model";delete process.env.OPENAI_BASE_URL;
 process.env.AI_CONFIG_SECRET='test-master-secret-at-least-32-characters';
 const {saveProfile,setDefault}=await import('../lib/server/ai/store');const profile=await saveProfile(c,{name:'Alice API',provider:'openai',protocol:'responses',baseUrl:'https://api.openai.com/v1',apiKey:'synthetic-test',model:'test-model'});await setDefault(c,profile.id);
 const id=randomUUID(),json=payload();const request=(owner:string,token:string,origin="http://127.0.0.1:3002")=>new Request("http://127.0.0.1:3002/api/video",{method:"POST",headers:{"content-type":"application/json",origin,"x-client-request-id":id,"x-workspace-user":owner,cookie:`xhs-dev-gate=${gateToken}; xhs-dev-user=${token}`},body:JSON.stringify(json.kind==="video"?json.input:{})});
 assert.equal((await POST(new Request("http://127.0.0.1:3002/api/video",{method:"POST",headers:{origin:"http://127.0.0.1:3002","content-type":"application/json"},body:"{}"}))).status,401);
 assert.equal((await POST(request(c,aToken,"https://attacker.example"))).status,403);
 const submitted=await POST(request(c,aToken));assert.equal(submitted.status,202);assert.equal((await submitted.json()).jobId,id);
 assert.equal((await POST(request(c,aToken))).status,202, "相同请求和配置快照重复提交仍幂等");
 const poll=(owner:string,token:string)=>new Request(`http://127.0.0.1:3002/api/cloud/jobs/${id}`,{headers:{"x-workspace-user":owner,cookie:`xhs-dev-gate=${gateToken}; xhs-dev-user=${token}`}});
 assert.equal((await jobs.GET(poll(d,bToken),{params:Promise.resolve({id})})).status,404);
 assert.equal((await (await jobs.GET(poll(c,aToken),{params:Promise.resolve({id})})).json()).state,"queued");
 await runOne(async()=>({plan:{synthetic:true},meta:{durationMs:10,completedAt:new Date().toISOString()}}));const result=await jobs.GET(poll(c,aToken),{params:Promise.resolve({id})});assert.equal(result.status,200);assert.equal((await result.json()).state,"succeeded");
});

test("定时接口只接受有效服务端密钥，重复触发仍保留热点状态",async()=>{
 const {POST}=await import("../app/api/cloud/cron/route");process.env.CLOUD_CRON_SECRET="synthetic-long-cron-secret-for-tests";
 const request=(secret:string)=>new Request("http://127.0.0.1:3002/api/cloud/cron",{method:"POST",headers:{authorization:`Bearer ${secret}`}});
 assert.equal((await POST(request("wrong"))).status,401);const before=await cloudHotspotState(a),response=await POST(request(process.env.CLOUD_CRON_SECRET));assert.equal(response.status,200);const after=await cloudHotspotState(a);assert.equal(after.lastSuccessAt,before.lastSuccessAt);assert.equal(after.scheduler,"running");
});

test("事务提交结果不确定时保留输入对象，已提交任务仍能执行",async()=>{
 const owner=randomUUID(),id=randomUUID(),db=await getRepository();const original=db.transaction.bind(db);let count=0;
 const injected=mock.method(db,"transaction",async <T>(work:Parameters<typeof db.transaction>[0]):Promise<T>=>{const output=await original(work);if(++count===3)throw new Error("simulated lost commit acknowledgement");return output as T;});
 try{await assert.rejects(enqueue(owner,id,payload()),/simulated lost/);}finally{injected.mock.restore();}
 assert.equal((await jobState(owner,id)).state,"queued");await runOne(async()=>({ok:"input was preserved"}));assert.deepEqual((await jobState(owner,id)).result,{ok:"input was preserved"});
});

test("对象删除失败时保留清理记录和任务元数据，之后可重试完成",async()=>{
 const {getBlobs}=await import("../lib/cloud/server/blobs");const owner=randomUUID(),id=randomUUID(),db=await getRepository();await enqueue(owner,id,payload());await runOne(async()=>({ok:true}));
 const job=await db.get<{inputRef:string}>("jobs",`${owner}:${id}`);assert.ok(job);const blobs=await getBlobs(),remove=blobs.remove.bind(blobs);const injected=mock.method(blobs,"remove",async(ref:string)=>{if(ref===job.inputRef)throw new Error("synthetic storage failure");return remove(ref);});
 const future=Date.now()+25*60*60_000;
 try{const report=await cleanupJobUploads(future,100);assert.ok(report.failed>=1);for(let i=0;i<12;i++)await cleanupCloudJobs(future);assert.ok(await db.get("jobs",`${owner}:${id}`));}finally{injected.mock.restore();}
 await cleanupJobUploads(future+61_000,100);for(let i=0;i<12;i++)await cleanupCloudJobs(future+61_000);assert.equal(await db.get("jobs",`${owner}:${id}`),null);
});

test("云端生成预算与本机预算分别独立",async()=>{const {generationTimeouts}=await import("../lib/server/generation-timeouts");assert.deepEqual(generationTimeouts(),{totalMs:180_000,modelMs:150_000});const old=process.env.APP_MODE;delete process.env.APP_MODE;try{assert.deepEqual(generationTimeouts("local",undefined),{totalMs:100_000,modelMs:90_000});assert.deepEqual(generationTimeouts(undefined,undefined),{totalMs:50_000,modelMs:48_000});}finally{process.env.APP_MODE=old;}});

test("worker 与定时清理使用有界到期索引，不扫描完整任务或上传表",async()=>{
 const db=await getRepository(),original=db.scan.bind(db);const guard=mock.method(db,"scan",async <T>(bucket:string,owner?:string)=>{if(["jobs","job-uploads","job-queue","job-reap"].includes(bucket))throw new Error("UNBOUNDED_SCAN");return original<T>(bucket,owner);});
 try{const owner=randomUUID(),id=randomUUID();await enqueue(owner,id,payload());await runOne(async()=>({ok:true}));await cleanupJobUploads(Date.now()+25*60*60_000,4);await cleanupCloudJobs(Date.now()+25*60*60_000);}finally{guard.mock.restore();}
});

test("后台模型不响应时按预算结束，原内容保留且不会自动重试",async()=>{
 const owner=randomUUID(),id=randomUUID(),original=AbortSignal.timeout;await enqueue(owner,id,payload());let calls=0;
 const timeout=mock.method(AbortSignal,"timeout",()=>original(20));const keep=setTimeout(()=>{},1000);
 try{await runOne(async()=>{calls++;return new Promise(()=>{});});const state=await jobState(owner,id);assert.equal(state.state,"failed");assert.equal(state.error?.code,"TIMEOUT");assert.equal(calls,1);await runOne(async()=>{calls++;return {};});assert.equal(calls,1);}finally{clearTimeout(keep);timeout.mock.restore();}
});

test("读取任务输入超过时限时不会再调用模型",async()=>{
 const {getBlobs}=await import("../lib/cloud/server/blobs"),owner=randomUUID(),id=randomUUID(),blobs=await getBlobs();await enqueue(owner,id,payload());
 const originalGet=blobs.get.bind(blobs),originalTimeout=AbortSignal.timeout;let calls=0;
 const slow=mock.method(blobs,"get",async(ref:string)=>{await new Promise(resolve=>setTimeout(resolve,40));return originalGet(ref);});
 const timeout=mock.method(AbortSignal,"timeout",()=>originalTimeout(20));
 try{await runOne(async()=>{calls++;return {};});const state=await jobState(owner,id);assert.equal(calls,0);assert.equal(state.state,"failed");assert.equal(state.error?.code,"TIMEOUT");}
 finally{slow.mock.restore();timeout.mock.restore();}
});

test("结果上传期间达到时限不会保存迟到结果，保留上传记录以安全清理",async()=>{
 const {getBlobs}=await import("../lib/cloud/server/blobs"),owner=randomUUID(),id=randomUUID(),blobs=await getBlobs();await enqueue(owner,id,payload());
 const originalPut=blobs.put.bind(blobs),deadline=new AbortController();let uploads=0;
 const slow=mock.method(blobs,"put",async(key:string,bytes:Buffer)=>{
  const ref=await originalPut(key,bytes);
  if(key.includes("-result-")){uploads++;deadline.abort(new DOMException("Deadline reached","TimeoutError"));}
  return ref;
 });
 const timeout=mock.method(AbortSignal,"timeout",()=>deadline.signal);
 try{await runOne(async()=>({value:"late"}));const state=await jobState(owner,id);assert.equal(uploads,1);assert.equal(state.state,"failed");assert.equal(state.error?.code,"TIMEOUT");assert.equal("result" in state,false);
  const db=await getRepository(),intents=await db.scan<{jobId:string;kind:string;state:string}>("job-uploads",owner);assert.ok(intents.some(item=>item.value.jobId===id&&item.value.kind==="result"&&item.value.state==="ready"));
 }finally{slow.mock.restore();timeout.mock.restore();}
});

test("事务内写入结果期间超时会回滚成功状态并保留原结果",async()=>{
 const owner=randomUUID(),id=randomUUID(),db=await getRepository();await enqueue(owner,id,payload());
 const originalTransaction=db.transaction.bind(db),originalTimeout=AbortSignal.timeout;let delayed=false;
 const transaction=mock.method(db,"transaction",async <T>(work:Parameters<typeof db.transaction>[0]):Promise<T>=>originalTransaction(async tx=>{
  const proxy=new Proxy(tx,{get(target,property,receiver){
   if(property==="put")return async(bucket:string,key:string,value:unknown,recordOwner?:string)=>{
    await target.put(bucket,key,value,recordOwner);
    if(bucket==="jobs"&&value&&typeof value==="object"&&"state" in value&&value.state==="succeeded"&&!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,40));}
   };
   return Reflect.get(target,property,receiver);
  }});
  return work(proxy) as Promise<T>;
 }));
 const timeout=mock.method(AbortSignal,"timeout",()=>originalTimeout(20));
 try{await runOne(async()=>({value:"late"}));const state=await jobState(owner,id);assert.equal(delayed,true);assert.equal(state.state,"failed");assert.equal(state.error?.code,"TIMEOUT");assert.equal("result" in state,false);}
 finally{transaction.mock.restore();timeout.mock.restore();}
});
test("提交前取消不会创建任务",async()=>{const owner=randomUUID(),id=randomUUID(),abort=AbortSignal.abort();await assert.rejects(enqueue(owner,id,payload(),abort),/取消/);await assert.rejects(jobState(owner,id),/不存在/);});

test("空闲 worker 在收到新任务时立即唤醒，处理中收到的唤醒不会丢失",async()=>{
 const {createCloudWorker}=await import("../lib/cloud/server/jobs");let calls=0,entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),block=new Promise<void>(r=>release=r);let second!:()=>void;const ranAgain=new Promise<void>(r=>second=r);
 const worker=createCloudWorker(async()=>{calls++;if(calls===1){entered();await block;return false;}second();return false;},30_000);
 try{await started;worker.wake();release();await Promise.race([ranAgain,new Promise((_,reject)=>setTimeout(()=>reject(new Error("wake was lost")),300))]);assert.equal(calls,2);}finally{worker.stop();}
});
test("worker 一次唤醒会连续处理队列，直到队列为空才进入空闲",async()=>{
 const {createCloudWorker}=await import("../lib/cloud/server/jobs");let calls=0,finish!:()=>void;const done=new Promise<void>(r=>finish=r);
 const worker=createCloudWorker(async()=>{calls++;if(calls===3){finish();return false;}return true;},30_000);
 try{await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error("queue did not drain")),300))]);assert.equal(calls,3);}finally{worker.stop();}
});

test("真实队列读取路径的 SDK 错误保留安全阶段分类，不包含 SDK 原始内容",async()=>{
 const {classifyWorkerError,workerLogLine}=await import("../lib/cloud/server/worker-diagnostics");
 const db=await getRepository();
 const injected=mock.method(db,"scanExpired",async()=>{throw {code:"AccessDenied",statusCode:403,message:"SYNTHETIC_PRIVATE_CONTENT",headers:{authorization:"SYNTHETIC_PRIVATE_KEY"}};});
 try{
  await assert.rejects(runOne(async()=>{throw new Error("executor must not be called");}),error=>{
   const diagnostic=classifyWorkerError(error);
   assert.equal(diagnostic.stage,"queue_read");assert.equal(diagnostic.category,"permission");assert.equal(diagnostic.httpStatus,403);
   assert.doesNotMatch(workerLogLine(diagnostic,10),/SYNTHETIC_PRIVATE|authorization|headers/);return true;
  });
 }finally{injected.mock.restore();}
});

test("云端旧来源缓存同日也会切换采集器，失败保留原列表且不冒充新来源",async()=>{
 const db=await getRepository(),saved=await db.get("shared","hotspots"),now=new Date().toISOString();let calls=0;
 const old={items:[{id:"legacy",title:"旧热点",description:"旧摘要",url:"https://example.com",source:"Google Trends 台湾地区热搜",publishedAt:null,collectedAt:now,rank:1}],lastSuccessAt:now,lastAttemptAt:now,error:null,sources:[],version:randomUUID()};
 try {
  await db.put("shared","hotspots",old);await updateCloudHotspots(false,async()=>{calls++;throw new HotspotSourceError("TIMEOUT");});
  const failed=await cloudHotspotState(a);assert.equal(calls,1);assert.equal(failed.lastSuccessAt,now);assert.equal(failed.items[0].source,old.items[0].source);assert.match(failed.sourceNotice!,/切换来源前/);assert.match(failed.error!,/12 秒/);
  await updateCloudHotspots(false,async()=>{calls++;return [];});assert.equal(calls,1);
  await updateCloudHotspots(true,async()=>old.items);const updated=await cloudHotspotState(a);assert.equal(updated.sourceNotice,null);assert.equal((await db.get<{sourceKey:string}>("shared","hotspots"))?.sourceKey,HOTSPOT_SOURCE_KEY);
 }finally{if(saved)await db.put("shared","hotspots",saved);}
});

test("云端相关性筛选空结果与来源失败分开，保留数量说明并更新版本",async()=>{
 const db=await getRepository(),saved=await db.get("shared","hotspots");
 try{
  await updateCloudHotspots(true,async()=>({items:[],sourceCount:50,filteredCount:50}));
  const result=await cloudHotspotState(a);assert.equal(result.error,null);assert.equal(result.items.length,0);assert.equal(result.sourceCount,50);assert.match(result.selectionNotice!,/保留 0 条/);assert.equal(result.suggestions.length,0);
  const stamp=result.lastSuccessAt;await updateCloudHotspots(true,async()=>{throw new HotspotSourceError("RESTRICTED");});
  const failed=await cloudHotspotState(a);assert.equal(failed.lastSuccessAt,stamp);assert.match(failed.error!,/访问受限/);
 }finally{if(saved)await db.put("shared","hotspots",saved);}
});

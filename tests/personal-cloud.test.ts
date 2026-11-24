import {saveProfile,setDefault} from "../lib/server/ai/store";
import {aiTransport} from "../lib/server/ai/provider";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSecret, issueGate, gateCookieName, userCookieName, bootstrapAdmin, getRequestAuthState } from "../lib/cloud/server/auth";
import { jobState, runOne, cancelJob } from "../lib/cloud/server/jobs";
import { POST } from "../app/api/personal/route";
import { emptyPersonalInput } from "../lib/personal/schema";
import { AppError } from "../lib/errors";

const previous={...process.env}, origin="http://127.0.0.1:3209";let directory="",cookies="",owner="";
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),"xhs-personal-cloud-"));
  process.env={...process.env,NODE_ENV:"test",APP_MODE:"cloud",APP_ORIGIN:origin,CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(directory,"test.sqlite"),CLOUD_BLOB_PATH:join(directory,"blobs"),OPENAI_API_KEY:"synthetic",OPENAI_MODEL:"test"};delete process.env.OPENAI_BASE_URL;
  process.env.SITE_ACCESS_HASH=await hashSecret("synthetic-gate-password");process.env.ADMIN_BOOTSTRAP_HASH=await hashSecret("synthetic-bootstrap-password");
  const gate=await issueGate("synthetic-gate-password");const gateCookie=`${gateCookieName()}=${gate}`;
  const admin=await bootstrapAdmin(new Request(origin,{headers:{cookie:gateCookie}}),"synthetic-bootstrap-password","personal_test_admin","synthetic-admin-password");
  cookies=`${gateCookie}; ${userCookieName()}=${admin}`;const state=await getRequestAuthState(new Request(origin,{headers:{cookie:cookies}}));owner=state.user!.id;
 process.env.AI_CONFIG_SECRET="test-master-secret-at-least-32-characters";const p=await saveProfile(owner,{name:"Personal API",provider:"openai",protocol:"responses",baseUrl:"https://api.openai.com/v1",apiKey:"synthetic",model:"test"});await setDefault(owner,p.id);
});
after(async()=>{process.env=previous;await rm(directory,{recursive:true,force:true});});
function request(action:"prompt"|"generate",options:{id?:string;source?:string;identity?:string}={}){
  const form=new FormData();form.set("payload",JSON.stringify({action,input:{...emptyPersonalInput,experience:"独立合成经历"},imageIds:[],...(action==="generate"?{confirmedPrompt:"已确认的提示词"}:{})}));
  return new Request(`${origin}/api/personal`,{method:"POST",headers:{origin,cookie:cookies,"x-workspace-user":options.identity??owner,"x-client-request-id":options.id??randomUUID(),...(options.source?{"x-ai-source":options.source}:{})},body:form});
}
const note={titles:["标题一","标题二","标题三","标题四","标题五"],coverCopy:{headline:"封面",subline:"副标题"},imageCaptions:[],body:"正文一。\n\n正文二。",hashtags:Array.from({length:10},(_,i)=>`#话题${i}`),warnings:[]};
function modelReply(value:unknown){return Response.json({id:"test",object:"response",created_at:1,model:"test",status:"completed",error:null,incomplete_details:null,output:[{id:"message",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}]});}

test("云端个人创作无图提交进入私有后台队列，其他用户不可读取或取消",async()=>{
  const id=randomUUID(),submitted=await POST(request("generate",{id}));assert.equal(submitted.status,202);const body=await submitted.json();assert.equal(body.jobId,id);
  const other=randomUUID();await assert.rejects(jobState(other,id),/不存在/);await assert.rejects(cancelJob(other,id),/不存在/);
  let calls=0;const net=mock.method(aiTransport,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{calls++;assert.doesNotMatch(String(init?.body),/input_image/);assert.match(String(init?.body),/已确认的提示词/);return modelReply(note);});
  try{await runOne();const result=await jobState(owner,id);assert.equal(result.state,"succeeded");assert.equal(calls,1);assert.equal((result.result as {result:{imageCaptions:unknown[]}}).result.imageCaptions.length,0);await assert.rejects(jobState(other,id),/不存在/);}finally{net.mock.restore();}
});
test("云端拒绝订阅伪造与错误身份，失败和取消不提交新结果",async()=>{
  assert.equal((await POST(request("prompt",{source:"chatgpt"}))).status,400);
  assert.equal((await POST(request("prompt",{identity:randomUUID()}))).status,409);
  const id=randomUUID();assert.equal((await POST(request("prompt",{id}))).status,202);await runOne(async()=>{throw new AppError("PROVIDER_UNAVAILABLE","模拟失败，已有内容保留。",502);});let state=await jobState(owner,id);assert.equal(state.state,"failed");assert.equal("result" in state,false);
  const other=randomUUID();assert.equal((await POST(request("generate",{id:other}))).status,202);let entered!:()=>void,release!:()=>void;const start=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  const pending=runOne(async()=>{entered();await wait;return {result:note};});await start;await cancelJob(owner,other);release();await pending;state=await jobState(owner,other);assert.equal(state.state,"cancelled");assert.equal("result" in state,false);
});

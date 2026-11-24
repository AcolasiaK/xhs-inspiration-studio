import {test,mock,afterEach} from "node:test";
import assert from "node:assert/strict";
import {setCloudIdentity} from "../lib/cloud/client";
import {cloudJobFetch} from "../lib/cloud/jobs-client";
import {GenerationRequestError,generationErrorMessage,submitGeneration} from "../lib/generation-request";
import {emptyBrief} from "../lib/schema";
const id="b795a526-8360-44d6-8310-112233445566";
afterEach(()=>{mock.restoreAll();setCloudIdentity("",false);});
test("云端轮询保留所有权标记，并向原页面提供成功结果",async()=>{
 setCloudIdentity("synthetic-owner",true);let polls=0,posts=0;
 mock.method(globalThis,"fetch",async (url:RequestInfo|URL,options?:RequestInit)=>{const headers=new Headers(options?.headers);assert.equal(headers.get("x-workspace-user"),"synthetic-owner");if(String(url)==="/api/video"){posts++;assert.ok(headers.get("x-client-request-id"));return Response.json({jobId:id,state:"queued"},{status:202});}polls++;return Response.json(polls===1?{state:"running"}:{state:"succeeded",result:{plan:{test:true}}});});
 const response=await cloudJobFetch("/api/video",{method:"POST"});assert.equal(response.status,200);assert.deepEqual(await response.json(),{plan:{test:true}});assert.equal(posts,1);assert.equal(polls,2);
});
test("云端 502 的错误信息传回原页面，不伪装为成功",async()=>{
 setCloudIdentity("synthetic-owner",true);mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>String(url)==="/api/video"?Response.json({jobId:id},{status:202}):Response.json({state:"failed",error:{code:"PROVIDER_UNAVAILABLE",message:"上游异常，原内容保留。",status:502}}));
 const response=await cloudJobFetch("/api/video",{method:"POST"});assert.equal(response.status,502);assert.equal((await response.json()).error.code,"PROVIDER_UNAVAILABLE");
});
test("取消等待会发送归属校验的取消请求，迟到结果不会应用",async()=>{
 setCloudIdentity("synthetic-owner",true);let deletes=0;const controller=new AbortController();
 mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{if(options?.method==="DELETE"){deletes++;assert.equal(new Headers(options.headers).get("x-workspace-user"),"synthetic-owner");return Response.json({state:"cancelled"});}if(String(url)==="/api/video")return Response.json({jobId:id},{status:202});return Response.json({state:"running"});});
 const pending=cloudJobFetch("/api/video",{method:"POST",signal:controller.signal});await new Promise(r=>setTimeout(r,25));controller.abort();await assert.rejects(pending);await new Promise(r=>setTimeout(r,25));assert.equal(deletes,1);
});
test("提交响应丢失时按同一个请求编号尝试取消，避免隐式重复请求",async()=>{
 setCloudIdentity("synthetic-owner",true);let sentId="",cancelPath="";
 mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{if(options?.method==="DELETE"){cancelPath=String(url);return Response.json({state:"cancelled"});}sentId=new Headers(options?.headers).get("x-client-request-id")||"";throw new TypeError("network unavailable");});
 await assert.rejects(cloudJobFetch("/api/video",{method:"POST"}));await new Promise(r=>setTimeout(r,0));assert.equal(cancelPath,`/api/cloud/jobs/${sentId}`);
});

test("云端任务错误阶段与编号可传到页面显示",async()=>{
 setCloudIdentity("synthetic-owner",true);let actualId="";
 mock.method(globalThis,"fetch",async(url:RequestInfo|URL,options?:RequestInit)=>{
  if(String(url)==="/api/generate"){actualId=new Headers(options?.headers).get("x-client-request-id")!;return Response.json({jobId:actualId,state:"queued"},{status:202});}
  return Response.json({state:"failed",error:{code:"TIMEOUT",message:"模拟超时，原内容保留。",status:504,requestId:actualId,stage:"tag_repair_request",source:"transport_or_response"}});
 });
 const imageId=crypto.randomUUID(),image={id:imageId,file:new File(["synthetic"],"test.jpg",{type:"image/jpeg"}),preview:"blob:synthetic",width:1,height:1};
 await assert.rejects(submitGeneration({brief:{...emptyBrief,topic:"测试"},mode:"live",images:[image],controller:new AbortController(),onProgress:()=>undefined,onRequestStarted:()=>undefined,compress:async(items)=>items.map(item=>item.file)}),error=>{
  assert.ok(error instanceof GenerationRequestError);assert.equal(error.requestId,actualId);assert.equal(error.stage,"tag_repair_request");assert.match(generationErrorMessage(error),/话题补全/);return true;
 });
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { personalRequest, PersonalRequestError } from "../lib/personal/client";
import { emptyPersonalInput } from "../lib/personal/schema";
import type { StudioImage } from "../lib/types";
import { isPersonalPromptStale, personalResultFingerprint, validatePersonalClientResult } from "../lib/personal/flow";
import { newPersonalDraft } from "../lib/personal/drafts";

test("无图时分别提交提示词和用户最终编辑的确认内容",async()=>{
  const seen: {action:string;confirmedPrompt?:string;count:number}[]=[];
  const request:typeof fetch=async (_url,init)=>{
    const form=init?.body as FormData, p=JSON.parse(String(form.get("payload")));
    seen.push({action:p.action,confirmedPrompt:p.confirmedPrompt,count:form.getAll("images").length});
    return Response.json({ok:true});
  };
  const input={...emptyPersonalInput,experience:"合成的日常经历"};
  await personalRequest({action:"prompt",input,imageIds:[]},[],new AbortController(),{request});
  await personalRequest({action:"generate",input,imageIds:[],confirmedPrompt:"用户修改并确认的提示词"},[],new AbortController(),{request});
  assert.deepEqual(seen,[{action:"prompt",confirmedPrompt:undefined,count:0},{action:"generate",confirmedPrompt:"用户修改并确认的提示词",count:0}]);
});

test("图片稳定 ID 必须与上传顺序一致，所选配置显式传递",async()=>{
  const ids=[randomUUID(),randomUUID()];
  const images=ids.map(id=>({id,file:new File(["fixture"],"test.jpg",{type:"image/jpeg"}),preview:"blob:fixture",width:1,height:1})) satisfies StudioImage[];
  let calls=0;
  const request:typeof fetch=async (_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get("X-AI-Profile"),"test-profile");const form=init?.body as FormData;assert.equal(form.getAll("images").length,2);assert.deepEqual(JSON.parse(String(form.get("payload"))).imageIds,ids);return Response.json({ok:true});};
  const compress=async()=>images.map(()=>new Blob(["fixture"],{type:"image/jpeg"}));
  const payload={action:"generate" as const,input:{...emptyPersonalInput,experience:"合成描述"},imageIds:ids,confirmedPrompt:"确认内容"};
  await personalRequest(payload,images,new AbortController(),{request,compress,source:"test-profile"});assert.equal(calls,1);
  await assert.rejects(personalRequest({...payload,imageIds:[...ids].reverse()},images,new AbortController(),{request,compress}),/图片与请求不一致/);assert.equal(calls,1);
});

test("请求失败与取消不自动重试，也不更改输入",async()=>{
  let calls=0;const input={...emptyPersonalInput,experience:"保留的合成输入"};
  const request:typeof fetch=async()=>{calls++;return Response.json({error:{message:"模拟失败"}},{status:502});};
  await assert.rejects(personalRequest({action:"prompt",input,imageIds:[]},[],new AbortController(),{request}),/模拟失败/);assert.equal(calls,1);assert.equal(input.experience,"保留的合成输入");
  const abort=new AbortController();abort.abort();await assert.rejects(personalRequest({action:"prompt",input,imageIds:[]},[],abort,{request}),/已取消/);assert.equal(calls,1);
});

test("经历、风格与图片变化会使已生成提示词过期，编辑提示词本身不会",()=>{
  const draft=newPersonalDraft();draft.input.experience="今天散步";draft.prompt="提示词";draft.promptInput=structuredClone(draft.input);
  assert.equal(isPersonalPromptStale(draft),false);
  assert.equal(isPersonalPromptStale({...draft,prompt:"用户编辑后的提示词"}),false);
  assert.equal(isPersonalPromptStale({...draft,input:{...draft.input,truth:"creative"}}),true);
  assert.equal(isPersonalPromptStale({...draft,input:{...draft.input,styles:["emotion"]}}),true);
  const image={id:randomUUID(),file:new File(["fixture"],"test.jpg",{type:"image/jpeg"}),preview:"blob:fixture",width:1,height:1};
  assert.equal(isPersonalPromptStale({...draft,images:[image]}),true);
  assert.notEqual(personalResultFingerprint(draft),personalResultFingerprint({...draft,prompt:"更新"}));
});

test("个人结果可无图，图片顺序及十个唯一标签必须准确",()=>{
  const result={titles:["标题一","标题二","标题三","标题四","标题五"],coverCopy:{headline:"封面",subline:"副标题"},imageCaptions:[],body:"正文",hashtags:Array.from({length:10},(_,i)=>`#话题${i}`),warnings:[]};
  assert.equal(validatePersonalClientResult(result,[]).imageCaptions.length,0);
  assert.throws(()=>validatePersonalClientResult({...result,hashtags:["#重复","#重复"]},[]),/话题/);
  const one=randomUUID(),two=randomUUID();const imageCaptions=[{imageId:two,headline:"",description:"第一行\n第二行"},{imageId:one,headline:"",description:"第一行\n第二行"}];
  assert.throws(()=>validatePersonalClientResult({...result,imageCaptions},[one,two]),/图片和配文/);
});

test("个人请求仅报告真实准备、请求和校验阶段，成功不修改原始输入",async()=>{
  const phases:string[]=[],payload={action:"generate" as const,input:{...emptyPersonalInput,experience:"合成测试经历"},imageIds:[],confirmedPrompt:"已确认的合成提示词"};
  const original=structuredClone(payload);
  const result=await personalRequest(payload,[],new AbortController(),{
    compress:async()=>{assert.deepEqual(phases,["preparing"]);return [];},
    request:async()=>{assert.deepEqual(phases,["preparing","requesting"]);return Response.json({synthetic:true});},
    onPhase:phase=>phases.push(phase),
  });
  assert.deepEqual(phases,["preparing","requesting","validating"]);
  assert.deepEqual(result,{synthetic:true});assert.deepEqual(payload,original);
});

test("服务端安全错误分类及HTTP状态保留，缺少或不安全code不冒充口令或取消错误",async()=>{
  const payload={action:"prompt" as const,input:{...emptyPersonalInput,experience:"保留合成经历"},imageIds:[]},before=structuredClone(payload);
  let calls=0;
  for(const [code,status,expected] of [["TIMEOUT",504,"TIMEOUT"],["PROVIDER_UNAVAILABLE",502,"PROVIDER_UNAVAILABLE"],["CANCELLED",499,"CANCELLED"],["INVALID_KEY",503,"INVALID_KEY"],[undefined,500,"REQUEST_FAILED"],["unsafe\nvalue",500,"REQUEST_FAILED"],["x".repeat(200),500,"REQUEST_FAILED"]] as const){
    await assert.rejects(personalRequest(payload,[],new AbortController(),{request:async()=>{calls++;return Response.json({error:{code,message:"合成服务端失败，输入保留。"}},{status});}}),(error:unknown)=>{
      assert.ok(error instanceof PersonalRequestError);assert.equal(error.code,expected);assert.equal(error.status,status);assert.match(error.message,/合成服务端失败/u);return true;
    });
    assert.deepEqual(payload,before);
  }
  assert.equal(calls,7,"每次失败只调用一次，不自动重试");
});

test("前端取消在请求前、图片处理中和响应迟到时均明确分类，不能交付迟到结果",async()=>{
  const payload={action:"prompt" as const,input:{...emptyPersonalInput,experience:"不能丢失的合成输入"},imageIds:[]};
  let requests=0,compressions=0;
  for(const when of ["before","compress","late"] as const){
    const controller=new AbortController();if(when==="before")controller.abort();
    await assert.rejects(personalRequest(payload,[],controller,{
      compress:async()=>{compressions++;if(when==="compress")controller.abort();return [];},
      request:async()=>{requests++;controller.abort();return Response.json({prompt:"不能采用的迟到结果"});},
    }),(error:unknown)=>error instanceof PersonalRequestError&&error.code==="CANCELLED"&&/取消/u.test(error.message));
  }
  assert.equal(requests,1);assert.equal(compressions,2);assert.equal(payload.input.experience,"不能丢失的合成输入");
});

test("请求中途主动取消与网络失败分别分类，不重试且不改原输入",async()=>{
  const payload={action:"prompt" as const,input:{...emptyPersonalInput,experience:"合成输入继续保留"},imageIds:[]},before=structuredClone(payload);
  let calls=0;
  const controller=new AbortController();
  await assert.rejects(personalRequest(payload,[],controller,{request:async(_url,init)=>{calls++;return new Promise<Response>((_,reject)=>{init!.signal!.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")),{once:true});queueMicrotask(()=>controller.abort());});}}),(error:unknown)=>error instanceof PersonalRequestError&&error.code==="CANCELLED");
  await assert.rejects(personalRequest(payload,[],new AbortController(),{request:async()=>{calls++;throw new TypeError("synthetic offline");}}),(error:unknown)=>error instanceof PersonalRequestError&&error.code==="NETWORK"&&/网络/u.test(error.message));
  assert.equal(calls,2);assert.deepEqual(payload,before);
});

test("不同配置的客户端等待上限触发TIMEOUT，不误标用户取消或重试",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const payload={action:"prompt" as const,input:{...emptyPersonalInput,experience:"慢请求的合成输入"},imageIds:[]};
  let calls=0;
  for(const source of ["relay","test-profile"] as const){
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    const operation=personalRequest(payload,[],new AbortController(),{source,request:async(_url,init)=>{calls++;return new Promise<Response>((_,reject)=>{init!.signal!.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")),{once:true});started();});}});
    const failed=assert.rejects(operation,(error:unknown)=>error instanceof PersonalRequestError&&error.code==="TIMEOUT"&&/超时/u.test(error.message));
    await ready;t.mock.timers.tick(200_000);await failed;
  }
  assert.equal(calls,2);assert.equal(payload.input.experience,"慢请求的合成输入");
});

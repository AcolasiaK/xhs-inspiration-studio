import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { validateIdentity, connectionStatus, disconnect, listModels, selectModel, accessToken, startAuthorization, refreshConnection } from "../lib/server/siwc/auth";
import { subscriptionResponse } from "../lib/server/siwc/inference";
import { GET as endpointGet } from "../app/api/local-chatgpt/[action]/route";
import { POST as generatePost } from "../app/api/generate/route";

const previous={...process.env};let directory="";
before(async()=>{directory=await mkdtemp(path.join(tmpdir(),"siwc-synthetic-"));process.env={...process.env,NODE_ENV:"test",APP_MODE:"local",APP_LOCAL_ONLY:"1",SIWC_TEST_DIR:directory};});
after(async()=>{process.env=previous;await rm(directory,{recursive:true,force:true});});
const clientId="oaiapp_synthetic_client", nonce="synthetic-nonce", model="gpt-test-vision";
async function saveFake(overrides:Record<string,unknown>={}) {
  await writeFile(path.join(directory,"connection.json"),JSON.stringify({version:1,hostId:`urn:uuid:${randomUUID()}`,clientId,subject:"synthetic-subject",accessToken:"synthetic-access",refreshToken:"synthetic-refresh",scopes:["openid","offline_access","resource.invoke","chatgpt.tokens.use.direct"],expiresAt:Date.now()+3_600_000,model,...overrides}),{mode:0o600});
}
function signIdentity(claims:Record<string,unknown>={}) {
  const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"test-key",typ:"JWT"})).toString("base64url");
  const payload=Buffer.from(JSON.stringify({iss:"https://auth.openai.com",aud:clientId,sub:"synthetic-subject",nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...claims})).toString("base64url");
  const signer=createSign("RSA-SHA256");signer.update(`${header}.${payload}`);const signature=signer.sign(privateKey).toString("base64url");
  return {token:`${header}.${payload}.${signature}`,jwks:{keys:[{...publicKey.export({format:"jwk"}),kid:"test-key",alg:"RS256",use:"sig"}]}};
}
const modelPayload={models:[{slug:model,display_name:"Synthetic model",visibility:"list"},{slug:"hidden",display_name:"Hidden",visibility:"hidden"}]};
function streamBody(events:unknown[]) {return events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+"data: [DONE]\n\n";}
const response=(text:string,status="completed")=>({id:"resp_test",object:"response",created_at:1,model,status,error:null,incomplete_details:null,output:[{id:"msg_test",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]}]});

test("ID token 只能接受有效签名与 issuer/audience/nonce/expiry",async()=>{
  const valid=signIdentity();assert.equal((await validateIdentity(valid.token,clientId,nonce,valid.jwks)).subject,"synthetic-subject");
  await assert.rejects(validateIdentity(valid.token,clientId,"wrong-nonce",valid.jwks));
  for(const claim of [{iss:"https://attacker.invalid"},{aud:"oaiapp_other"},{exp:1}]){const bad=signIdentity(claim);await assert.rejects(validateIdentity(bad.token,clientId,nonce,bad.jwks));}
  const other=signIdentity();await assert.rejects(validateIdentity(valid.token,clientId,nonce,other.jwks));
});
test("账号模型列表仅使用订阅 token、只返回可见模型并要求显式选择",async()=>{
  await saveFake({model:undefined});let calls=0;
  const fetchMock=mock.method(globalThis,"fetch",async(_url:RequestInfo | URL,init?:RequestInit)=>{calls++;assert.equal(new Headers(init?.headers).get("authorization"),"Bearer synthetic-access");return Response.json(modelPayload);});
  try{const choices=await listModels();assert.deepEqual(choices.models,[{slug:model,displayName:"Synthetic model"}]);await selectModel(model);assert.equal((await connectionStatus()).model,model);assert.equal(calls,2);await assert.rejects(selectModel("hidden"));}finally{fetchMock.mock.restore();}
});
test("模型目录可处理约 656KB 的合法响应，超 2MiB 时中止读取",async()=>{
  await saveFake();let mode:"large"|"overflow"="large",cancelled=false,pulls=0;
  const fetchMock=mock.method(globalThis,"fetch",async()=>{
    if(mode==="large")return Response.json({...modelPayload,synthetic_padding:"x".repeat(655_945)});
    return new Response(new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(65_536));},cancel(){cancelled=true;}}),{headers:{"content-type":"application/json"}});
  });
  try {
    assert.deepEqual((await listModels()).models,[{slug:model,displayName:"Synthetic model"}]);
    mode="overflow";await assert.rejects(listModels(),error=>{assert.equal((error as {code?:string}).code,"SIWC_MODELS");return true;});
    assert.equal(cancelled,true);assert.ok(pulls<=35);
  }finally{fetchMock.mock.restore();}
});
test("模型目录读取中取消可以结束等待并关闭流",async()=>{
  await saveFake();let started!:()=>void,cancelled=false;const ready=new Promise<void>(resolve=>{started=resolve;});
  const fetchMock=mock.method(globalThis,"fetch",async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"models":'));started();},cancel(){cancelled=true;}}),{headers:{"content-type":"application/json"}}));
  const controller=new AbortController();
  try {const operation=listModels(controller.signal);const rejected=assert.rejects(operation,error=>{assert.equal((error as {code?:string}).code,"CANCELLED");return true;});await ready;controller.abort();await rejected;assert.equal(cancelled,true);}finally{fetchMock.mock.restore();}
});
test("流式推理要求官方域名、图片输入、禁用存储并只在完成后成功",async()=>{
  await saveFake();let calls=0;
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo | URL,init?:RequestInit)=>{
    calls++;if(String(url).endsWith("/models"))return Response.json(modelPayload);
    assert.equal(String(url),"https://api.openai.com/v1/responses");assert.equal(new Headers(init?.headers).get("authorization"),"Bearer synthetic-access");
    const body=JSON.parse(String(init?.body));assert.equal(body.stream,true);assert.equal(body.store,false);assert.ok(body.instructions);assert.ok(!("max_output_tokens" in body));assert.equal(body.input[0].role,"user");assert.equal(body.input[0].content[1].type,"input_image");
    const done=response(JSON.stringify({value:"synthetic"}));return new Response(streamBody([{type:"response.created",response:{...done,status:"in_progress",output:[]}},{type:"response.completed",response:done}]),{headers:{"content-type":"text/event-stream"}});
  });
  try{const result=await subscriptionResponse({instructions:"test",input:[{role:"user",content:[{type:"input_text",text:"id=synthetic"},{type:"input_image",image_url:"data:image/png;base64,AA==",detail:"auto"}]}],schema:z.object({value:z.string()}),schemaName:"test",signal:AbortSignal.timeout(5000)});assert.deepEqual(result.output_parsed,{value:"synthetic"});assert.equal(calls,2);}finally{fetchMock.mock.restore();}
});
test("完整逐段事件流按完成事件解析，中途网络断开只输出安全错误类型",async()=>{
  await saveFake();let mode:"success"|"broken"="success";const logs:string[]=[];
  const log=mock.method(console,"error",(...args:unknown[])=>{logs.push(args.map(String).join(" "));});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const text=JSON.stringify({value:"synthetic"});const done=response(text);
    const item={id:"msg_test",type:"message",role:"assistant",status:"in_progress",content:[]};
    const events:unknown[]=[
      {type:"response.created",response:{...done,status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item},
      {type:"response.content_part.added",output_index:0,content_index:0,item_id:"msg_test",part:{type:"output_text",text:"",annotations:[]}},
      {type:"response.output_text.delta",output_index:0,content_index:0,item_id:"msg_test",delta:text},
    ];
    if(mode==="success"){
      events.push({type:"response.output_text.done",output_index:0,content_index:0,item_id:"msg_test",text});
      events.push({type:"response.content_part.done",output_index:0,content_index:0,item_id:"msg_test",part:{type:"output_text",text,annotations:[]}});
      events.push({type:"response.output_item.done",output_index:0,item:done.output[0]});
      events.push({type:"response.completed",response:done});
      return new Response(streamBody(events),{headers:{"content-type":"text/event-stream"}});
    }
    let sent=false;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")));}else controller.error(new TypeError("SYNTHETIC_SECRET_NETWORK_MESSAGE"));}}),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    const request={instructions:"SYNTHETIC_SECRET_PROMPT",input:[{role:"user" as const,content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test",diagnostic:{requestId:randomUUID(),phase:"initial_request" as const}};
    const result=await subscriptionResponse(request);assert.deepEqual(result.output_parsed,{value:"synthetic"});
    mode="broken";await assert.rejects(subscriptionResponse(request));
    assert.ok(logs.some(line=>(line.includes("errorType=type_error")||line.includes("causeType=type_error"))&&line.includes("lastEvent=response.output_text.delta")));
    assert.doesNotMatch(logs.join("\n"),/SYNTHETIC_SECRET|synthetic-access|synthetic-refresh/u);
  }finally{fetchMock.mock.restore();log.mock.restore();}
});
test("中断、失败和流内额度限制都不报告成功",async()=>{
  await saveFake();let outcome="interrupted";
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo | URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const done=response("",outcome==="quota"?"failed":"in_progress");
    const event=outcome==="quota"?{type:"response.failed",response:{...done,error:{code:"subscription_sharing_usage_limit_exceeded",message:"private"}}}:{type:"response.created",response:done};
    return new Response(streamBody(outcome==="quota"?[{type:"response.created",response:{...done,status:"in_progress",error:null}},event]:[event]),{headers:{"content-type":"text/event-stream"}});
  });
  try{for(const value of ["interrupted","quota"]){outcome=value;await assert.rejects(subscriptionResponse({instructions:"test",input:[{role:"user",content:"test"}],schema:z.object({value:z.string()}),schemaName:"test"}),error=>{assert.equal((error as {code?:string}).code,value==="quota"?"SIWC_QUOTA":"SIWC_INTERRUPTED");return true;});}}finally{fetchMock.mock.restore();}
});
test("订阅请求错误和结构化输出失败给出安全分类，不记录私人内容",async()=>{
  await saveFake();let mode:"http"|"parse"|"failed"="http";const logs:string[]=[];const id=randomUUID();
  const log=mock.method(console,"error",(...args:unknown[])=>{logs.push(args.map(String).join(" "));});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    if(mode==="http")return Response.json({error:{message:"SYNTHETIC_SECRET_PROVIDER"}},{status:400});
    const base=response(mode==="parse"?"INVALID_PRIVATE_CONTENT":"",mode==="failed"?"failed":"completed");
    const events=[{type:"response.created",response:{...base,status:"in_progress",error:null,output:[]}},{type:mode==="failed"?"response.failed":"response.completed",response:{...base,error:mode==="failed"?{code:"internal_error",message:"SYNTHETIC_SECRET_PROVIDER"}:null}}];
    return new Response(streamBody(events),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    for(const current of ["http","parse","failed"] as const){mode=current;await assert.rejects(subscriptionResponse({instructions:"SYNTHETIC_SECRET_PROMPT",input:[{role:"user",content:"SYNTHETIC_SECRET_INPUT"}],schema:z.object({value:z.string()}),schemaName:"test",diagnostic:{requestId:id,phase:"initial_request"}}),error=>{assert.equal((error as {code?:string}).code,current==="http"?"SIWC_REQUEST":current==="parse"?"INCOMPLETE":"SIWC_FAILED");return true;});}
    assert.ok(logs.some(line=>line.includes(`requestId=${id}`)&&line.includes("category=http")&&line.includes("providerStatus=400")));
    assert.ok(logs.some(line=>line.includes("category=output_parse")));
    assert.ok(logs.some(line=>line.includes("category=stream_failed")));
    assert.doesNotMatch(logs.join("\n"),/SYNTHETIC_SECRET|INVALID_PRIVATE_CONTENT|synthetic-access|synthetic-refresh/u);
  }finally{fetchMock.mock.restore();log.mock.restore();}
});
test("流内错误和 SDK 事件校验失败只输出白名单诊断",async()=>{
  await saveFake();let scenario:"provider"|"identity"="provider";const lines:string[]=[];const requestId=randomUUID();
  const log=mock.method(console,"error",(...args:unknown[])=>{lines.push(args.map(String).join(" "));});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const base=response(JSON.stringify({value:"private-output"}));
    const initial={type:"response.created",response:{...base,status:"in_progress",output:[]}};
    const last=scenario==="provider"?{type:"error",error:{code:"SYNTHETIC_SECRET_CODE",message:"SYNTHETIC_SECRET_PROVIDER"}}:{type:"response.completed",response:{...base,id:"different-id"}};
    return new Response(streamBody([initial,last]),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    for(const item of ["provider","identity"] as const){scenario=item;await assert.rejects(subscriptionResponse({instructions:"SYNTHETIC_SECRET_PROMPT",input:[{role:"user",content:"SYNTHETIC_SECRET_INPUT"}],schema:z.object({value:z.string()}),schemaName:"test",diagnostic:{requestId,phase:"initial_request"}}));}
    assert.ok(lines.some(line=>line.includes("category=provider_stream_error")&&line.includes("lastEvent=response.created")));
    assert.ok(lines.some(line=>line.includes("category=application")&&line.includes("lastEvent=response.completed")));
    assert.doesNotMatch(lines.join("\n"),/SYNTHETIC_SECRET|private-output|synthetic-access|synthetic-refresh|different-id/u);
  }finally{fetchMock.mock.restore();log.mock.restore();}
});
test("未知事件与无关增量安全忽略，只有匹配的完成事件才接受",async()=>{
  await saveFake();let scenario:"missing"|"unknown"="missing";const logs:string[]=[];
  const log=mock.method(console,"error",(...args:unknown[])=>{logs.push(args.map(String).join(" "));});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const base=response("SYNTHETIC_SECRET_OUTPUT");
    const first={type:"response.created",response:{...base,status:"in_progress",output:[]}};
    const last=scenario==="missing"
      ?{type:"response.output_text.delta",output_index:9,content_index:0,item_id:"SYNTHETIC_SECRET_ID",delta:"SYNTHETIC_SECRET_OUTPUT"}
      :{type:"response.SYNTHETIC_SECRET_EVENT",synthetic_private:"SYNTHETIC_SECRET_OUTPUT"};
    return new Response(streamBody([first,last,{type:"response.completed",response:response(JSON.stringify({value:"synthetic"}))}]),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    for(const item of ["missing","unknown"] as const){scenario=item;const result=await subscriptionResponse({instructions:"SYNTHETIC_SECRET_PROMPT",input:[{role:"user",content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test",diagnostic:{requestId:randomUUID(),phase:"initial_request"}});assert.deepEqual(result.output_parsed,{value:"synthetic"});}
    assert.doesNotMatch(logs.join("\n"),/SYNTHETIC_SECRET|synthetic-access|synthetic-refresh/u);
  }finally{fetchMock.mock.restore();log.mock.restore();}
});
test("未知事件后没有完成信号不能伪造成功，超大事件流有上限",async()=>{
  await saveFake();let oversized=false;
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const base=response("synthetic");
    const events=[{type:"response.created",response:{...base,status:"in_progress",output:[]}},{type:"response.future_event",padding:oversized?"x".repeat(2*1024*1024):""}];
    return new Response(streamBody(events),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    const args={instructions:"test",input:[{role:"user" as const,content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test"};
    await assert.rejects(subscriptionResponse(args),error=>{assert.equal((error as {code?:string}).code,"SIWC_INTERRUPTED");return true;});
    oversized=true;await assert.rejects(subscriptionResponse(args));
  }finally{fetchMock.mock.restore();}
});
test("完成快照缺少文字时仅记录固定类型和安全计数",async()=>{
  await saveFake();const logs:string[]=[];const log=mock.method(console,"error",(...args:unknown[])=>{logs.push(args.map(String).join(" "));});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const base=response("SYNTHETIC_SECRET_OUTPUT");
    const events=[{type:"response.created",response:{...base,status:"in_progress",output:[]}},{type:"response.output_text.delta",output_index:0,content_index:0,item_id:"SYNTHETIC_SECRET_ID",delta:"SYNTHETIC_SECRET_OUTPUT"},{type:"response.completed",response:{...base,output:[]}}];
    return new Response(streamBody(events),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    await assert.rejects(subscriptionResponse({instructions:"SYNTHETIC_SECRET_PROMPT",input:[{role:"user",content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test",diagnostic:{requestId:randomUUID(),phase:"initial_request"}}));
    assert.ok(logs.some(line=>line.includes("detail=invalid_output_text")&&line.includes("deltaCount=1")&&line.includes("textDoneCount=0")&&line.includes("messageCount=0")&&line.includes("textCount=0")));
    assert.doesNotMatch(logs.join("\n"),/SYNTHETIC_SECRET|synthetic-access|synthetic-refresh/u);
  }finally{fetchMock.mock.restore();log.mock.restore();}
});
test("最终快照没有内容时仅使用已完成且一致的单个文字流",async()=>{
  await saveFake();let scenario="success";const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const base=response("");const value=JSON.stringify({value:"synthetic"});
    const created={type:"response.created",response:{...base,status:"in_progress",output:[]}};
    const delta={type:"response.output_text.delta",output_index:0,content_index:0,item_id:"message_synthetic",delta:value};
    const done={type:"response.output_text.done",output_index:0,content_index:0,item_id:scenario==="bad_id"?"other_message":"message_synthetic",text:scenario==="mismatch"?"different":value};
    const complete={type:"response.completed",response:{...base,output:[]}};
    const events:unknown[]=[created,delta];
    if(scenario!=="no_done")events.push(done);
    if(scenario==="multiple")events.push({...delta,item_id:"another_message"});
    if(scenario==="refusal")events.push({type:"response.refusal.done",item_id:"message_synthetic",output_index:0,content_index:0,refusal:"private"});
    if(scenario!=="interrupted")events.push(complete);
    if(scenario==="error")events.push({type:"error",code:"other",message:"private"});
    return new Response(streamBody(events),{headers:{"content-type":"text/event-stream"}});
  });
  try{
    const args={instructions:"test",input:[{role:"user" as const,content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test"};
    const result=await subscriptionResponse(args);assert.deepEqual(result.output_parsed,{value:"synthetic"});
    for(const item of ["no_done","bad_id","mismatch","multiple","refusal","interrupted","error"]){scenario=item;await assert.rejects(subscriptionResponse(args));}
  }finally{fetchMock.mock.restore();}
});
test("流内普通错误和额度错误即使出现在完成之后也必须失败",async()=>{
  await saveFake();let quota=false;
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    const done=response(JSON.stringify({value:"synthetic"}));
    return new Response(streamBody([{type:"response.created",response:{...done,status:"in_progress",output:[]}},{type:"response.completed",response:done},{type:"error",code:quota?"subscription_sharing_usage_limit_exceeded":"other",message:"SYNTHETIC_SECRET_MESSAGE",param:null,sequence_number:1}]),{headers:{"content-type":"text/event-stream"}});
  });
  try{const args={instructions:"test",input:[{role:"user" as const,content:"synthetic"}],schema:z.object({value:z.string()}),schemaName:"test"};for(const value of [false,true]){quota=value;await assert.rejects(subscriptionResponse(args),error=>{assert.equal((error as {code?:string}).code,value?"SIWC_QUOTA":"SIWC_FAILED");return true;});}}finally{fetchMock.mock.restore();}
});
test("过期 token 原子刷新；云模式拒绝本机授权接口",async()=>{
  await saveFake({expiresAt:Date.now()-1});let calls=0;
  const fetchMock=mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({access_token:"new-synthetic",refresh_token:"new-refresh",token_type:"Bearer",expires_in:3600});});
  try{const [a,b]=await Promise.all([accessToken(),accessToken()]);assert.equal(a.accessToken,"new-synthetic");assert.equal(b.accessToken,"new-synthetic");assert.equal(calls,1);}finally{fetchMock.mock.restore();}
  process.env.APP_MODE="cloud";try{const res=await endpointGet(new Request("http://127.0.0.1:3002/api/local-chatgpt/status"),{params:Promise.resolve({action:"status"})});assert.equal(res.status,410);}finally{process.env.APP_MODE="local";}
});
test("用户主动刷新过期连接，网络失败与授权撤销分别提示",async()=>{
  await saveFake({expiresAt:Date.now()-1});let mode="network";
  const fetchMock=mock.method(globalThis,"fetch",async()=>{
    if(mode==="network")throw new TypeError("synthetic network error");
    if(mode==="revoked")return Response.json({error:"invalid_grant"},{status:400});
    if(mode==="forbidden")return Response.json({error:"policy"},{status:403});
    return Response.json({access_token:"new-synthetic",refresh_token:"new-refresh",token_type:"Bearer",expires_in:3600});
  });
  try{
    assert.equal((await connectionStatus()).state,"reauthorize");
    await assert.rejects(refreshConnection(),error=>{assert.equal((error as {code?:string}).code,"PROVIDER_NETWORK");return true;});
    mode="forbidden";await assert.rejects(refreshConnection(),error=>{assert.equal((error as {code?:string}).code,"SIWC_PERMISSION");return true;});
    await saveFake();assert.equal((await connectionStatus()).state,"connected");
    await saveFake({expiresAt:Date.now()-1});
    mode="success";assert.equal((await refreshConnection()).state,"connected");
    await saveFake({expiresAt:Date.now()-1});mode="revoked";
    await assert.rejects(refreshConnection(),error=>{assert.equal((error as {code?:string}).code,"SIWC_AUTH");return true;});
    assert.equal((await connectionStatus()).state,"reauthorize");
  }finally{fetchMock.mock.restore();}
});
test("模型列表 401 需要重新授权，403 和网络故障不视为撤销",async()=>{
  for(const scenario of ["unauthorized","forbidden","network"] as const){
    const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
      if(String(url).endsWith("/.well-known/openid-configuration"))throw new TypeError("synthetic discovery unavailable");
      if(scenario==="network")throw new TypeError("synthetic network failure");
      return Response.json({error:{message:"synthetic private response"}},{status:scenario==="unauthorized"?401:403});
    });
    try{
      await disconnect();await saveFake();
      await assert.rejects(listModels(),error=>{assert.equal((error as {code?:string}).code,scenario==="unauthorized"?"SIWC_AUTH":scenario==="forbidden"?"SIWC_PERMISSION":"SIWC_MODELS");return true;});
      assert.equal((await connectionStatus()).state,scenario==="unauthorized"?"reauthorize":"connected");
    }finally{fetchMock.mock.restore();}
  }
});
test("模型请求的 401 标记重授权，403 仅提示权限问题",async()=>{
  for(const status of [401,403]){
    const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{
      if(String(url).endsWith("/.well-known/openid-configuration"))throw new TypeError("synthetic discovery unavailable");
      if(String(url).endsWith("/models"))return Response.json(modelPayload);
      return Response.json({error:{message:"synthetic private response"}},{status});
    });
    try {
      await disconnect();await saveFake();
      await assert.rejects(subscriptionResponse({instructions:"test",input:[{role:"user",content:"test"}],schema:z.object({value:z.string()}),schemaName:"test"}),error=>{assert.equal((error as {code?:string}).code,status===401?"SIWC_AUTH":"SIWC_PERMISSION");return true;});
      assert.equal((await connectionStatus()).state,status===401?"reauthorize":"connected");
    }finally{fetchMock.mock.restore();}
  }
});
test("退出清除本机令牌且不披露原始响应，远程撤销失败会提示",async()=>{
  await saveFake();const fetchMock=mock.method(globalThis,"fetch",async()=>{throw new Error("private provider response");});
  try{const result=await disconnect();assert.deepEqual(result,{ok:true,remoteRevoked:false});assert.equal((await connectionStatus()).state,"disconnected");}finally{fetchMock.mock.restore();}
});
test("主动断开会取消仍在进行的本地订阅推理",async()=>{
  await saveFake();let entered!:()=>void,aborted=false;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).endsWith("/models"))return Response.json(modelPayload);
    if(String(url).endsWith("/.well-known/openid-configuration"))return Response.json({issuer:"https://auth.openai.com",revocation_endpoint:"https://auth.openai.com/api/accounts/oauth/revoke"});
    if(String(url).endsWith("/oauth/revoke"))return new Response(null,{status:200});
    const stream=new ReadableStream<Uint8Array>({start(controller){
      const pending=response("","in_progress");controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"response.created",response:pending})}\n\n`));
      init?.signal?.addEventListener("abort",()=>{aborted=true;controller.error(new Error("synthetic abort"));},{once:true});entered();
    }});
    return new Response(stream,{headers:{"content-type":"text/event-stream"}});
  });
  try{
    const operation=subscriptionResponse({instructions:"test",input:[{role:"user",content:"test"}],schema:z.object({value:z.string()}),schemaName:"test"});
    const rejected=assert.rejects(operation,error=>{assert.equal((error as {code?:string}).code,"CANCELLED");return true;});
    await waiting;await disconnect();await rejected;assert.equal(aborted,true);
  }finally{fetchMock.mock.restore();}
});
test("撤销只接受可信 OpenAI discovery 端点，恶意地址不接收 token",async()=>{
  for(const endpoint of ["https://attacker.invalid/revoke","http://auth.openai.com/revoke","https://user@auth.openai.com/revoke","https://auth.openai.com.evil.invalid/revoke"]){
    await saveFake();let calls=0;
    const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{calls++;assert.equal(String(url),"https://auth.openai.com/.well-known/openid-configuration");return Response.json({issuer:"https://auth.openai.com",revocation_endpoint:endpoint});});
    try {assert.deepEqual(await disconnect(),{ok:true,remoteRevoked:false});assert.equal(calls,1);assert.equal((await connectionStatus()).state,"disconnected");}finally {fetchMock.mock.restore();}
  }
  await saveFake();const calls:string[]=[];
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push(String(url));if(calls.length===1)return Response.json({issuer:"https://auth.openai.com",revocation_endpoint:"https://auth.openai.com/api/accounts/oauth/revoke"});assert.equal(new URLSearchParams(String(init?.body)).get("token"),"synthetic-refresh");return new Response(null,{status:200});});
  try {assert.deepEqual(await disconnect(),{ok:true,remoteRevoked:true});assert.equal(calls.length,2);}finally {fetchMock.mock.restore();}
});
test("图文订阅通道停用，不发起供应商请求",async()=>{const response=await generatePost(new Request('http://localhost/api/generate',{method:'POST',headers:{'X-AI-Source':'chatgpt'}}));assert.equal(response.status,400);});
test("真实回环回调的模拟注册与重新授权保持身份、state 和 PKCE",async()=>{
  await rm(path.join(directory,"connection.json"),{force:true});
  let expectedNonce="",exchanges=0;const signed=()=>signIdentity({nonce:expectedNonce});let token= signed();
  const fetchMock=mock.method(globalThis,"fetch",async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).endsWith("/oauth/token")){
      exchanges++;const body=new URLSearchParams(String(init?.body));assert.equal(body.get("client_id"),clientId);assert.equal(body.get("grant_type"),"authorization_code");assert.equal(body.get("resource"),"https://api.openai.com/v1");assert.ok(body.get("code_verifier"));
      return Response.json({access_token:"synthetic-access",refresh_token:"synthetic-refresh",id_token:token.token,scope:"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",token_type:"Bearer",expires_in:3600});
    }
    if(String(url).endsWith("/.well-known/jwks.json"))return Response.json(token.jwks);
    throw new Error("synthetic network endpoint unexpected");
  });
  const callback=async(url:string)=>new Promise<number>((resolve,reject)=>{httpGet(url,res=>{res.resume();res.on("end",()=>resolve(res.statusCode??0));}).on("error",reject);});
  const wait=async()=>{for(let i=0;i<100;i++){const result=await connectionStatus();if(result.state!=="pending")return result;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("synthetic callback timed out");};
  try{
    let started=await startAuthorization();let authorization=new URL(started.url);assert.equal(authorization.origin,"https://auth.openai.com");assert.equal(authorization.searchParams.get("client_id"),"dynamic_agent_client");expectedNonce=authorization.searchParams.get("nonce")!;token=signed();
    let redirect=authorization.searchParams.get("redirect_uri")!;assert.match(redirect,/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u);
    assert.equal(await callback(`${redirect}?state=wrong&code=synthetic&client_id=${clientId}`),400);assert.equal(exchanges,0);
    const state=authorization.searchParams.get("state");assert.equal(await callback(`${redirect}?state=${state}&code=synthetic&client_id=${clientId}`),200);assert.equal((await wait()).state,"connected");assert.equal(exchanges,1);
    started=await startAuthorization();authorization=new URL(started.url);assert.equal(authorization.searchParams.get("client_id"),clientId);assert.equal(authorization.searchParams.has("agent_name_hint"),false);expectedNonce=authorization.searchParams.get("nonce")!;token=signed();redirect=authorization.searchParams.get("redirect_uri")!;
    assert.equal(await callback(`${redirect}?state=${authorization.searchParams.get("state")}&code=synthetic`),200);assert.equal((await wait()).state,"connected");assert.equal(exchanges,2);
  }finally{fetchMock.mock.restore();}
});

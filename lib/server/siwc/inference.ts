import "server-only";
import OpenAI from "openai";
import { OpenAIError } from "openai/error";
import type { ResponseInput, ParsedResponse, Response as ModelResponse, ResponseFunctionWebSearch, ResponseOutputText } from "openai/resources/responses/responses";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { accessToken, assertPersonalMode, listModels, markNeedsReauth, trackInference } from "./auth";

/** Map known SDK diagnostics to fixed labels; never return dynamic error text. */
function safeStreamDetail(message:string):string {
  const exact:Record<string,string>={
    "Cannot complete response with unfinished output items.":"unfinished_items",
    "Cannot complete response with a missing output identity.":"missing_identity",
    "Lifecycle response identity changed.":"identity_changed",
    "Lifecycle events require their own response field.":"missing_response",
    "Lifecycle events require a response object.":"invalid_response",
    "request ended without sending any events":"no_events",
    "stream ended without producing a Response":"no_response",
    "Unhandled response stream event: unknown":"unknown_event",
    "Invalid response output index.":"invalid_output_index",
    "Response snapshot has conflicting output positions.":"conflicting_output_positions",
    "Cannot ignore a response event before response.created.":"event_before_response",
    "stream has ended, this shouldn't happen":"stream_already_ended",
    "Cannot iterate over a consumed stream, use `.tee()` to split the stream.":"stream_already_consumed",
    "Attempted to iterate over a response with no body":"missing_body",
  };
  if(Object.hasOwn(exact,message))return exact[message];
  if(/^missing (output|content|summary) at index \d+$/u.test(message))return "missing_index";
  if(/^Duplicate response output index \d+\.$/u.test(message))return "duplicate_output_index";
  if(/^expected a non-empty (output item id|output item call_id|item_id) for /u.test(message))return "missing_item_identity";
  if(/^expected an own output item type for /u.test(message))return "missing_item_type";
  if(/^expected (output item (type|id|call_id)|item_id) /u.test(message))return "item_identity_mismatch";
  if(/^expected content to be '/u.test(message))return "content_type_mismatch";
  if(/^duplicate output item identity /u.test(message))return "duplicate_item_identity";
  if(/^When snapshot hasn't been set yet, expected /u.test(message))return "missing_response_created";
  return "other";
}

function safeApplicationDetail(message:string):string {
  const labels:Record<string,string>={
    "ChatGPT 响应过大，已有内容保留。":"stream_too_large",
    "ChatGPT 响应事件过多，已有内容保留。":"too_many_events",
    "ChatGPT 返回的响应标识无效；原内容已保留。":"invalid_created_id",
    "ChatGPT 返回的完成状态不完整；原内容已保留。":"invalid_completed_state",
    "ChatGPT 返回内容不完整；原内容已保留。":"missing_output",
    "ChatGPT 返回的结构化内容不完整；原内容已保留。":"invalid_output_text",
    "ChatGPT 响应中断，未收到完成信号；原内容已保留。":"missing_completion",
  };
  return Object.hasOwn(labels,message)?labels[message]:"other";
}

type SubscriptionInput = {instructions:string;input:ResponseInput;signal?:AbortSignal;diagnostic?:{requestId?:string;phase:"initial_request"|"tag_repair_request"}};
export type SubscriptionSearchResponse = {
  text: string;
  searches: ResponseFunctionWebSearch[];
  citations: ResponseOutputText.URLCitation[];
};

/** Official ChatGPT-plan Responses route. Never receives or uses the relay key. */
export async function subscriptionResponse<T>(request:SubscriptionInput & {schema:z.ZodType<T>;schemaName:string}):Promise<ParsedResponse<T>> {
  return runSubscription({...request,kind:"structured"}) as Promise<ParsedResponse<T>>;
}

/** Dedicated plain-text search request; citation metadata is supplied by the platform, never parsed from model prose. */
export async function subscriptionSearchResponse(request:SubscriptionInput):Promise<SubscriptionSearchResponse> {
  return runSubscription({...request,kind:"search"}) as Promise<SubscriptionSearchResponse>;
}

async function runSubscription<T>(request:SubscriptionInput & ({kind:"structured";schema:z.ZodType<T>;schemaName:string}|{kind:"search"})):Promise<ParsedResponse<T>|SubscriptionSearchResponse> {
  const {instructions,input,signal,diagnostic}=request;
  assertPersonalMode();
  const tracked=trackInference(signal);let usage=false,streamFailed=false;
  let lastEvent="none";
  let deltaCount=0,textDoneCount=0,messageCount=0,textCount=0,textTooLong=false,textNotString=false;
  let streamText="",streamDoneText:string|undefined,streamItemId:string|undefined,streamOutputIndex:number|undefined,streamContentIndex:number|undefined,streamRefusal=false;
  const safeEvents=new Set(["response.created","response.in_progress","response.queued","response.output_item.added","response.output_item.done","response.content_part.added","response.content_part.done","response.output_text.delta","response.output_text.done","response.reasoning_summary_text.delta","response.reasoning_summary_text.done","response.completed","response.failed","response.incomplete"]);
  const started=performance.now();let step:"authorization"|"catalogue"|"response_stream"="authorization";
  const searchItems=new Map<string,ResponseFunctionWebSearch>();
  const searchIds=new Set<string>();
  const citationEvents:Array<{itemId:string;outputIndex:number;contentIndex:number;citation:ResponseOutputText.URLCitation}>=[];
  const rememberSearch=(item:ResponseFunctionWebSearch)=>{
    if(typeof item.id!=="string"||!item.id||item.id.length>200)throw new AppError("INCOMPLETE","ChatGPT 检索返回的工具标识无效。",502);
    searchIds.add(item.id);
    // SIWC does not support max_tool_calls. Stop consuming the request when the observed budget is exceeded.
    if(searchIds.size>3)throw new AppError("SIWC_SEARCH_LIMIT","ChatGPT 本次检索步骤过多，已停止等待；未自动重试。",502);
    if(item.status==="completed"){
      const previous=searchItems.get(item.id);
      // Some completed snapshots omit tool sources already delivered by output_item.done.
      if(!previous||item.action?.type!=="search"||Array.isArray(item.action.sources))searchItems.set(item.id,item);
    }
  };
  const rememberCitations=(annotations:ResponseOutputText["annotations"],itemId:string,outputIndex:number,contentIndex:number)=>{
    for(const annotation of annotations){
      if(annotation?.type!=="url_citation")continue;
      if(citationEvents.length>=100)throw new AppError("INCOMPLETE","ChatGPT 检索返回的引用过多。",502);
      citationEvents.push({itemId,outputIndex,contentIndex,citation:annotation});
    }
  };
  try {
    if(tracked.signal.aborted)throw new AppError("CANCELLED","本次生成已取消，已有内容保留。",499);
    const auth=await accessToken();
    if(!auth.model)throw new AppError("SIWC_MODEL","请先选择 ChatGPT 账号可用的模型。",400);
    step="catalogue";const catalogue=await listModels(tracked.signal);
    if(!catalogue.models.some(item=>item.slug===auth.model))throw new AppError("SIWC_MODEL","当前账号已无法使用所选模型，请重新选择。",400);
    if(tracked.signal.aborted)throw new AppError("CANCELLED","本次生成已取消，已有内容保留。",499);
    // Bound bytes before the SDK's SSE decoder so an unterminated event cannot grow without limit.
    const limitedFetch:typeof fetch=async (request,init)=>{
      const response=await fetch(request,init);
      if(!response.body||!response.ok)return response;
      let bytes=0;
      const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>2*1024*1024)throw new AppError("INCOMPLETE","ChatGPT 响应过大，已有内容保留。",502);controller.enqueue(chunk);}}));
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    };
    step="response_stream";const client=new OpenAI({apiKey:auth.accessToken,baseURL:"https://api.openai.com/v1",maxRetries:0,timeout:90_000,logLevel:"off",organization:null,project:null,adminAPIKey:null,fetch:limitedFetch,fetchOptions:{redirect:"manual"}});
    // Consume raw events and ignore forward-compatible unknown types. A completed response
    // may omit output text, so accept matching finalized deltas only after response.completed.
    const stream=await client.responses.create({model:auth.model,instructions,input,store:false,stream:true,
      ...(request.kind==="structured"?{text:{format:zodTextFormat(request.schema,request.schemaName)}}:{
        tools:[{type:"web_search" as const,search_context_size:"low" as const,filters:{allowed_domains:["gov.cn","12306.cn","news.cn","people.com.cn"]}}],
        tool_choice:"required" as const,include:["web_search_call.action.sources" as const],
      }),
    },{signal:tracked.signal});
    let final:ModelResponse|undefined;let responseId:string|undefined;let count=0;
    for await(const event of stream){
      if(++count>20_000)throw new AppError("INCOMPLETE","ChatGPT 响应事件过多，已有内容保留。",502);
      lastEvent=safeEvents.has(event.type)?event.type:"other";
      if(request.kind==="search"){
        if((event.type==="response.output_item.added"||event.type==="response.output_item.done")&&event.item.type==="web_search_call")rememberSearch(event.item);
        if(event.type==="response.output_text.annotation.added"&&event.annotation?.type==="url_citation")rememberCitations([event.annotation],event.item_id,event.output_index,event.content_index);
        if(event.type==="response.content_part.done"&&event.part.type==="output_text"&&Array.isArray(event.part.annotations))rememberCitations(event.part.annotations,event.item_id,event.output_index,event.content_index);
        if(event.type==="response.output_item.done"&&event.item.type==="message"&&Array.isArray(event.item.content))event.item.content.forEach((part,index)=>{
          if(part.type==="output_text"&&Array.isArray(part.annotations)&&typeof event.item.id==="string")rememberCitations(part.annotations,event.item.id,event.output_index,index);
        });
      }
      if(event.type==="response.refusal.delta"||event.type==="response.refusal.done")streamRefusal=true;
      if((event.type==="response.content_part.added"||event.type==="response.content_part.done")&&event.part.type==="refusal")streamRefusal=true;
      if(event.type==="response.output_text.delta"||event.type==="response.output_text.done"){
        const validKey=typeof event.item_id==="string"&&event.item_id.length>0&&Number.isSafeInteger(event.output_index)&&event.output_index>=0&&Number.isSafeInteger(event.content_index)&&event.content_index>=0;
        if(!validKey||streamDoneText!==undefined)throw new AppError("INCOMPLETE","ChatGPT 返回的文字流标识无效；原内容已保留。",502);
        if(streamItemId===undefined){streamItemId=event.item_id;streamOutputIndex=event.output_index;streamContentIndex=event.content_index;}
        if(event.item_id!==streamItemId||event.output_index!==streamOutputIndex||event.content_index!==streamContentIndex)throw new AppError("INCOMPLETE","ChatGPT 返回的文字流标识无效；原内容已保留。",502);
        if(event.type==="response.output_text.delta"){
          deltaCount++;
          if(typeof event.delta!=="string"||streamText.length+event.delta.length>512*1024)throw new AppError("INCOMPLETE","ChatGPT 返回的文字流过大或无效；原内容已保留。",502);
          streamText+=event.delta;
        } else {
          textDoneCount++;
          if(typeof event.text!=="string"||event.text.length>512*1024||deltaCount===0||event.text!==streamText)throw new AppError("INCOMPLETE","ChatGPT 返回的文字流前后不一致；原内容已保留。",502);
          streamDoneText=event.text;
        }
      }
      if(event.type==="response.created"){
        if(responseId||typeof event.response.id!=="string"||!event.response.id)throw new AppError("INCOMPLETE","ChatGPT 返回的响应标识无效；原内容已保留。",502);
        responseId=event.response.id;
      }
      if(event.type==="error"){
        streamFailed=true;usage=event.code==="subscription_sharing_usage_limit_exceeded"||event.code==="subscription_sharing_usage_unavailable";
        if(usage)throw new AppError("SIWC_QUOTA","ChatGPT 套餐当前用量不可用或已达限制；原内容已保留。",429);
        throw new AppError("SIWC_FAILED","ChatGPT 未能完成生成；原内容已保留。",502);
      }
      if(event.type==="response.failed"){
        streamFailed=true;const code=String(event.response.error?.code??"");usage=code==="subscription_sharing_usage_limit_exceeded"||code==="subscription_sharing_usage_unavailable";
        if(usage)throw new AppError("SIWC_QUOTA","ChatGPT 套餐当前用量不可用或已达限制；原内容已保留。",429);
        throw new AppError("SIWC_FAILED","ChatGPT 未能完成生成；原内容已保留。",502);
      }
      if(event.type==="response.incomplete")throw new AppError("INCOMPLETE","ChatGPT 返回内容不完整；原内容已保留。",502);
      if(event.type==="response.completed"){
        if(final || !responseId || event.response.id!==responseId || event.response.status!=="completed")throw new AppError("INCOMPLETE","ChatGPT 返回的完成状态不完整；原内容已保留。",502);
        final=event.response;
      }
    }
    if(tracked.signal.aborted)throw new AppError("CANCELLED","本次生成已取消，已有内容保留。",499);
    if(!final)throw new AppError("SIWC_INTERRUPTED","ChatGPT 响应中断，未收到完成信号；原内容已保留。",502);
    if(!Array.isArray(final.output))throw new AppError("INCOMPLETE","ChatGPT 返回内容不完整；原内容已保留。",502);
    messageCount=final.output.filter(item=>item.type==="message").length;
    const parts=final.output.flatMap(item=>item.type==="message"&&Array.isArray(item.content)?item.content:[]);
    if(parts.some(part=>part.type==="refusal")){
      if(request.kind==="search")throw new AppError("REFUSAL","ChatGPT 未能处理本次联网检索。",422);
      return {...final,output_parsed:null} as ParsedResponse<T>;
    }
    if(streamRefusal)throw new AppError("REFUSAL","模型无法处理这次内容，请调整图片或创作要求后重试。",422);
    const texts=parts.filter(part=>part.type==="output_text").map(part=>part.text);
    textCount=texts.length;textTooLong=texts.some(text=>typeof text==="string"&&text.length>512*1024);textNotString=texts.some(text=>typeof text!=="string");
    if(texts.length>1||textNotString||textTooLong||(texts.length===0&&streamDoneText===undefined))throw new AppError("INCOMPLETE","ChatGPT 返回的结构化内容不完整；原内容已保留。",502);
    if(texts.length===1&&streamDoneText!==undefined&&texts[0]!==streamDoneText)throw new AppError("INCOMPLETE","ChatGPT 返回的文字流前后不一致；原内容已保留。",502);
    const text=texts[0]??streamDoneText!;
    if(request.kind==="search"){
      final.output.forEach(item=>{if(item.type==="web_search_call")rememberSearch(item);});
      const finalMessageIndex=final.output.findIndex(item=>item.type==="message");
      const finalMessage=final.output[finalMessageIndex];
      const finalContentIndex=finalMessage?.type==="message"?finalMessage.content.findIndex(part=>part.type==="output_text"):-1;
      if(finalMessage?.type==="message"&&finalContentIndex>=0){
        if(streamItemId!==undefined&&(streamItemId!==finalMessage.id||streamOutputIndex!==finalMessageIndex||streamContentIndex!==finalContentIndex))throw new AppError("INCOMPLETE","ChatGPT 检索的引用与文字标识不一致。",502);
        streamItemId=finalMessage.id;streamOutputIndex=finalMessageIndex;streamContentIndex=finalContentIndex;
        const part=finalMessage.content[finalContentIndex];
        if(part.type==="output_text"&&Array.isArray(part.annotations))rememberCitations(part.annotations,finalMessage.id,finalMessageIndex,finalContentIndex);
      }
      const citations=citationEvents.filter(item=>item.itemId===streamItemId&&item.outputIndex===streamOutputIndex&&item.contentIndex===streamContentIndex).map(item=>item.citation);
      return {text,searches:[...searchItems.values()],citations};
    }
    const parsed=request.schema.parse(JSON.parse(text));
    return {...final,output_parsed:parsed} as ParsedResponse<T>;
  } catch(error) {
    // The SDK wraps parser failures in OpenAIError and preserves the original as cause.
    const cause=error instanceof Error?error.cause:undefined;
    const causeType=cause instanceof SyntaxError?"syntax_error":cause instanceof TypeError?"type_error":cause instanceof z.ZodError?"zod_error":cause instanceof Error?"other_error":"none";
    const errorType=error instanceof SyntaxError?"syntax_error":error instanceof TypeError?"type_error":error instanceof z.ZodError?"zod_error":error instanceof Error?"other_error":"none";
    const invalidOutput=error instanceof SyntaxError||error instanceof z.ZodError||cause instanceof SyntaxError||cause instanceof z.ZodError;
    const category=usage?"quota":tracked.signal.aborted?"cancelled":error instanceof OpenAI.APIConnectionTimeoutError?"timeout":error instanceof OpenAI.APIError&&typeof error.status==="number"?"http":streamFailed?"stream_failed":invalidOutput?"output_parse":error instanceof OpenAI.APIConnectionError?"network":error instanceof OpenAI.APIError?"provider_stream_error":error instanceof OpenAIError?"sdk_stream_error":error instanceof AppError?"application":"stream_or_sdk";
    // Exact comparisons only: never emit raw error messages, event bodies or provider codes.
    const detail=error instanceof AppError ? safeApplicationDetail(error.message) : error instanceof OpenAIError && !(error instanceof OpenAI.APIError) ? safeStreamDetail(error.message) : "none";
    const status=error instanceof OpenAI.APIError&&typeof error.status==="number"&&error.status>=100&&error.status<=599?error.status:"none";
    const safeId=diagnostic?.requestId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(diagnostic.requestId)?diagnostic.requestId:undefined;
    if(safeId)console.error(`[siwc_inference] requestId=${safeId} phase=${diagnostic!.phase} step=${step} category=${category} detail=${detail} errorType=${errorType} causeType=${causeType} lastEvent=${lastEvent} providerStatus=${status} deltaCount=${deltaCount} textDoneCount=${textDoneCount} messageCount=${messageCount} textCount=${textCount} textTooLong=${textTooLong} textNotString=${textNotString} elapsedMs=${Math.round(performance.now()-started)}`);
    if(usage)throw new AppError("SIWC_QUOTA","ChatGPT 套餐当前用量不可用或已达限制；原内容已保留。",429);
    if(error instanceof AppError)throw error;
    if(tracked.signal.aborted)throw new AppError("CANCELLED","本次生成已取消，已有内容保留。",499);
    if(error instanceof OpenAI.APIConnectionTimeoutError)throw new AppError("TIMEOUT","等待 ChatGPT 回复超时，已有内容保留。",504);
    if(error instanceof OpenAI.AuthenticationError){markNeedsReauth();throw new AppError("SIWC_AUTH","ChatGPT 授权已失效，请重新连接。",401);}
    if(error instanceof OpenAI.PermissionDeniedError)throw new AppError("SIWC_PERMISSION","当前账号或工作区无权使用此模型，请检查使用权限；已有内容保留。",403);
    if(error instanceof OpenAI.APIError && ["subscription_sharing_usage_limit_exceeded","subscription_sharing_usage_unavailable"].includes(String(error.code)))throw new AppError("SIWC_QUOTA","ChatGPT 套餐当前用量不可用或已达限制；原内容已保留。",429);
    if(error instanceof OpenAI.RateLimitError)throw new AppError("SIWC_QUOTA","ChatGPT 套餐用量受限，请稍后重试；已有内容保留。",429);
    if(error instanceof OpenAI.APIConnectionError)throw new AppError("PROVIDER_NETWORK","无法连接 ChatGPT，请检查网络；已有内容保留。",502);
    if(error instanceof OpenAI.APIError && (error.status===400||error.status===422))throw new AppError("SIWC_REQUEST","ChatGPT 未接受本次请求，请检查所选模型和输入是否兼容；已有内容保留。",502);
    if(invalidOutput)throw new AppError("INCOMPLETE","ChatGPT 返回的结构化内容无法解析或不完整；已有内容保留。",502);
    throw new AppError("SIWC_FAILED","ChatGPT 响应失败或中断；已有内容保留。",502);
  } finally {tracked.release();}
}

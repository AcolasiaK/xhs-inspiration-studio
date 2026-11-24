import "server-only";
import OpenAI from 'openai';
import type { AutoParseableTextFormat } from 'openai/lib/parser';
import type { ResponseInput, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AppError } from '@/lib/errors';
import { outputTokenLimitSchema, unverified, type Profile } from '@/lib/ai-config';
import { getServerConfig } from '../config';
import { providerError, safeNetworkCause } from '../provider-errors';
import { normalizeBaseUrl, safeFetch } from './address';
import { assertApiKeyFormat } from './credentials';
import type { AiSource } from './selection';
import { OutputBudgetError } from './output-budget';
export type RequestBody<T>={model:string;store:boolean;max_output_tokens:number;input:ResponseInput;text:{format:AutoParseableTextFormat<T>}};
export function toMessages(input:ResponseInput):ChatCompletionMessageParam[]{return input.map(item=>{
 if(!('role' in item)||!('content' in item)||!['system','developer','user','assistant'].includes(item.role))throw new AppError('PROTOCOL_UNSUPPORTED','当前接口只支持文字和图片消息。',400);
 const content=typeof item.content==='string'?item.content:item.content.map(p=>{if(p.type==='input_text')return {type:'text' as const,text:p.text};if(p.type==='input_image'&&p.image_url?.startsWith('data:image/'))return {type:'image_url' as const,image_url:{url:p.image_url,detail:p.detail==='original'?'auto' as const:p.detail}};throw new AppError('PROTOCOL_UNSUPPORTED','当前接口不支持此输入类型。',400);});
 return {role:item.role,content} as ChatCompletionMessageParam;
});}
function parseResult<T>(format:AutoParseableTextFormat<T>,text:string,key:string):T{
 const value=format.$parseRaw(text);
 if(text.includes(key)||JSON.stringify(value).includes(key))throw new AppError('INVALID_RESULT','服务返回了不安全的内容，已拦截。',502);
 return value;
}
export function legacyProfile():Profile{const c=getServerConfig();if(c.baseUrlError)throw new AppError('INVALID_BASE_URL',c.baseUrlError,503);return {id:'legacy',revision:'legacy',name:c.providerName,provider:c.baseURL.includes('api.openai.com')?'openai':'custom',protocol:'responses',baseUrl:c.baseURL,apiKey:c.apiKey,model:c.model,timeoutSeconds:48,maxOutputTokens:8000,jsonMode:'schema',textTest:unverified(),imageTest:unverified()};}
export const aiTransport={fetch:safeFetch};
function abortedRequest(signal:AbortSignal,operation='生成'):AppError{
 return signal.reason?.name==='TimeoutError'
  ? new AppError('TIMEOUT',`${operation}达到等待上限，已有内容保留。请检查 AI 配置中的请求超时或简化本次要求。`,504)
  : new AppError('CANCELLED',`${operation}已取消，已有内容保留。`,499);
}
function assertSafeOutputText(text:string,key:string){
 const decoded=text.replace(/\\u([0-9a-f]{4})/gi,(_,hex:string)=>String.fromCharCode(parseInt(hex,16))).replace(/\\(["\\/])/g,'$1');
 if(text.includes(key)||decoded.includes(key))throw new AppError('INVALID_RESULT','服务返回了不安全的内容，已拦截。',502);
}
function incompleteResponse(reason:string|undefined,limit:number,text=''):AppError{
 if(reason==='max_output_tokens'||reason==='length')return new OutputBudgetError(limit,'exhausted',text);
 if(reason==='content_filter')return new AppError('REFUSAL','AI 服务的内容筛选中止了本次输出，请调整要求。已有内容保留。',422);
 return new AppError('INCOMPLETE','AI 返回不完整或为空，已有内容保留。',502);
}
type ModelConnection=Pick<Profile,'provider'|'baseUrl'|'apiKey'|'timeoutSeconds'>;
function sdkFor(connection:Pick<Profile,'baseUrl'|'apiKey'|'timeoutSeconds'>,options:{transport?:typeof fetch;timeoutMs?:number}={}){
 assertApiKeyFormat(connection.apiKey);
 return new OpenAI({apiKey:connection.apiKey,baseURL:connection.baseUrl,timeout:options.timeoutMs||connection.timeoutSeconds*1000,maxRetries:0,logLevel:'off',organization:null,project:null,adminAPIKey:null,fetch:options.transport||aiTransport.fetch,fetchOptions:{redirect:'manual'}});
}
function modelListError(error:unknown):AppError{
 const manual='可手动填写模型 ID 后保存，生成能力需另行测试。';
 if(error instanceof AppError)return error;
 if(error instanceof OpenAI.APIConnectionTimeoutError)return new AppError('MODELS_TIMEOUT','获取模型列表超时，请检查后端网络和服务状态后重试；当前尚未验证密钥或模型能力。',504);
 if(error instanceof OpenAI.APIUserAbortError)return new AppError('CANCELLED','模型列表查询已取消。',499);
 if(error instanceof OpenAI.APIConnectionError){
  const safeCause=safeNetworkCause(error);if(safeCause)return safeCause;
  return new AppError('MODELS_NETWORK','模型列表请求在网络连接阶段失败，请检查后端网络、DNS、TLS 连接和 API 基础地址；这不代表密钥错误。',502);
 }
 if(error instanceof OpenAI.APIError){
  if(error.status===401)return new AppError('INVALID_KEY','模型列表接口认证失败，请检查此服务的 API Key 后重试。',503);
  if(error.status===403)return new AppError('MODELS_FORBIDDEN','当前密钥没有模型列表查询权限。'+manual,403);
  if([404,405,501].includes(error.status||0))return new AppError('MODELS_UNSUPPORTED','未找到可用的模型列表接口，请核对基础地址；服务也可能不提供列表。'+manual,502);
  const mapped=providerError(error,'AI 服务');
  if(['PROVIDER_QUOTA','PROVIDER_LIMIT','ENDPOINT_REDIRECT','PROVIDER_UNAVAILABLE'].includes(mapped.code))return mapped;
  if([400,415,422].includes(error.status||0))return new AppError('MODELS_INCOMPATIBLE','服务拒绝了模型列表查询，请核对基础地址与接口格式。'+manual,502);
 }
 return new AppError('MODELS_QUERY_FAILED','模型列表查询未完成，已有输入保留。请检查本机服务与配置后重试。',502);
}
async function readModels(sdk:OpenAI,apiKey:string,signal?:AbortSignal):Promise<string[]>{
 try{
  signal?.throwIfAborted();
  // Read the raw body: the SDK page class normalizes missing data to [], which
  // would incorrectly label an incompatible response as a valid empty list.
  const response=await sdk.models.list({signal}).asResponse();
  let result:{data?:unknown};
  try{result=await response.json();}catch(error){
   if(!(error instanceof SyntaxError))throw error;
   throw new AppError('MODELS_INVALID_RESPONSE','服务已响应，但返回内容不是有效的 JSON 模型列表。可手动填写模型 ID 后保存，生成能力需另行测试。',502);
  }
  if(!result||!Array.isArray(result.data))throw new AppError('MODELS_INVALID_RESPONSE','服务已响应，但缺少支持的模型列表结构。可手动填写模型 ID 后保存，生成能力需另行测试。',502);
  const ids=result.data.slice(0,300).flatMap(item=>{
   const id=item&&typeof item==='object'?item.id:undefined;
   return typeof id==='string'&&id.length>0&&id.length<=160&&/^[\w.\-/:]+$/.test(id)&&!id.includes(apiKey)?[id]:[];
  });
  return [...new Set(ids)].sort((a,b)=>a.localeCompare(b));
 }catch(error){if(signal?.aborted)throw abortedRequest(signal,'模型列表查询');throw modelListError(error);}
}
/** Connection-only operation: no model ID, generation, or persistent profile is needed. */
export async function listProviderModels(connection:ModelConnection,signal?:AbortSignal){
 if(!connection.apiKey)throw new AppError('KEY_REQUIRED','请填写 API Key 后获取模型列表；也可直接手动填写模型 ID。',400);
 const baseUrl=normalizeBaseUrl(connection.baseUrl,connection.provider);
 return readModels(sdkFor({...connection,baseUrl}),connection.apiKey,signal);
}
function assertConfigured(profile: Profile | null): asserts profile is Profile {
 if (!profile?.apiKey || !profile.model) throw new AppError('NOT_CONFIGURED','请打开 AI 设置，填写 API 密钥和模型并选择配置。',503);
}

export function assertImageCapability(source: string | {profile:Profile | null}) {
 if (typeof source === 'string') return;
 const {profile} = source;
 assertConfigured(profile);
 const status = profile.imageTest.status;
 if (status === 'passed') return;
 const message = {
  unverified: '当前配置尚未测试图片理解。请在 AI 设置中测试图片理解，或选择已验证的配置。',
  failed: '当前配置上次未通过图片理解测试。请在 AI 设置中查看测试结果并重新测试，或选择已验证的配置。',
  unsupported: '上次测试时，服务不支持当前配置的图片请求。请在 AI 设置中查看原因，调整配置后重新测试，或选择已验证的配置。',
 };
 throw new AppError('VISION_UNVERIFIED',message[status],400);
}

export async function createProvider(source:AiSource='relay',options:{testImage?:boolean;transport?:typeof fetch;timeoutMs?:number;requestTimeoutMs?:number;maxOutputTokens?:number}={}){
 if(source==='chatgpt')throw new AppError('SOURCE_REMOVED','订阅通道已停用，请配置 API。',400);
 const profile=typeof source==='string'?legacyProfile():source.profile;
 assertConfigured(profile);
 const p=structuredClone(profile);
 if(options.maxOutputTokens!==undefined){
  const parsed=outputTokenLimitSchema.safeParse(options.maxOutputTokens);
  if(!parsed.success)throw new AppError('INVALID_FORM','本次输出上限请填写不小于 256 的整数。',400);
  p.maxOutputTokens=parsed.data;
 }
 // Explicit per-task wait, including saved profiles. Do not alter persisted settings
 // or the existing legacy-only timeoutMs policy used by other generation flows.
 if(options.requestTimeoutMs!==undefined&&(!Number.isSafeInteger(options.requestTimeoutMs)||options.requestTimeoutMs<1000||options.requestTimeoutMs>86_400_000))throw new AppError('INVALID_FORM','本次等待时间请设置在 1 秒到 24 小时之间。',400);
 const sdk=sdkFor(p,{transport:options.transport,timeoutMs:options.requestTimeoutMs??(p.id==='legacy'?options.timeoutMs:undefined)});
 return {model:p.model,providerName:'AI 服务',profile:p,responses:{async parse<T>(body:RequestBody<T>,opts:{signal?:AbortSignal}={}){
  const images=body.input.some(item=>'content' in item&&Array.isArray(item.content)&&item.content.some(part=>part.type==='input_image'));
  if(images&&p.id!=='legacy'&&!options.testImage)assertImageCapability({profile:p});
  const limit=Math.min(body.max_output_tokens,p.maxOutputTokens);
  try{
   opts.signal?.throwIfAborted();
   if(p.protocol==='responses'){
    const formatted=p.jsonMode==='object'?{format:{type:'json_object' as const}}:body.text;
    const input=p.jsonMode==='object'?[{role:'system' as const,content:'只输出 JSON，严格遵循这个 JSON Schema：'+JSON.stringify(body.text.format.schema)},...body.input]:body.input;
    const response=await sdk.responses.create({model:p.model,store:false,max_output_tokens:limit,input,text:formatted},{signal:opts.signal});
    if(!Array.isArray(response.output))throw new TypeError('INVALID_RESPONSE');
    const text=response.output_text || response.output?.flatMap(item=>item.type==='message'?item.content.filter(part=>part.type==='output_text').map(part=>part.text):[]).join('');
    if(response.output?.some(item=>item.type==='message'&&item.content.some(part=>part.type==='refusal')))throw new AppError('REFUSAL','模型拒绝了当前请求，已有内容保留。',422);
    assertSafeOutputText(text||'',p.apiKey);
    if(response.status!=='completed'||!text?.trim())throw incompleteResponse(response.incomplete_details?.reason,limit,text);
    return {status:response.status,output:response.output as ResponseOutputItem[],output_parsed:parseResult(body.text.format,text,p.apiKey)};
   }
   const schema=body.text.format.schema;
   const messages=toMessages(body.input);
   if(p.jsonMode==='object')messages.unshift({role:'system',content:'只输出 JSON，严格遵循这个 JSON Schema：'+JSON.stringify(schema)});
   const response=await sdk.chat.completions.create({model:p.model,messages,stream:false,...(p.provider==='openai'?{max_completion_tokens:limit,store:false}:{max_tokens:limit}),response_format:p.jsonMode==='schema'?{type:'json_schema',json_schema:{name:body.text.format.name,strict:true,schema}}:{type:'json_object'}},{signal:opts.signal});
   const choice=response.choices[0];if(choice?.message.refusal)throw new AppError('REFUSAL','模型拒绝了当前请求，已有内容保留。',422);
   assertSafeOutputText(choice?.message.content||'',p.apiKey);
   if(choice?.finish_reason!=='stop'||!choice.message.content?.trim())throw incompleteResponse(choice?.finish_reason,limit,choice?.message.content||'');
   return {status:'completed',output:[] as ResponseOutputItem[],output_parsed:parseResult(body.text.format,choice.message.content,p.apiKey)};
  }catch(error){if(opts.signal?.aborted)throw abortedRequest(opts.signal);const mapped=providerError(error,'AI 服务');if(mapped.code==='OUTPUT_BUDGET_UNSUPPORTED')throw new OutputBudgetError(limit,'unsupported');if(error instanceof OpenAI.APIError)Object.assign(mapped,{providerStatus:error.status});throw mapped;}
 }},async models(signal?:AbortSignal){return readModels(sdk,p.apiKey,signal);}};
}

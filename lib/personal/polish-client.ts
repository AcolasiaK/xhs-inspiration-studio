import { aiSourceHeader, getAiSource } from '../ai-source';
import { cloudFetch } from '../cloud/client';
import { PersonalRequestError } from './client';
import { polishRequestSchema, polishResponseSchema, type PolishRequest } from './polish-schema';
import { validatePolishOutput } from './polish-validation';

export async function requestPersonalPolish(payload:PolishRequest,controller:AbortController,options?:{request?:typeof cloudFetch;source?:string}){
 const source=options?.source??getAiSource(),request=polishRequestSchema.parse(payload);
 const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),195000);
 try{
  if(controller.signal.aborted)throw new Error('cancelled');
  const response=await (options?.request??cloudFetch)('/api/personal/polish',{method:'POST',headers:{'Content-Type':'application/json',...aiSourceHeader(source)},body:JSON.stringify(request),signal:AbortSignal.any([controller.signal,timeout.signal])});
  const raw=await response.json().catch(()=>null);
  if(controller.signal.aborted)throw new Error('cancelled');
  if(timeout.signal.aborted)throw new Error('timeout');
  if(!response.ok)throw new PersonalRequestError(typeof raw?.error?.code==='string'?raw.error.code:'POLISH_FAILED',typeof raw?.error?.message==='string'&&raw.error.message.length<=500?raw.error.message:'润色失败，原文保留。',response.status);
  const parsed=polishResponseSchema.safeParse(raw);
  if(!parsed.success)throw new PersonalRequestError('POLISH_INVALID_RESULT','润色结果格式不完整，原文保留。');
  validatePolishOutput(request,parsed.data);return parsed.data;
 }catch(e){
  if(controller.signal.aborted)throw new PersonalRequestError('CANCELLED','已取消润色，原文保留。');
  if(timeout.signal.aborted)throw new PersonalRequestError('TIMEOUT','润色等待超时，原文保留。');
  if(e instanceof TypeError)throw new PersonalRequestError('NETWORK','润色网络请求失败，原文保留，请稍后手动重试。');
  throw e;
 }finally{clearTimeout(timer);}
}

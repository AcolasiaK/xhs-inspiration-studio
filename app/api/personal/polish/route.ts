import { randomUUID } from 'node:crypto';
import { AppError } from '@/lib/errors';
import { ownerFor, selectProfile } from '@/lib/server/ai/selection';
import { readJson } from '@/lib/cloud/server/config';
import { checkRateLimit, RateLimitError } from '@/lib/server/guard';
import { polishRequestSchema } from '@/lib/personal/polish-schema';
import { runPersonalPolish } from '@/lib/server/personal-polish';

export const runtime='nodejs';
export const maxDuration=200;
export async function POST(request:Request){
 const requestId=randomUUID(),deadline=AbortSignal.timeout(190000),signal=AbortSignal.any([request.signal,deadline]);
 const headers:Record<string,string>={'Cache-Control':'no-store','X-Request-Id':requestId};
 try{
  const owner=await ownerFor(request);
  checkRateLimit('personal-polish:'+owner,4);checkRateLimit('live',6);
  // Resolve once, before reading or executing the task. Later UI changes cannot retarget it.
  const selection=await selectProfile(owner,request.headers.get('X-AI-Profile'));
  const parsed=polishRequestSchema.safeParse(await readJson(request,1500000));
  if(!parsed.success)throw new AppError('INVALID_FORM',parsed.error.issues.find(i=>i.code==='custom')?.message||'请检查润色范围与当前文案。',400);
  const result=await runPersonalPolish(parsed.data,signal,selection,owner);
  signal.throwIfAborted();return Response.json(result,{headers});
 }catch(error){
  const e=request.signal.aborted?new AppError('CANCELLED','已取消润色，原文保留。',499):deadline.aborted?new AppError('TIMEOUT','润色等待超时，原文保留，请稍后手动重试。',504):error instanceof AppError?error:new AppError('POLISH_FAILED','暂时无法润色，原文保留。',500);
  if(e instanceof RateLimitError)headers['Retry-After']=String(e.retryAfterSeconds);
  // Never log prose, credentials or third-party response bodies.
  console.error(`[personal-polish] requestId=${requestId} code=${e.code} status=${e.status}`);
  return Response.json({error:{code:e.code,message:e.message,requestId}},{status:e.status,headers});
 }
}

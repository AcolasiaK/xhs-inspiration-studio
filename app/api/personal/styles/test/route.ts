import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { ownerFor, selectProfile } from '@/lib/server/ai/selection';
import { cloudError } from '@/lib/cloud/server/config';
import { readBoundedFormData, parseImageFiles } from '@/lib/server/uploads';
import { checkRateLimit } from '@/lib/server/guard';
import { personalInputSchema } from '@/lib/personal/schema';
import { styleIdSchema } from '@/lib/personal/style-rules';
import { resolvePersonalStyle, recordStyleTrial } from '@/lib/server/personal-style-store';
import { testPersonalRules } from '@/lib/server/personal';
export const runtime='nodejs';
// Allow the application to return its 190-second timeout before a hosting
// platform terminates the handler. This does not change a profile's timeout.
export const maxDuration=200;
const schema=z.object({id:styleIdSchema,versionId:z.string().max(100),kind:z.enum(['body','title','captions']),input:personalInputSchema,imageIds:z.array(z.string().uuid()).max(9).refine(v=>new Set(v).size===v.length)}).strict();
export async function POST(request:Request){
 const deadline=AbortSignal.timeout(190_000);
 const signal=AbortSignal.any([request.signal,deadline]);
 const interruption=()=>request.signal.aborted
  ?new AppError('CANCELLED','试生成已取消，当前规则和内容未改变。',499)
  :deadline.aborted?new AppError('TIMEOUT','风格试生成等待超时，当前规则和内容未改变。',504):undefined;
 const assertActive=()=>{const error=interruption();if(error)throw error;};
 async function withinBudget<T>(operation:()=>Promise<T>):Promise<T>{
  assertActive();
  let onAbort:()=>void=()=>undefined;
  const stopped=new Promise<never>((_,reject)=>{
   onAbort=()=>{const error=interruption();if(error)reject(error);};
   signal.addEventListener('abort',onAbort,{once:true});
  });
  try{const value=await Promise.race([operation(),stopped]);assertActive();return value;}
  catch(error){assertActive();throw error;}
  finally{signal.removeEventListener('abort',onAbort);}
 }
 try{
  const owner=await withinBudget(()=>ownerFor(request));
  checkRateLimit('personal-style-test:'+owner,4);checkRateLimit('live',6);
  const form=await withinBudget(()=>readBoundedFormData(request,signal));
  let raw:unknown;try{raw=JSON.parse(String(form.get('payload')));}catch{throw new AppError('INVALID_FORM','试生成素材无法读取。',400);}
  const parsed=schema.safeParse(raw);if(!parsed.success||!parsed.data.input.experience.trim())throw new AppError('INVALID_FORM','请填写测试素材并选择已保存的规则版本。',400);const v=parsed.data;
  const [snapshot,source]=await withinBudget(()=>Promise.all([
   resolvePersonalStyle(owner,v.id,v.versionId,true),selectProfile(owner,request.headers.get('X-AI-Profile')),
  ]));
  const images=await withinBudget(()=>parseImageFiles(form,v.imageIds));
  const result=await withinBudget(()=>testPersonalRules(snapshot,v.input,images,v.kind,signal,source));
  const trial={id:randomUUID(),styleId:v.id,versionId:v.versionId,kind:v.kind,at:new Date().toISOString(),model:result.model,snapshot,material:v.input.experience,output:result.output};
  await withinBudget(()=>recordStyleTrial(owner,trial));
  return Response.json({trial},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return cloudError(interruption()||error);}
}

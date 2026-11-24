import { z } from 'zod';
import { ownerFor } from '@/lib/server/ai/selection';
import { beginProbe, deleteProfile, publicProfile, recordProbe, saveProfile, setDefault, stateFor } from '@/lib/server/ai/store';
import { cloudError, readJson } from '@/lib/cloud/server/config';
import { AppError } from '@/lib/errors';
import { checkRateLimit } from '@/lib/server/guard';
import { queryProfileModels } from '@/lib/server/ai/models';
import { probeProfile } from '@/lib/server/ai/probe';
export const runtime='nodejs';
export const maxDuration=200;
const envelope=z.object({action:z.enum(['save','delete','default','test','models']),id:z.string().uuid().optional(),revision:z.string().uuid().optional(),profile:z.unknown().optional(),kind:z.enum(['text','image']).optional()}).strict();
const json=(value:unknown)=>Response.json(value,{headers:{'Cache-Control':'no-store'}});
export async function GET(request:Request){try{const owner=await ownerFor(request);const s=await stateFor(owner);return json({profiles:s.profiles.map(publicProfile),defaultId:s.defaultId,account:owner==='local-owner'?'本机个人配置':'当前登录账号'});}catch(e){return cloudError(e);}}
export async function POST(request:Request){try{
 const owner=await ownerFor(request);checkRateLimit('ai-settings:'+owner,60);
 const parsed=envelope.safeParse(await readJson(request,16*1024));if(!parsed.success)throw new AppError('INVALID_FORM','配置操作格式不正确。',400);const v=parsed.data;
 if(v.action==='save')return json({profile:await saveProfile(owner,v.profile,v.id,v.revision)});
 if(v.action==='default'){await setDefault(owner,v.id||null);return json({ok:true});}
 if(v.action==='models')return json({models:await queryProfileModels(owner,v.profile,v.id,v.revision,request.signal)});
 if(!v.id)throw new AppError('INVALID_FORM','请选择配置。',400);
 if(v.action==='delete'){await deleteProfile(owner,v.id);return json({ok:true});}
 checkRateLimit('ai-test:'+owner,8);
 const kind=v.kind||'text';
 const {profile,probeId}=await beginProbe(owner,v.id,v.revision,kind);
 const probe=await probeProfile(profile,kind,request.signal);
 await recordProbe(owner,profile,kind,probe,probeId);
 return json({probe});
 }catch(e){return cloudError(e);}}

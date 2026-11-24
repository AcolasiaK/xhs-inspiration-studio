import "server-only";
import { isCloudMode } from '@/lib/cloud/mode';
import { requireUser } from '@/lib/cloud/server/auth';
import { assertOrigin } from '@/lib/cloud/server/config';
import { assertLocalRequest, assertAppAccess } from '@/lib/server/guard';
import { getServerConfig } from '@/lib/server/config';
import { AppError } from '@/lib/errors';
import type { Profile } from '@/lib/ai-config';
import { stateFor, hasLocalProfiles } from './store';
export type Snapshot={profile:Profile|null;owner:string};
export type AiSource=Snapshot|string;
export async function ownerFor(request:Request){if(isCloudMode()){if(request.method!=='GET')assertOrigin(request);return (await requireUser(request,{requireIdentity:true})).id;}
 if(!getServerConfig().localOnly)throw new AppError('FORBIDDEN','请使用项目的本机启动方式。',403);assertLocalRequest(request);return 'local-owner';}
export async function selectProfile(owner:string,id?:string|null):Promise<Snapshot>{const s=await stateFor(owner),selected=id==='none'?null:id||s.defaultId;const profile=selected?s.profiles.find(p=>p.id===selected):null;if(selected&&!profile)throw new AppError('NOT_FOUND','所选配置已删除或不属于当前账号，请重新选择。',404);return {owner,profile:profile?structuredClone(profile):null};}
export async function requestSelection(request:Request):Promise<AiSource>{if(request.headers.has('X-AI-Source')&&request.headers.get('X-AI-Source')!=='relay')throw new AppError('SOURCE_REMOVED','订阅通道已停用，请在 AI 设置中配置 API 密钥。',400);if(isCloudMode())return {owner:'deferred-cloud',profile:null};if(!getServerConfig().localOnly){const origin=request.headers.get('origin');if(origin&&new URL(origin).host!==request.headers.get('host'))throw new AppError('INVALID_ORIGIN','请从本站页面操作。',403);assertAppAccess(request);if(request.headers.get('X-AI-Profile'))throw new AppError('FORBIDDEN','个人配置只适用于本机或已登录账号。',403);return 'relay';}try{const owner=await ownerFor(request);if(!request.headers.get('X-AI-Profile')&&!hasLocalProfiles())return 'relay';return await selectProfile(owner,request.headers.get('X-AI-Profile'));}catch(e){if(e instanceof AppError)throw e;throw new AppError('AI_STORAGE','个人 AI 配置暂时无法读取，请稍后重试。',503);}}

import { existsSync } from "node:fs";
import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, rmdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { profileInput, unverified, type Profile, type PublicProfile, type Probe } from "@/lib/ai-config";
import { AppError } from "@/lib/errors";
import { isCloudMode } from "@/lib/cloud/mode";
import { getRepository } from "@/lib/cloud/server/repository";
import { normalizeBaseUrl } from "./address";
import { assertApiKeyFormat } from "./credentials";
type ProbeKind = 'text' | 'image';
export type State={profiles:Profile[];defaultId:string|null;migrated:boolean;latestProbes?:Record<string,Partial<Record<ProbeKind,string>>>};
const fresh=():State=>({profiles:[],defaultId:null,migrated:false});
const dir=()=>process.env.AI_CONFIG_DIR||join(process.cwd(),".local-data","ai-config");
async function key(createIfMissing:boolean){
  const secret=process.env.AI_CONFIG_SECRET;
  if(secret){if(secret.length<32)throw new AppError("AI_STORAGE","AI_CONFIG_SECRET 至少需要 32 个字符。",503);return createHash('sha256').update(secret).digest();}
  if(isCloudMode())throw new AppError("AI_STORAGE","个人 AI 配置尚未启用，请管理员一次性配置 AI_CONFIG_SECRET。",503);
  const path=join(dir(),"master.key");
  if(createIfMissing){
    await mkdir(dir(),{recursive:true,mode:0o700});
    try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  const k=await readFile(path);if(k.length!==32)throw new Error('INVALID_MASTER_KEY');return k;
}
export async function seal(value:unknown,owner:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',await key(true),iv);c.setAAD(Buffer.from(owner));const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return {v:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')};}
export type Sealed=Awaited<ReturnType<typeof seal>>;
export async function unseal<T>(value:Sealed,owner:string):Promise<T>{try{const c=createDecipheriv('aes-256-gcm',await key(false),Buffer.from(value.iv,'base64'));c.setAAD(Buffer.from(owner));c.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([c.update(Buffer.from(value.data,'base64')),c.final()]).toString());}catch{throw new AppError('AI_STORAGE','无法解密个人 AI 配置，请检查服务器密钥；原配置仍保留。',503);}}
const ownerKey=(owner:string)=>createHash('sha256').update(owner).digest('hex');
const ownerMarker=/^owner-(\d+)-[0-9a-f-]+$/;
function processIsGone(pid:number){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
}
async function releaseLocalLock(lock:string,marker:string){
  // Never recursively remove a lock: a different owner's marker must survive.
  try{await unlink(join(lock,marker));}catch{}
  try{await rmdir(lock);}catch{}
}
async function recoverLocalLock(lock:string){
  try{
    const before=await stat(lock),entries=await readdir(lock);
    if(entries.length===1){
      const match=ownerMarker.exec(entries[0]);
      if(match&&processIsGone(Number(match[1]))){
        // Only the contender that removes this exact dead owner's marker may
        // remove its empty directory. Another reclaimer cannot remove a new lock.
        await unlink(join(lock,entries[0]));
        await rmdir(lock);
      }
    }else if(entries.length===0&&Date.now()-before.mtimeMs>30_000){
      const current=await stat(lock);
      if(current.ino===before.ino&&current.mtimeMs===before.mtimeMs)await rmdir(lock);
    }
  }catch{/* A competing owner/reclaimer won, or ownership cannot be established. */}
}
async function acquireLocalLock(lock:string){
  const marker=`owner-${process.pid}-${randomUUID()}`;
  for(let attempt=0;;attempt++){
    let created=false;
    try{
      await mkdir(lock,{mode:0o700});created=true;
      await writeFile(join(lock,marker),'',{flag:'wx',mode:0o600});
      const entries=await readdir(lock);
      if(entries.length!==1||entries[0]!==marker)throw new Error('LOCK_OWNERSHIP_CHANGED');
      return ()=>releaseLocalLock(lock,marker);
    }catch(e){
      if(created)await releaseLocalLock(lock,marker);
      if((e as NodeJS.ErrnoException).code!=='EEXIST'&&!created)throw e;
      await recoverLocalLock(lock);
      if(attempt>=50)throw new AppError('AI_BUSY','配置正在保存，请稍后重试。',409);
      await new Promise(r=>setTimeout(r,20));
    }
  }
}
async function transaction<T>(owner:string,work:(s:State)=>T|Promise<T>):Promise<T>{
  if(isCloudMode()){const db=await getRepository();return db.transaction(async tx=>{const old=await tx.get<Sealed>('ai_profiles',ownerKey(owner)),s=old?await unseal<State>(old,owner):fresh();const result=await work(s);await tx.put('ai_profiles',ownerKey(owner),await seal(s,owner),owner);return result;});}
  await mkdir(dir(),{recursive:true,mode:0o700});const file=join(dir(),ownerKey(owner)+'.enc'),lock=file+'.lock';
  const release=await acquireLocalLock(lock);
  try{let s=fresh();try{s=await unseal<State>(JSON.parse(await readFile(file,'utf8')),owner);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const result=await work(s),temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(await seal(s,owner)),{mode:0o600});await rename(temp,file);return result;
  }finally{await release();}
}
export function publicProfile(p:Profile):PublicProfile{const {apiKey,...rest}=p;return {...rest,hasApiKey:!!apiKey,maskedApiKey:apiKey?'••••••••'+(apiKey.length>8?apiKey.slice(-4):''):''};}
/** Read without creating files, re-sealing data, importing env, or changing defaults. */
export async function readStateFor(owner:string):Promise<State>{
 if(isCloudMode()){
  const saved=await (await getRepository()).get<Sealed>('ai_profiles',ownerKey(owner));
  return saved?unseal<State>(saved,owner):fresh();
 }
 let saved:string;
 try{saved=await readFile(join(dir(),ownerKey(owner)+'.enc'),'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return fresh();throw error;}
 return unseal<State>(JSON.parse(saved),owner);
}
function importLegacy(s:State){
  if(s.migrated)return;s.migrated=true;
  if(s.profiles.length||!process.env.OPENAI_API_KEY?.trim()||!process.env.OPENAI_MODEL?.trim())return;
  let baseUrl:string;
  try{baseUrl=normalizeBaseUrl(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1');}catch{return;}
  const parsed=profileInput.safeParse({name:'原有 API 配置',provider:baseUrl==='https://api.openai.com/v1'?'openai':'custom',protocol:'responses',jsonMode:'schema',baseUrl,apiKey:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL});
  if(!parsed.success)return; // Preserve invalid legacy env values; allow page-based repair.
  try{assertApiKeyFormat(parsed.data.apiKey);}catch{return;}
  const p:Profile={...parsed.data,id:randomUUID(),revision:randomUUID(),textTest:unverified(),imageTest:unverified()};s.profiles.push(p);s.defaultId=p.id;
}
/** Normal generation and settings reads use the last complete atomic save. */
export async function stateFor(owner:string):Promise<State>{
  const saved=await readStateFor(owner);
  if(isCloudMode() || owner!=='local-owner' || saved.migrated)return saved;
  return transaction(owner,s=>{importLegacy(s);return s;});
}
export async function migrateLegacy(owner:string){await stateFor(owner);}
export async function saveProfile(owner:string,raw:unknown,id?:string,revision?:string){
 const parsed=profileInput.safeParse(raw);if(!parsed.success)throw new AppError('INVALID_FORM','请检查名称、服务、地址、模型和高级设置。',400);
 const input=parsed.data;input.baseUrl=normalizeBaseUrl(input.baseUrl,input.provider);
 if(!input.clearApiKey)assertApiKeyFormat(input.apiKey);
 return transaction(owner,s=>{const old=id?s.profiles.find(p=>p.id===id):undefined;if(id&&!old)throw new AppError('NOT_FOUND','配置不存在或不属于当前账号。',404);if(old&&old.revision!==revision)throw new AppError('CONFLICT','配置已在其他页面修改，请重新打开后编辑。',409);
 if(old&&(old.baseUrl!==input.baseUrl||old.provider!==input.provider)&&!input.apiKey&&!input.clearApiKey)throw new AppError('KEY_REQUIRED','更换地址或服务类型时请重新填写属于该服务的密钥，避免误发原密钥。',400);
 const apiKey=input.clearApiKey?'':input.apiKey||old?.apiKey||'';const {clearApiKey:_,...fields}=input;void _;
 assertApiKeyFormat(apiKey);
 const changed=!old||['baseUrl','model','protocol','provider','jsonMode'].some(k=>old[k as keyof Profile]!==fields[k as keyof typeof fields])||old.apiKey!==apiKey;
 const p:Profile={...fields,apiKey,id:old?.id||randomUUID(),revision:randomUUID(),textTest:changed?unverified():old!.textTest,imageTest:changed?unverified():old!.imageTest};
 if(!old&&s.profiles.length>=30)throw new AppError('LIMIT','最多保存 30 套个人配置。',400);
 s.profiles=old?s.profiles.map(v=>v.id===id?p:v):[...s.profiles,p];return publicProfile(p);});
}
export async function setDefault(owner:string,id:string|null){return transaction(owner,s=>{if(id&&!s.profiles.some(p=>p.id===id))throw new AppError('NOT_FOUND','配置不存在或不属于当前账号。',404);s.defaultId=id;});}
export async function deleteProfile(owner:string,id:string){return transaction(owner,s=>{if(!s.profiles.some(p=>p.id===id))throw new AppError('NOT_FOUND','配置不存在或不属于当前账号。',404);s.profiles=s.profiles.filter(p=>p.id!==id);delete s.latestProbes?.[id];if(s.defaultId===id)s.defaultId=null;});}

export async function beginProbe(owner:string,id:string,revision:string|undefined,kind:ProbeKind) {
 return transaction(owner,state=>{
  const profile=state.profiles.find(item=>item.id===id);
  if(!profile)throw new AppError('NOT_FOUND','配置不存在或不属于当前账号。',404);
  if(revision && profile.revision!==revision)throw new AppError('CONFLICT','配置已在其他页面修改，请重新读取后测试。',409);
  // Keep the previous capability visible. Even after a crash this marker can
  // be replaced by the next explicit test, without locking or changing a profile.
  const probeId=randomUUID();
  const latest = state.latestProbes ??= {};
  const capabilities = latest[id] ??= {};
  capabilities[kind] = probeId;
  return {profile,probeId};
 });
}

export async function recordProbe(owner:string,p:Profile,kind:ProbeKind,probe:Probe,probeId?:string){
 return transaction(owner,state=>{
  const current=state.profiles.find(item=>item.id===p.id);
  if(!current||current.revision!==p.revision)throw new AppError('CONFLICT','配置已变更，测试结果未写入，请重新测试。',409);
  const latest=state.latestProbes?.[p.id];
  if(latest?.[kind]!==probeId)throw new AppError('CONFLICT','已有更新的同类测试，本次结果未写入。请查看最新测试状态。',409);
  current[kind==='text'?'textTest':'imageTest']=probe;
  if(latest)delete latest[kind];
 });
}

export function hasLocalProfiles(){return existsSync(join(dir(),ownerKey("local-owner")+".enc"));}

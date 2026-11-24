"use client";
import {completedNoteSchema,completedSummarySchema,type CompletedNote} from "@/lib/personal/completed";
import { z } from "zod";
import { cloudFetch } from "./client";
import { copyStoredDraft,storedDraftSchema,type StoredDraft,type DraftSummary } from "@/lib/drafts";
import { customStyleSchema,type CustomStyle } from "@/lib/styles";
import { videoDraftSchema,type VideoDraft } from "@/lib/video/drafts";
import type { CompletedWire, PhotoWire, PersonalWire } from "./server/data";
import { personalStoredSchema,copyPersonalDraft,type PersonalStored,type PersonalSummary } from "@/lib/personal/drafts";

export class CloudStorageError extends Error {constructor(message:string,readonly code:string){super(message);}}
async function response(request:Promise<Response>):Promise<Response>{
 let r:Response;try{r=await request;}catch{throw new CloudStorageError("连接云端失败或等待超时，当前内容仍在页面，请检查网络后重试。","NETWORK_ERROR");}if(!r.ok){const v=await r.json().catch(()=>null);throw new CloudStorageError(typeof v?.error?.message==="string"?v.error.message:"云端请求失败，当前页面内容保留。",typeof v?.error?.code==="string"?v.error.code:"");}return r;
}
function request(path:string,init:RequestInit={}){const timeout=AbortSignal.timeout(65_000);return cloudFetch(path,{...init,signal:init.signal?AbortSignal.any([init.signal,timeout]):timeout});}
async function json<T>(path:string,init?:RequestInit):Promise<T>{
 const r=await response(request(path,init));try{return await r.json() as T;}catch{throw new CloudStorageError("云端记录格式不正确，原数据未被覆盖。","CORRUPT_RECORD");}
}
function write(action:string,fields:Record<string,unknown>){return json<unknown>("/api/cloud/data",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...fields})});}
const photoSummarySchema=z.object({id:z.string().uuid(),name:z.string().max(80),updatedAt:z.union([z.string().datetime(),z.literal("")]),contentMode:z.enum(["live","demo"]).nullable(),thumbnailId:z.string().uuid().nullable(),damaged:z.boolean().optional()});
const workspaceSchema=z.object({drafts:z.array(z.unknown()),templates:z.array(z.unknown()),activeId:z.string().uuid().optional(),hiddenDamaged:z.number().int().nonnegative().optional()});

/** Only data corruption is recoverable by skipping one draft. Authentication/network errors are not. */
export function isCorruptCloudRecord(error:unknown){return error instanceof z.ZodError || (error instanceof CloudStorageError&&["NOT_FOUND","INVALID_IMAGE","CORRUPT_RECORD"].includes(error.code));}
const thumbnailCache=new Map<string,Promise<Blob>>();
export function getCloudThumbnail(userId:string,id:string):Promise<Blob>{
 const key=`${userId}:${id}`,old=thumbnailCache.get(key);if(old)return old;
 const pending=response(request(`/api/cloud/images/${encodeURIComponent(id)}?thumbnail=1`)).then(r=>r.blob()).catch(error=>{thumbnailCache.delete(key);throw error;});
 thumbnailCache.set(key,pending);if(thumbnailCache.size>80){const first=thumbnailCache.keys().next().value;if(first)thumbnailCache.delete(first);}return pending;
}

export async function readCloudTemplates():Promise<unknown[]>{const rows=await json<unknown>("/api/cloud/data?kind=templates");if(!Array.isArray(rows))throw new Error("云端模板数据无法读取，原数据未覆盖。");return rows;}
export function makeCloudPhotoStore(userId:string) {
 const cache=new Map<string,Blob>();
 async function fetchImage(id:string){const old=cache.get(id);if(old)return old;
  const r=await response(request(`/api/cloud/images/${encodeURIComponent(id)}`));const blob=await r.blob();cache.set(id,blob);return blob;}
 async function getDraft(id:string){
  const raw=await json<unknown>(`/api/cloud/data?kind=photo&id=${encodeURIComponent(id)}`);
  // Validate every field and image relationship before issuing image requests. A valid
  // JSON document can still be damaged; only a proven bad record may be skipped.
  if(!raw||typeof raw!=="object"||!("assets" in raw)||!Array.isArray(raw.assets))throw new CloudStorageError("云端草稿内容不完整，原数据未覆盖。","CORRUPT_RECORD");
  const withPlaceholders={...raw,assets:raw.assets.map(asset=>{
   if(!asset||typeof asset!=="object")return asset;
   const type="type" in asset&&typeof asset.type==="string"?asset.type:"";
   return {...asset,blob:new Blob(["x"],{type})};
  })};
  const parsed=storedDraftSchema.safeParse(withPlaceholders);
  if(!parsed.success||parsed.data.id!==id)throw new CloudStorageError("云端草稿内容不完整，原数据未覆盖。","CORRUPT_RECORD");
  const assets=await Promise.all(parsed.data.assets.map(async asset=>({...asset,blob:await fetchImage(asset.id)})));
  const hydrated=storedDraftSchema.safeParse({...parsed.data,assets});
  if(!hydrated.success)throw new CloudStorageError("云端草稿图片内容不完整，原数据未覆盖。","CORRUPT_RECORD");
  return hydrated.data;
 }
 async function upload(a:StoredDraft["assets"][number],force=false){if(!force&&cache.has(a.id))return;const data=new FormData();data.set("id",a.id);data.set("image",a.blob,a.name);await response(request("/api/cloud/images",{method:"POST",body:data}));cache.set(a.id,a.blob);}
 async function writeDraft(value:StoredDraft,expected:number|null,active=true){
  const draft=storedDraftSchema.parse(value);for(const a of draft.assets)await upload(a);
  const wire:PhotoWire={...draft,assets:draft.assets.map(({blob,...asset})=>({...asset,type:blob.type}))};
  const save=async()=>await write("photo-write",{draft:wire,expected,active}) as PhotoWire;let saved:PhotoWire;
  try{saved=await save();}catch(error){if(!(error instanceof CloudStorageError)||error.code!=="ASSET_MISSING")throw error;for(const a of draft.assets)await upload(a,true);saved=await save();}
  const byId=new Map(draft.assets.map(a=>[a.id,a.blob]));return storedDraftSchema.parse({...saved,assets:saved.assets.map(a=>({...a,blob:byId.get(a.id)}))});
 }
 return {
  async readWorkspace(){
   if(!userId)throw new Error("请先登录后读取云端草稿。");
   const data=workspaceSchema.parse(await json<unknown>("/api/cloud/data?kind=photo-workspace"));
   let hiddenDamaged=data.hiddenDamaged??0;const summaries:DraftSummary[]=[];const seen=new Set<string>();
   for(const raw of data.drafts){const row=photoSummarySchema.safeParse(raw);if(!row.success){hiddenDamaged++;continue;}if(seen.has(row.data.id)){hiddenDamaged++;continue;}seen.add(row.data.id);summaries.push({id:row.data.id,name:row.data.name,updatedAt:row.data.updatedAt,contentMode:row.data.contentMode,thumbnailId:row.data.thumbnailId??undefined,damaged:row.data.damaged});}
   summaries.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
   return {drafts:[],templates:data.templates,activeId:data.activeId,summaries,hiddenDamaged};
  },getDraft,writeDraft,
  async preserveSnapshot(value:StoredDraft){const copy=copyStoredDraft(value);copy.name=`${value.name.slice(0,68)}（重新生成前）`;return writeDraft(copy,null,false);},
  async setActive(id:string){await write("photo-active",{id});},async deleteDraft(id:string){await write("photo-remove",{id});},
  async saveTemplate(value:CustomStyle){const template=customStyleSchema.parse(value);await write("template-write",{template});return template;},
  async deleteTemplate(id:string){await write("template-remove",{id});},
 };
}
export function makeCloudVideoStore(userId:string){return {
 async read(){if(!userId)throw new Error("请先登录后读取云端草稿。");const v=await json<{summaries:unknown[];activeId:string;hiddenDamaged?:number}>("/api/cloud/data?kind=video-workspace");if(!Array.isArray(v.summaries))throw new Error("云端视频草稿无法读取，原数据未覆盖。");return {drafts:[],...v};},
 async getDraft(id:string){return videoDraftSchema.parse(await json<unknown>(`/api/cloud/data?kind=video&id=${encodeURIComponent(id)}`));},
 async write(draft:VideoDraft,expected:number|null,active=true){const value=videoDraftSchema.parse(draft);return videoDraftSchema.parse(await write("video-write",{draft:value,expected,active}));},
 async setActive(id:string){await write("video-active",{id});},async remove(id:string){await write("video-remove",{id});},
};}

export function makeCloudPersonalStore(userId:string){
 const cache=new Map<string,Blob>();
 async function fetchImage(id:string){const old=cache.get(id);if(old)return old;const r=await response(request(`/api/cloud/images/${encodeURIComponent(id)}`));const blob=await r.blob();cache.set(id,blob);return blob;}
 async function upload(a:PersonalStored["assets"][number],force=false){if(!force&&cache.has(a.id))return;const data=new FormData();data.set("id",a.id);data.set("image",a.blob,a.name);await response(request("/api/cloud/images",{method:"POST",body:data}));cache.set(a.id,a.blob);}
 async function decodeDraft(raw:unknown,id:string){if(!raw||typeof raw!=="object"||!("assets" in raw)||!Array.isArray(raw.assets))throw new CloudStorageError("个人草稿不完整，原内容未覆盖。","CORRUPT_RECORD");const parsed=personalStoredSchema.safeParse({...raw,assets:raw.assets.map(asset=>{if(!asset||typeof asset!=="object")return asset;const type="type" in asset&&typeof asset.type==="string"?asset.type:"";return {...asset,blob:new Blob(["x"],{type})};})});if(!parsed.success||parsed.data.id!==id)throw new CloudStorageError("个人草稿不完整，原内容未覆盖。","CORRUPT_RECORD");const assets=await Promise.all(parsed.data.assets.map(async a=>({...a,blob:await fetchImage(a.id)})));return personalStoredSchema.parse({...parsed.data,assets});}
 async function getDraft(id:string){return decodeDraft(await json<unknown>(`/api/cloud/data?kind=personal&id=${encodeURIComponent(id)}`),id);}
 const wire=(d:PersonalStored):PersonalWire=>({...d,assets:d.assets.map(({blob,...a})=>({...a,type:blob.type}))});
 async function decodeNote(n:CompletedWire,expectedId:string){if(!n||n.id!==expectedId)throw new CloudStorageError("完成笔记编号不一致，原内容未覆盖。","CORRUPT_RECORD");return completedNoteSchema.parse({...n,snapshot:await decodeDraft(n.snapshot,n.id),nextDraft:await decodeDraft(n.nextDraft,n.nextDraft.id)});}
 async function saveCompleted(value:CompletedNote){const note=completedNoteSchema.parse(value);for(const a of note.snapshot.assets)await upload(a);const save=()=>write("personal-complete",{note:{...note,snapshot:wire(note.snapshot),nextDraft:wire(note.nextDraft)}}) as Promise<CompletedWire>;let saved:CompletedWire;try{saved=await save();}catch(e){if(!(e instanceof CloudStorageError)||e.code!=="ASSET_MISSING")throw e;for(const a of note.snapshot.assets)await upload(a,true);saved=await save();}return decodeNote(saved,note.id);}
 async function ensureDraft(value:PersonalStored){const draft=personalStoredSchema.parse(value);for(const a of draft.assets)await upload(a);const save=()=>write("personal-ensure",{draft:wire(draft)});let saved:unknown;try{saved=await save();}catch(e){if(!(e instanceof CloudStorageError)||e.code!=="ASSET_MISSING")throw e;for(const a of draft.assets)await upload(a,true);saved=await save();}return decodeDraft(saved,draft.id);}
 async function getCompleted(id:string){return decodeNote(await json<CompletedWire>(`/api/cloud/data?kind=personal-completed&id=${encodeURIComponent(id)}`),id);}
 async function listCompleted(){return z.object({notes:z.array(completedSummarySchema),hiddenDamaged:z.number().int().nonnegative()}).parse(await json<unknown>("/api/cloud/data?kind=personal-completed-list"));}
 async function writeDraft(value:PersonalStored,expected:number|null,active=true){const draft=personalStoredSchema.parse(value);for(const a of draft.assets)await upload(a);const wire:PersonalWire={...draft,assets:draft.assets.map(({blob,...a})=>({...a,type:blob.type}))};const save=async()=>await write("personal-write",{draft:wire,expected,active}) as PersonalWire;let saved:PersonalWire;try{saved=await save();}catch(error){if(!(error instanceof CloudStorageError)||error.code!=="ASSET_MISSING")throw error;for(const a of draft.assets)await upload(a,true);saved=await save();}const byId=new Map(draft.assets.map(a=>[a.id,a.blob]));return personalStoredSchema.parse({...saved,assets:saved.assets.map(a=>({...a,blob:byId.get(a.id)}))});}
 return {saveCompleted,ensureDraft,getCompleted,listCompleted,async readWorkspace(){if(!userId)throw new Error("请先登录后读取个人草稿。");const result=z.object({summaries:z.array(z.unknown()),activeId:z.string().uuid().optional(),hiddenDamaged:z.number().int().nonnegative().optional()}).safeParse(await json<unknown>("/api/cloud/data?kind=personal-workspace"));if(!result.success)throw new CloudStorageError("个人草稿列表无法读取。","CORRUPT_RECORD");const rowSchema=z.object({id:z.string().uuid(),name:z.string().max(80),updatedAt:z.string().datetime(),thumbnailId:z.string().uuid().nullable(),damaged:z.boolean().optional(),excerpt:z.string().optional(),style:z.string().optional(),stage:z.string().optional(),suggestedName:z.string().optional()});let hiddenDamaged=result.data.hiddenDamaged??0;const summaries:PersonalSummary[]=[];const seen=new Set<string>();for(const raw of result.data.summaries){const row=rowSchema.safeParse(raw);if(!row.success||seen.has(row.data.id)){hiddenDamaged++;continue;}seen.add(row.data.id);summaries.push({...row.data,thumbnailId:row.data.thumbnailId??undefined});}return {drafts:[] as unknown[],summaries,activeId:result.data.activeId,hiddenDamaged};},getDraft,writeDraft,async preserveSnapshot(value:PersonalStored){const copy=copyPersonalDraft(value);copy.name=`${value.name.slice(0,68)}（重新生成前）`;return writeDraft(copy,null,false);},async setActive(id:string){await write("personal-active",{id});},async deleteDraft(id:string){await write("personal-remove",{id});}};
}

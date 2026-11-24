import { personalSummaryDetails } from "@/lib/personal/draft-summary";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {completedNoteSchema,completedSummarySchema,completedSummary,completionSignature,type CompletedNote} from "@/lib/personal/completed";
import { z } from "zod";
import { isTitleWithinLimit, XHS_TITLE_RULE } from "@/lib/xhs-title";
import { AppError } from "@/lib/errors";
import { storedDraftSchema, type StoredDraft } from "@/lib/drafts";
import { videoDraftSchema, type VideoDraft } from "@/lib/video/drafts";
import { personalStoredSchema, type PersonalStored } from "@/lib/personal/drafts";
import { customStyleSchema, type CustomStyle } from "@/lib/styles";
import { IMAGE_TYPES, MAX_FILE_BYTES } from "@/lib/constants";
import { getRepository, type Repository, type Transaction } from "./repository";
import { getBlobs, type BlobStorage } from "./blobs";

type Asset = { id:string; owner:string; ref:string; digest:string; type:string; size:number; refs:number; unlinkedAt:number|null; status:"ready"|"deleting"; expiresAt?:number|null; deletionId?:string; deletionLeaseUntil?:number };
type UploadIntent = { id:string; owner:string; ref:string; createdAt:number; expiresAt:number; status:"pending"|"deleting"; deletionId?:string; deletionLeaseUntil?:number };
type WireAsset = Omit<StoredDraft["assets"][number],"blob"> & { type:string };
export type PhotoWire = Omit<StoredDraft,"assets"> & { assets:WireAsset[] };
export type PersonalWire = Omit<PersonalStored,"assets"> & { assets:WireAsset[] };
export type CompletedWire=Omit<CompletedNote,"snapshot"|"nextDraft">&{snapshot:PersonalWire;nextDraft:PersonalWire};
function completedWithBlobs(value:CompletedWire){const add=(s:PersonalWire)=>({...s,assets:s.assets.map(a=>({...a,blob:new Blob(["x"],{type:a.type})}))});return completedNoteSchema.parse({...value,snapshot:add(value.snapshot),nextDraft:add(value.nextDraft)});}
function parseCompletedWire(value:unknown):CompletedWire{if(!value||typeof value!=="object"||!("snapshot" in value)||!("nextDraft" in value))throw new AppError("INVALID_FORM","完成笔记不完整。",400);const n=completedWithBlobs({...value,snapshot:parsePersonalWire(value.snapshot),nextDraft:parsePersonalWire(value.nextDraft)} as CompletedWire);const strip=(s:PersonalStored):PersonalWire=>({...s,assets:s.assets.map(({blob,...a})=>({...a,type:blob.type}))});return {...n,snapshot:strip(n.snapshot),nextDraft:strip(n.nextDraft)};}
const uuid=z.string().uuid();
const photoSummaryFields=z.object({id:uuid,name:z.string().max(80),updatedAt:z.string().max(40).datetime(),contentMode:z.enum(["demo","live"]).nullable(),thumbnailId:uuid.nullable()});
const videoSummaryFields=z.object({id:uuid,name:z.string().max(80),updatedAt:z.string().max(40).datetime({offset:true}),before:z.boolean(),after:z.boolean()});
const videoTimestamp=z.string().max(40).datetime({offset:true});
const key=(user:string,id:string)=>`${user}:${id}`;
const failMissing=()=>new AppError("NOT_FOUND","没有找到这份内容。",404);
const assetMissing=()=>new AppError("ASSET_MISSING","图片尚未保存或已清理，请重试保存。",409);
const conflict=()=>new AppError("DRAFT_CONFLICT","这份草稿已在其他设备修改或删除，未覆盖。请先复制或导出当前内容，再重新打开。",409);
const parseId=(id:unknown)=>{const parsed=uuid.safeParse(id);if(!parsed.success)throw new AppError("INVALID_FORM","内容编号不正确。",400);return parsed.data;};

// Validate using the existing schema, with blobs represented only by validated MIME on the wire.
export function parsePhotoWire(input:unknown):PhotoWire {
  if (!input || typeof input!=="object" || !("assets" in input) || !Array.isArray(input.assets) || input.assets.length>18) throw new AppError("INVALID_FORM","草稿结构不正确。",400);
  const assets=input.assets.map((entry:unknown)=>{
    if(!entry||typeof entry!=="object"||!("type" in entry)||typeof entry.type!=="string"||!IMAGE_TYPES.includes(entry.type)) throw new AppError("INVALID_FORM","草稿图片类型不正确。",400);
    return {...entry,blob:new Blob(["x"],{type:entry.type})};
  });
  const parsed=storedDraftSchema.safeParse({...input,assets});
  if(!parsed.success||parsed.data.createdAt.length>40||parsed.data.updatedAt.length>40||((parsed.data.generation?.meta.completedAt.length??0)>40))throw new AppError("INVALID_FORM","草稿内容、时间或图片对应关系不正确，原数据保留。",400);
  return {...parsed.data,assets:parsed.data.assets.map(({blob,...image})=>({...image,type:blob.type}))};
}
export function parsePersonalWire(input:unknown):PersonalWire {
  if(!input||typeof input!=="object"||!("assets" in input)||!Array.isArray(input.assets)||input.assets.length>18)throw new AppError("INVALID_FORM","个人草稿结构不正确。",400);
  const assets=input.assets.map((entry:unknown)=>{if(!entry||typeof entry!=="object"||!("type" in entry)||typeof entry.type!=="string"||!IMAGE_TYPES.includes(entry.type))throw new AppError("INVALID_FORM","个人草稿图片类型不正确。",400);return {...entry,blob:new Blob(["x"],{type:entry.type})};});
  const parsed=personalStoredSchema.safeParse({...input,assets});
  if(!parsed.success||parsed.data.createdAt.length>40||parsed.data.updatedAt.length>40||(parsed.data.generation?.meta.completedAt.length??0)>40)throw new AppError("INVALID_FORM","个人草稿内容或图片对应关系不正确。",400);
  return {...parsed.data,assets:parsed.data.assets.map(({blob,...image})=>({...image,type:blob.type}))};
}
function validRevision(expected:unknown):number|null { if(expected===null)return null;const x=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).safeParse(expected);if(!x.success)throw new AppError("INVALID_FORM","草稿版本不正确。",400);return x.data; }
async function getOwnedAsset(tx:Transaction,user:string,id:string):Promise<Asset> {const row=await tx.get<Asset>("assets",key(user,id));if(!row||row.owner!==user||row.id!==id||row.status!=="ready")throw assetMissing();return row;}

export function createDataService(repo:Repository,blobs:BlobStorage) {
  async function upload(user:string,idRaw:unknown,file:File) {
    const id=parseId(idRaw);
    if(!(file instanceof File)||!IMAGE_TYPES.includes(file.type)||file.size<1||file.size>MAX_FILE_BYTES)throw new AppError("INVALID_IMAGE","图片须为不超过 5MB 的 JPEG、PNG 或 WebP。",400);
    const bytes=Buffer.from(await file.arrayBuffer()),digest=createHash("sha256").update(bytes).digest("hex");
    try {
      const pipeline=sharp(bytes,{limitInputPixels:24_000_000,failOn:"warning"}); const metadata=await pipeline.metadata();
      const types:Record<string,string>={jpeg:"image/jpeg",png:"image/png",webp:"image/webp"};
      if(!metadata.format||types[metadata.format]!==file.type||!metadata.width||!metadata.height||(metadata.pages??1)>1)throw new Error("invalid");
      await pipeline.rotate().resize({width:32,height:32,fit:"inside",withoutEnlargement:true}).jpeg().toBuffer();
    } catch {throw new AppError("INVALID_IMAGE","图片不完整、格式不匹配或超过 2400 万像素。",400);}
    const existing=await repo.get<Asset>("assets",key(user,id));
    if(existing) {
      if(existing.owner!==user||existing.status!=="ready"||existing.digest!==digest||existing.type!==file.type)throw new AppError("ASSET_CONFLICT","此图片编号已被占用，请重新上传图片。",409);
      return {id,type:existing.type,size:existing.size};
    }
    const uploadId=randomUUID(),objectKey=`users/${user}/images/${id}-${uploadId}.bin`,ref=await blobs.put(objectKey,bytes);
    const createdAt=Date.now(),intent:UploadIntent={id,owner:user,ref,createdAt,expiresAt:createdAt+24*60*60_000,status:"pending"};
    // Journal the uploaded object before publishing any reference. Cleanup can retry after failures.
    try {await repo.put("asset_uploads",uploadId,intent,user);}catch(error){await blobs.remove(ref).catch(()=>undefined);throw error;}
    try {
      const result=await repo.transaction(async tx=>{
        const pending=await tx.get<UploadIntent>("asset_uploads",uploadId);
        if(!pending||pending.status!=="pending"||pending.ref!==ref)throw new AppError("ASSET_CONFLICT","图片保存已过期，请重新上传。",409);
        const other=await tx.get<Asset>("assets",key(user,id));
        if(other) {if(other.owner!==user||other.status!=="ready"||other.digest!==digest||other.type!==file.type)throw new AppError("ASSET_CONFLICT","此图片编号已被占用，请重新上传图片。",409);return {asset:other,inserted:false};}
        const now=Date.now(),value:Asset={id,owner:user,ref,digest,type:file.type,size:bytes.length,refs:0,unlinkedAt:now,expiresAt:now+24*60*60_000,status:"ready"};
        await tx.put("assets",key(user,id),value,user);await tx.remove("asset_uploads",uploadId);return {asset:value,inserted:true};
      });
      if(!result.inserted){try{await blobs.remove(ref);await repo.remove("asset_uploads",uploadId);}catch{/* journal remains for later cleanup */}}
      return {id,type:result.asset.type,size:result.asset.size};
    } catch(error) {
      // A commit response can be lost; never delete an object that may already be referenced.
      try{const value=await repo.get<Asset>("assets",key(user,id));if(value?.ref===ref&&value.status==="ready")return {id,type:value.type,size:value.size};}catch{/* journal is retained for later cleanup */}
      throw error;
    }
  }
  async function image(user:string,idRaw:unknown,thumbnail=false) {
    const id=parseId(idRaw), asset=await repo.get<Asset>("assets",key(user,id));
    if(!asset||asset.owner!==user||asset.status!=="ready")throw failMissing();
    let bytes:Buffer;
    try {bytes=await blobs.get(asset.ref);} catch(error) {
      if(error && typeof error==="object" && "code" in error && error.code==="BLOB_NOT_FOUND")throw new AppError("INVALID_IMAGE","这张云端图片无法找到，草稿未被覆盖。",422);
      throw error;
    }
    if(!thumbnail)return {bytes,type:asset.type};
    try {return {bytes:await sharp(bytes,{limitInputPixels:24_000_000}).rotate().resize(160,160,{fit:"cover"}).jpeg({quality:75}).toBuffer(),type:"image/jpeg"};}catch{throw new AppError("INVALID_IMAGE","缩略图读取失败。",422);}
  }
  async function photo(user:string,idRaw:unknown) {
    const id=parseId(idRaw);let row:PhotoWire|null;
    try {row=await repo.get<PhotoWire>("photos",key(user,id));} catch(error) {
      if(error instanceof SyntaxError || (error instanceof Error && error.message==="CLOUD_DATABASE_CORRUPT"))throw new AppError("CORRUPT_RECORD","这份草稿记录损坏，原始内容未被覆盖。",422);
      throw error;
    }
    if(!row)throw failMissing();return row;
  }
  async function savePhoto(user:string,input:unknown,expectedRaw:unknown,active=true) {
    const draft=parsePhotoWire(input),expected=validRevision(expectedRaw),id=draft.id;
    return repo.transaction(async tx=>{
      const previous=await tx.get<PhotoWire>("photos",key(user,id));
      if(expected===null?Boolean(previous):!previous||previous.revision!==expected)throw conflict();
      // Old clients must never overwrite a newer format, even with the correct revision.
      if(previous && previous.version > draft.version)throw new AppError("CONFLICT","这份草稿来自较新版本，未覆盖原数据。请更新工具后再编辑。",409);
      const oldIds=new Set(previous?.assets.map(a=>a.id)??[]),newIds=new Set(draft.assets.map(a=>a.id));
      for(const a of draft.assets){const record=await getOwnedAsset(tx,user,a.id);if(record.type!==a.type)throw new AppError("INVALID_IMAGE","草稿图片格式不一致，未保存。",400);}
      for(const id of newIds)if(!oldIds.has(id)){const a=await getOwnedAsset(tx,user,id);await tx.put("assets",key(user,id),{...a,refs:a.refs+1,unlinkedAt:null,expiresAt:null},user);}
      for(const id of oldIds)if(!newIds.has(id)){const a=await getOwnedAsset(tx,user,id);if(a.refs<1)throw new AppError("STORAGE_INCONSISTENT","图片引用状态异常，未保存。",409);await tx.put("assets",key(user,id),{...a,refs:a.refs-1,unlinkedAt:a.refs===1?Date.now():null,expiresAt:a.refs===1?Date.now()+24*60*60_000:null},user);}
      const saved={...draft,revision:(expected??0)+1};await tx.put("photos",key(user,id),saved,user);
      await tx.put("photo_summaries",key(user,id),{id,name:saved.name,updatedAt:saved.updatedAt,contentMode:saved.generation?.mode??null,thumbnailId:saved.imageIds[0]??null},user);
      if(active)await tx.put("active",key(user,"photo"),{id},user);return saved;
    });
  }
  async function deletePhoto(user:string,idRaw:unknown) {
    const id=parseId(idRaw);return repo.transaction(async tx=>{
      const old=await tx.get<PhotoWire>("photos",key(user,id));if(!old)throw failMissing();
      for(const item of old.assets){const a=await getOwnedAsset(tx,user,item.id);if(a.refs<1)throw new AppError("STORAGE_INCONSISTENT","图片引用状态异常，未删除草稿。",409);await tx.put("assets",key(user,item.id),{...a,refs:a.refs-1,unlinkedAt:a.refs===1?Date.now():null,expiresAt:a.refs===1?Date.now()+24*60*60_000:null},user);}
      await tx.remove("photos",key(user,id));await tx.remove("photo_summaries",key(user,id));const active=await tx.get<{id:string}>("active",key(user,"photo"));if(active?.id===id)await tx.remove("active",key(user,"photo"));
    });
  }
  async function photoWorkspace(user:string) {
    const rows=await repo.scanSafe<unknown>("photo_summaries",user),active=await repo.get<{id:string}>("active",key(user,"photo")),templates=await repo.scanSafe<CustomStyle>("templates",user);
    let hiddenDamaged=0;
    const drafts=rows.flatMap<{id:string;name:string;updatedAt:string;contentMode:"demo"|"live"|null;thumbnailId:string|null;damaged:boolean}>(({id:recordId,value})=>{
      const candidate=photoSummaryFields.safeParse(value);
      if(candidate.success&&recordId===key(user,candidate.data.id))return [{...candidate.data,damaged:false}];
      const ownId=recordId.startsWith(`${user}:`)?uuid.safeParse(recordId.slice(user.length+1)):null;
      if(!ownId?.success){hiddenDamaged++;return [];}
      return [{id:ownId.data,name:"无法读取的草稿",updatedAt:"",contentMode:null,thumbnailId:null,damaged:true}];
    });
    return {drafts,activeId:active?.id,templates:templates.map(x=>x.value),hiddenDamaged};
  }
  async function personal(user:string,idRaw:unknown){const id=parseId(idRaw);let row:PersonalWire|null;try{row=await repo.get<PersonalWire>("personal",key(user,id));}catch(error){if(error instanceof SyntaxError||(error instanceof Error&&error.message==="CLOUD_DATABASE_CORRUPT"))throw new AppError("CORRUPT_RECORD","个人草稿损坏，原记录未覆盖。",422);throw error;}if(!row)throw failMissing();return row;}
  async function savePersonal(user:string,input:unknown,expectedRaw:unknown,active=true,ensure=false){const draft=parsePersonalWire(input),expected=validRevision(expectedRaw),id=draft.id;return repo.transaction(async tx=>{const old=await tx.get<PersonalWire>("personal",key(user,id));if(ensure&&old){if(active)await tx.put("active",key(user,"personal"),{id},user);return old;}if(expected===null?Boolean(old):!old||old.revision!==expected)throw conflict();if(old&&old.version>draft.version)throw conflict();const before=new Set(old?.assets.map(a=>a.id)??[]),after=new Set(draft.assets.map(a=>a.id));for(const a of draft.assets){const record=await getOwnedAsset(tx,user,a.id);if(record.type!==a.type)throw new AppError("INVALID_IMAGE","个人草稿图片格式不一致。",400);}for(const id of after)if(!before.has(id)){const a=await getOwnedAsset(tx,user,id);await tx.put("assets",key(user,id),{...a,refs:a.refs+1,unlinkedAt:null,expiresAt:null},user);}for(const id of before)if(!after.has(id)){const a=await getOwnedAsset(tx,user,id);if(a.refs<1)throw new AppError("STORAGE_INCONSISTENT","图片引用状态异常，未保存。",409);await tx.put("assets",key(user,id),{...a,refs:a.refs-1,unlinkedAt:a.refs===1?Date.now():null,expiresAt:a.refs===1?Date.now()+24*60*60_000:null},user);}const saved={...draft,revision:(expected??0)+1};await tx.put("personal",key(user,id),saved,user);await tx.put("personal_summaries",key(user,id),{id,name:saved.name,updatedAt:saved.updatedAt,thumbnailId:saved.imageIds[0]??null,...personalSummaryDetails(saved)},user);if(active)await tx.put("active",key(user,"personal"),{id},user);return saved;});}
  async function deletePersonal(user:string,idRaw:unknown){const id=parseId(idRaw);return repo.transaction(async tx=>{const old=await tx.get<PersonalWire>("personal",key(user,id));if(!old)throw failMissing();for(const item of old.assets){const a=await getOwnedAsset(tx,user,item.id);if(a.refs<1)throw new AppError("STORAGE_INCONSISTENT","图片引用状态异常，未删除草稿。",409);await tx.put("assets",key(user,item.id),{...a,refs:a.refs-1,unlinkedAt:a.refs===1?Date.now():null,expiresAt:a.refs===1?Date.now()+24*60*60_000:null},user);}await tx.remove("personal",key(user,id));await tx.remove("personal_summaries",key(user,id));const active=await tx.get<{id:string}>("active",key(user,"personal"));if(active?.id===id)await tx.remove("active",key(user,"personal"));});}
  async function completed(user:string,idRaw:unknown){const id=parseId(idRaw),row=await repo.get<CompletedWire>("personal_completed",key(user,id));if(!row)throw failMissing();return parseCompletedWire(row);}
  async function saveCompleted(user:string,value:unknown){const note=parseCompletedWire(value);return repo.transaction(async tx=>{
    const old=await tx.get<CompletedWire>("personal_completed",key(user,note.id));
    if(old){if(completionSignature(completedWithBlobs(old))!==completionSignature(completedWithBlobs(note)))throw conflict();return old;}
    if (!note.snapshot.generation!.result.titles.every(isTitleWithinLimit)) throw new AppError("INVALID_FORM", XHS_TITLE_RULE, 400);
    for(const item of note.snapshot.assets){const asset=await getOwnedAsset(tx,user,item.id);if(asset.type!==item.type)throw new AppError("INVALID_IMAGE","图片格式不一致。",400);await tx.put("assets",key(user,item.id),{...asset,refs:asset.refs+1,unlinkedAt:null,expiresAt:null},user);}
    const saved={...note,savedAt:new Date().toISOString()};await tx.put("personal_completed",key(user,note.id),saved,user);
    const {thumbnail,...summary}=completedSummary(completedWithBlobs(saved));void thumbnail;await tx.put("personal_completed_summaries",key(user,note.id),summary,user);return saved;
  });}
  async function completedList(user:string){const rows=await repo.scanSafe<unknown>("personal_completed_summaries",user);let hiddenDamaged=0;const notes=rows.flatMap(row=>{const p=completedSummarySchema.safeParse(row.value);if(!p.success||row.id!==key(user,p.data.id)){hiddenDamaged++;return [];}return [p.data];});return {notes:notes.sort((a,b)=>b.savedAt.localeCompare(a.savedAt)),hiddenDamaged};}
  async function ensurePersonal(user:string,value:unknown){return savePersonal(user,value,null,true,true);}
  async function personalWorkspace(user:string){
    const rows=await repo.scanSafe<unknown>("personal_summaries",user);
    const active=await repo.get<{id:string}>("active",key(user,"personal"));
    const fields=z.object({id:uuid,name:z.string().max(80),updatedAt:z.string().max(40).datetime(),thumbnailId:uuid.nullable(),excerpt:z.string().optional(),style:z.string().optional(),stage:z.string().optional(),suggestedName:z.string().optional()});
    let hiddenDamaged=0;
    const summaries=[];
    for(const row of rows){
      const parsed=fields.safeParse(row.value);
      if(!parsed.success||row.id!==key(user,parsed.data.id)){hiddenDamaged++;continue;}
      let detail={...parsed.data};
      if(detail.excerpt===undefined){
        // Older summary records can be enriched from text metadata, without loading image blobs or rewriting old drafts.
        try{const stored=await personal(user,detail.id);detail={...detail,...personalSummaryDetails(parsePersonalWire(stored))};}
        catch{summaries.push({...detail,damaged:true});continue;}
      }
      summaries.push({...detail,damaged:false});
    }
    return {summaries,activeId:active?.id,hiddenDamaged};
  }
  async function setPersonalActive(user:string,idRaw:unknown){const id=parseId(idRaw);await repo.transaction(async tx=>{if(!await tx.get("personal",key(user,id)))throw failMissing();await tx.put("active",key(user,"personal"),{id},user);});}
  async function videos(user:string){
    const rows=await repo.scanSafe<unknown>("video_summaries",user),active=await repo.get<{id:string}>("active",key(user,"video"));let hiddenDamaged=0;
    const summaries=rows.flatMap<{id:string;name:string;updatedAt:string;before:boolean;after:boolean;damaged:boolean}>(({id:recordId,value})=>{
      const parsed=videoSummaryFields.safeParse(value);if(parsed.success&&recordId===key(user,parsed.data.id))return [{...parsed.data,damaged:false}];
      const ownId=recordId.startsWith(`${user}:`)?uuid.safeParse(recordId.slice(user.length+1)):null;if(!ownId?.success){hiddenDamaged++;return [];}
      return [{id:ownId.data,name:"无法读取的视频草稿",updatedAt:"",before:false,after:false,damaged:true}];
    });return {summaries,activeId:active?.id||"",hiddenDamaged};
  }
  async function video(user:string,idRaw:unknown){
    const id=parseId(idRaw);let value:VideoDraft|null;try{value=await repo.get<VideoDraft>("videos",key(user,id));}catch(error){if(error instanceof SyntaxError||(error instanceof Error&&error.message==="CLOUD_DATABASE_CORRUPT"))throw new AppError("CORRUPT_RECORD","这份视频草稿损坏，原内容未被覆盖。",422);throw error;}
    if(!value)throw failMissing();return value;
  }
  async function saveVideo(user:string,input:unknown,expectedRaw:unknown,active=true){
    const parsed=videoDraftSchema.safeParse(input);if(!parsed.success)throw new AppError("INVALID_FORM","视频草稿内容不正确，原数据保留。",400);
    const draft=parsed.data;
    const times=[draft.createdAt,draft.updatedAt,...[draft.before,draft.after].flatMap(g=>g?[g.meta.completedAt]:[])];
    if(times.some(t=>!videoTimestamp.safeParse(t).success))throw new AppError("INVALID_FORM","视频草稿时间格式不正确，原数据保留。",400);
    const expected=validRevision(expectedRaw);return repo.transaction(async tx=>{const old=await tx.get<VideoDraft>("videos",key(user,draft.id));if(expected===null?Boolean(old):!old||old.revision!==expected)throw conflict();const saved={...draft,revision:(expected??0)+1};await tx.put("videos",key(user,draft.id),saved,user);await tx.put("video_summaries",key(user,draft.id),{id:draft.id,name:draft.name,updatedAt:draft.updatedAt,before:Boolean(draft.before),after:Boolean(draft.after)},user);if(active)await tx.put("active",key(user,"video"),{id:draft.id},user);return saved;});
  }
  async function deleteVideo(user:string,idRaw:unknown){const id=parseId(idRaw);await repo.transaction(async tx=>{if(!await tx.get("videos",key(user,id)))throw failMissing();await tx.remove("videos",key(user,id));await tx.remove("video_summaries",key(user,id));const active=await tx.get<{id:string}>("active",key(user,"video"));if(active?.id===id)await tx.remove("active",key(user,"video"));});}
  async function setActive(user:string,kind:"photo"|"video",idRaw:unknown){const id=parseId(idRaw);await repo.transaction(async tx=>{if(!await tx.get(kind==="photo"?"photos":"videos",key(user,id)))throw failMissing();await tx.put("active",key(user,kind),{id},user);});}
  async function templates(user:string){return (await repo.scanSafe<CustomStyle>("templates",user)).map(x=>x.value);}
  async function saveTemplate(user:string,input:unknown){const value=customStyleSchema.safeParse(input);if(!value.success||value.data.updatedAt.length>40)throw new AppError("INVALID_FORM","模板内容不正确。",400);await repo.put("templates",key(user,value.data.id),value.data,user);return value.data;}
  async function deleteTemplate(user:string,idRaw:unknown){const id=parseId(idRaw);if(!await repo.get("templates",key(user,id)))throw failMissing();await repo.remove("templates",key(user,id));}
  async function cleanup(now=Date.now(),limit=20){
    const bounded=Math.max(1,Math.min(100,Math.floor(limit)));const rows=await repo.scanExpired<Asset>("assets",now,bounded);let removed=0,failed=0;
    for(const row of rows){if(removed+failed>=bounded)break;const a=row.value;if(a.refs!==0||!a.unlinkedAt||a.unlinkedAt>now-24*60*60*1000)continue;
      const deletionId=randomUUID();const claimed=await repo.transaction(async tx=>{const cur=await tx.get<Asset>("assets",row.id);if(!cur||cur.refs!==0||!cur.unlinkedAt||cur.unlinkedAt>now-24*60*60*1000||(cur.status==="deleting"&&(cur.deletionLeaseUntil??0)>now))return null;const next={...cur,status:"deleting" as const,deletionId,deletionLeaseUntil:now+60_000,expiresAt:now+60_000};await tx.put("assets",row.id,next,cur.owner);return next;});
      if(!claimed)continue;
      try {await blobs.remove(claimed.ref);await repo.transaction(async tx=>{const current=await tx.get<Asset>("assets",row.id);if(current?.status==="deleting"&&current.deletionId===deletionId&&current.refs===0)await tx.remove("assets",row.id);});removed++;}catch{failed++;}
    }
    if(removed+failed<bounded){
      const uploads=await repo.scanExpired<UploadIntent>("asset_uploads",now,bounded-removed-failed);
      for(const row of uploads){if(removed+failed>=bounded)break;const u=row.value;if(u.createdAt>now-24*60*60*1000)continue;
        const deletionId=randomUUID();const claim=await repo.transaction(async tx=>{
          const current=await tx.get<UploadIntent>("asset_uploads",row.id);if(!current||current.createdAt>now-24*60*60*1000||(current.status==="deleting"&&(current.deletionLeaseUntil??0)>now))return null;
          const asset=await tx.get<Asset>("assets",key(current.owner,current.id));
          if(asset?.ref===current.ref){await tx.remove("asset_uploads",row.id);return null;}
          const next={...current,status:"deleting" as const,deletionId,deletionLeaseUntil:now+60_000,expiresAt:now+60_000};await tx.put("asset_uploads",row.id,next,current.owner);return next;
        });
        if(!claim)continue;
        try{await blobs.remove(claim.ref);await repo.transaction(async tx=>{const current=await tx.get<UploadIntent>("asset_uploads",row.id);if(current?.status==="deleting"&&current.deletionId===deletionId)await tx.remove("asset_uploads",row.id);});removed++;}catch{failed++;}
      }
    }
    return {removed,failed};
  }
  return {completed,saveCompleted,completedList,ensurePersonal,upload,image,photo,savePhoto,deletePhoto,photoWorkspace,personal,savePersonal,deletePersonal,personalWorkspace,setPersonalActive,videos,video,saveVideo,deleteVideo,setActive,templates,saveTemplate,deleteTemplate,cleanup};
}
let service:ReturnType<typeof createDataService>|undefined;
export async function getDataService(){return service??=createDataService(await getRepository(),await getBlobs());}

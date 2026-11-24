import "server-only";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import { normalizeHotspotCollection, hotspotSourceErrorMessage } from "@/lib/server/hotspots-source";
import { HOTSPOT_SOURCE, HOTSPOT_SOURCE_KEY, hotspotSourceMetadata, hotspotSelectionNotice } from "@/lib/hotspot-metadata";
import type { Hotspot, HotspotCollection, HotspotSuggestion, HotspotState } from "@/lib/server/hotspots-types";
import { getRepository, type Transaction } from "./repository";

export type Shared = {sourceKey?:string;sourceCount?:number;filteredCount?:number;lastAttemptSourceKey?:string;items:Hotspot[];lastSuccessAt:string|null;lastAttemptAt:string|null;error:string|null;sources:HotspotState["sources"];version:string;lock?:string;lockUntil?:number;lastCronAt?:number};
type Personal = { version:string;suggestions:HotspotSuggestion[];generatedAt:string };
const empty=():Shared=>({items:[],lastSuccessAt:null,lastAttemptAt:null,error:null,sources:[],version:""});
const day=(date:string|Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(date));
function shape(shared:Shared, personal:Personal|null):HotspotState {
 const valid=personal?.version===shared.version?personal:null;
 return {items:shared.items,lastSuccessAt:shared.lastSuccessAt,lastAttemptAt:shared.lastAttemptAt,updating:Boolean(shared.lock&&Date.now()<(shared.lockUntil??0)),error:shared.error,sources:shared.sources,sourceCount:shared.sourceCount,filteredCount:shared.filteredCount,selectionNotice:shared.sourceKey===HOTSPOT_SOURCE_KEY?hotspotSelectionNotice(shared.sourceCount,shared.items.length):null,...hotspotSourceMetadata(shared.sourceKey,Boolean(shared.items.length)),suggestions:valid?.suggestions??[],suggestionGeneratedAt:valid?.generatedAt??null,suggestionError:null,suggestionLocked:false,scheduler:shared.lastCronAt&&Date.now()-shared.lastCronAt<35*60_000?"running":"disabled",storage:"disk"};
}
export async function readShared(){return (await (await getRepository()).get<Shared>("shared","hotspots"))??empty();}
export async function cloudHotspotState(owner:string,expectedVersion?:string){const db=await getRepository();const [shared,personal]=await Promise.all([db.get<Shared>("shared","hotspots"),db.get<Personal>("hotspot-ideas",owner)]);const current=shared??empty();if(expectedVersion!==undefined&&current.version!==expectedVersion)throw new AppError("STALE_HOTSPOTS","热点已经更新，旧建议未采用，请重新生成。",409);return shape(current,personal);}
export async function storeSuggestionsInTransaction(tx:Transaction,owner:string,version:string,suggestions:HotspotSuggestion[]){
 const shared=await tx.get<Shared>("shared","hotspots")??empty();
 if(shared.version!==version||!shared.items.length)throw new AppError("STALE_HOTSPOTS","热点已经更新，旧建议未保存，请重新生成。",409);
 const personal:Personal={version,suggestions,generatedAt:new Date().toISOString()};await tx.put("hotspot-ideas",owner,personal,owner);return shape(shared,personal);
}
/** Cross-instance lease; failure keeps the last successful list and timestamp. */
export async function updateCloudHotspots(force=false,collect?: (now:string)=>Promise<Hotspot[] | HotspotCollection>){
 // OpenClaw uses a local, user-verified browser session. Cloud cron must not revive the retired Baidu feed.
 if(!collect)return;
 const db=await getRepository(),now=Date.now(),lock=randomUUID();
 const acquired=await db.transaction(async tx=>{
  const old=await tx.get<Shared>("shared","hotspots")??empty();
  if(old.lock&&(old.lockUntil??0)>now)return false;
  if(!force&&old.sourceKey===HOTSPOT_SOURCE_KEY&&old.lastSuccessAt&&day(old.lastSuccessAt)===day(new Date(now)))return false;
  if(!force&&old.lastAttemptSourceKey===HOTSPOT_SOURCE_KEY&&old.lastAttemptAt&&now-Date.parse(old.lastAttemptAt)<30*60_000)return false;
  await tx.put("shared","hotspots",{...old,lastAttemptSourceKey:HOTSPOT_SOURCE_KEY,lastAttemptAt:new Date(now).toISOString(),lock,lockUntil:now+45_000});return true;
 });
 if(!acquired)return;
 let batch:HotspotCollection|null=null,errorMessage="";try{batch=normalizeHotspotCollection(await collect(new Date(now).toISOString()));}catch(error){errorMessage=hotspotSourceErrorMessage(error);}
 await db.transaction(async tx=>{
  const current=await tx.get<Shared>("shared","hotspots");if(!current||current.lock!==lock)return;
  const next:Shared=batch?{...current,sourceKey:HOTSPOT_SOURCE_KEY,...batch,lastSuccessAt:new Date(now).toISOString(),error:null,sources:[{name:HOTSPOT_SOURCE,status:"success",count:batch.items.length}],version:randomUUID()}
   :{...current,error:errorMessage+(current.items.length?" 当前保留上次成功的数据与采集时间。":" 当前没有可展示的热点。"),sources:[{name:HOTSPOT_SOURCE,status:"error",count:0,error:errorMessage}]};
  delete next.lock;delete next.lockUntil;await tx.put("shared","hotspots",next);
 });
}
export async function recordCron(){const db=await getRepository();await db.transaction(async tx=>{const old=await tx.get<Shared>("shared","hotspots")??empty();await tx.put("shared","hotspots",{...old,lastCronAt:Date.now()});});}

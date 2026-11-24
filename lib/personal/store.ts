import {isTitleWithinLimit, XHS_TITLE_RULE} from "../xhs-title";
import {completedNoteSchema,completedSummary,completionSignature,type CompletedNote} from "./completed";
import { copyPersonalDraft, personalSummary, type PersonalSummary, personalStoredSchema, type PersonalStored } from "./drafts";

export const PERSONAL_DATABASE = "xhs-personal-studio";
async function db():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{if(typeof indexedDB==="undefined"){reject(new Error("当前浏览器无法使用本机存储，内容仍在页面。"));return;}const req=indexedDB.open(PERSONAL_DATABASE,2);let settled=false;const timer=setTimeout(()=>{settled=true;reject(new Error("个人草稿读取超时，请关闭其他旧页面后重试。"));},8000);req.onupgradeneeded=()=>{for(const n of ["drafts","settings","completed"])if(!req.result.objectStoreNames.contains(n))req.result.createObjectStore(n,{keyPath:"id"});};req.onsuccess=()=>{clearTimeout(timer);if(settled){req.result.close();return;}settled=true;req.result.onversionchange=()=>req.result.close();resolve(req.result);};req.onerror=()=>{clearTimeout(timer);reject(req.error);};req.onblocked=()=>{clearTimeout(timer);settled=true;reject(new Error("个人草稿存储被其他页面阻挡，请关闭旧页面后重试。"));};});}
async function transaction<T>(mode:IDBTransactionMode,work:(tx:IDBTransaction,fail:(e:Error)=>void)=>()=>T):Promise<T>{const conn=await db();try{return await new Promise((resolve,reject)=>{const tx=conn.transaction(["drafts","settings","completed"],mode);let failure:Error|undefined;let result:()=>T;tx.oncomplete=()=>{try{resolve(result());}catch(e){reject(e);}};tx.onabort=()=>reject(failure||tx.error||new Error("个人草稿保存未完成。"));tx.onerror=()=>{};try{result=work(tx,e=>{failure=e;tx.abort();});}catch(e){failure=e instanceof Error?e:new Error("个人草稿存储失败。");tx.abort();}});}finally{conn.close();}}
export const personalLocalStore={
 async saveCompleted(value:CompletedNote){const note=completedNoteSchema.parse(value);return transaction("readwrite",(tx,fail)=>{const store=tx.objectStore("completed"),req=store.get(note.id);let saved=note;req.onsuccess=()=>{try{if(req.result){saved=completedNoteSchema.parse(req.result);if(completionSignature(saved)!==completionSignature(note))throw new Error("保存编号冲突，已完成记录未覆盖。");}else {if(!note.snapshot.generation!.result.titles.every(isTitleWithinLimit))throw new Error(XHS_TITLE_RULE);store.add(note);}}catch(e){fail(e instanceof Error?e:new Error("完成笔记无法保存。"));}};return()=>saved;});},
 async getCompleted(id:string){return transaction("readonly",tx=>{let value:unknown;const r=tx.objectStore("completed").get(id);r.onsuccess=()=>{value=r.result;};return()=>completedNoteSchema.parse(value);});},
 async listCompleted(){return transaction("readonly",tx=>{let values:unknown[]=[];const r=tx.objectStore("completed").getAll();r.onsuccess=()=>{values=r.result;};return()=>{let hiddenDamaged=0;const notes=values.flatMap(v=>{const parsed=completedNoteSchema.safeParse(v);if(!parsed.success){hiddenDamaged++;return [];}return [completedSummary(parsed.data)];});return {notes:notes.sort((a,b)=>b.savedAt.localeCompare(a.savedAt)),hiddenDamaged};};});},
 async ensureDraft(value:PersonalStored){const draft=personalStoredSchema.parse(value);return transaction("readwrite",(tx,fail)=>{const store=tx.objectStore("drafts"),req=store.get(draft.id);let saved={...draft,revision:1};req.onsuccess=()=>{try{if(req.result)saved=personalStoredSchema.parse(req.result);else store.add(saved);tx.objectStore("settings").put({id:"active",value:saved.id});}catch(e){fail(e instanceof Error?e:new Error("新草稿创建失败。"));}};return()=>saved;});},
 async readWorkspace(){
  return transaction("readonly",tx=>{
   const summaries:PersonalSummary[]=[];
   let activeId:string|undefined,hiddenDamaged=0;
   const cursor=tx.objectStore("drafts").openCursor();
   cursor.onsuccess=()=>{
    const row=cursor.result;
    if(!row)return;
    const parsed=personalStoredSchema.safeParse(row.value);
    if(parsed.success)summaries.push(personalSummary(parsed.data));
    else if(typeof row.value?.id==="string")summaries.push({id:row.value.id,name:"无法读取的草稿",updatedAt:"",damaged:true});
    else hiddenDamaged++;
    row.continue();
   };
   const active=tx.objectStore("settings").get("active");
   active.onsuccess=()=>{activeId=active.result?.value;};
   // Discard each record's Blob handles after extracting text. Hydrate only the opened draft.
   return()=>({drafts:[] as unknown[],summaries,activeId,hiddenDamaged});
  });
 },
 async getDraft(id:string){return transaction("readonly",tx=>{let value:unknown;const r=tx.objectStore("drafts").get(id);r.onsuccess=()=>{value=r.result;};return()=>personalStoredSchema.parse(value);});},
 async writeDraft(value:PersonalStored,expected:number|null,active=true){const draft=personalStoredSchema.parse(value);return transaction("readwrite",(tx,fail)=>{const store=tx.objectStore("drafts"),req=store.get(draft.id),saved={...draft,revision:(expected??0)+1};req.onsuccess=()=>{const old=req.result;if(expected===null?old!==undefined:!old||old.revision!==expected||old.version!==1){fail(new Error("这份个人草稿已在其他页面修改或删除，未覆盖原内容。"));return;}store.put(saved);if(active)tx.objectStore("settings").put({id:"active",value:draft.id});};return()=>saved;});},
 async preserveSnapshot(value:PersonalStored){const copy=copyPersonalDraft(value);copy.name=`${value.name.slice(0,68)}（重新生成前）`;return this.writeDraft(copy,null,false);},
 async setActive(id:string){return transaction("readwrite",tx=>{tx.objectStore("settings").put({id:"active",value:id});return()=>undefined;});},
 async deleteDraft(id:string){return transaction("readwrite",tx=>{tx.objectStore("drafts").delete(id);const settings=tx.objectStore("settings"),r=settings.get("active");r.onsuccess=()=>{if(r.result?.value===id)settings.delete("active");};return()=>undefined;});},
};

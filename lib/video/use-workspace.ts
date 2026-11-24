"use client";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { cloneVideoDraft,newVideoDraft,videoDraftSchema,videoFromHotspot,videoSummarySchema,summarizeVideoDraft,type VideoDraft,type VideoDraftSummary } from "./drafts";
import { videoStore } from "./store";
import { useCloud } from "@/components/cloud/context";
import { isCorruptCloudRecord,makeCloudVideoStore } from "../cloud/store";
import { storageMessage } from "../local-store";
import type { HotspotTransfer } from "../hotspot-transfer";

export function useVideoWorkspace(){
 const {cloud,user}=useCloud();
 const store=useMemo(()=>cloud?makeCloudVideoStore(user?.id??""):videoStore,[cloud,user?.id]);
 const savedLabel=cloud?"已保存到云端":"已保存到本机";
 const [draft,setDraft]=useState<VideoDraft|null>(null),[rows,setRows]=useState<VideoDraftSummary[]>([]),[status,setStatus]=useState("读取中"),[error,setError]=useState(""),[warning,setWarning]=useState(""),[switching,setSwitching]=useState(false);
 const latest=useRef<VideoDraft|null>(null),lastSaved=useRef<VideoDraft|null>(null),revision=useRef<number|null>(null),ready=useRef(false),lock=useRef(false),queue=useRef<Promise<unknown>>(Promise.resolve());
 const activate=useCallback((next:VideoDraft,rev:number|null)=>{latest.current=next;lastSaved.current=next;revision.current=rev;setDraft(next);setStatus(rev===null?"尚未保存":savedLabel);setError("");},[savedLabel]);
 const addRow=useCallback((next:VideoDraft)=>setRows(old=>[summarizeVideoDraft(next),...old.filter(row=>row.id!==next.id)].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))),[]);
 useEffect(()=>{let cancelled=false,initialized=false;void(async()=>{
  try {
   const data=await store.read();if(cancelled)return;
   let selected:VideoDraft|undefined,damaged="hiddenDamaged" in data&&typeof data.hiddenDamaged==="number"?data.hiddenDamaged:0;
   let summaries:VideoDraftSummary[]=[];
   if("summaries" in data&&Array.isArray(data.summaries)&&"getDraft" in store){
    for(const row of data.summaries){const parsed=videoSummarySchema.safeParse(row);if(parsed.success){summaries.push(parsed.data);if(parsed.data.damaged)damaged++;}else damaged++;}
    summaries.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    const candidates=summaries.filter(row=>!row.damaged).sort((a,b)=>a.id===data.activeId?-1:b.id===data.activeId?1:b.updatedAt.localeCompare(a.updatedAt));
    for(const row of candidates){try{selected=await store.getDraft(row.id);break;}catch(err){if(!isCorruptCloudRecord(err))throw err;row.damaged=true;damaged++;}}
   } else {
    const parsed=data.drafts.map(row=>videoDraftSchema.safeParse(row));const valid=parsed.flatMap(row=>row.success?[row.data]:[]).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    damaged+=parsed.filter(row=>!row.success).length;summaries=valid.map(summarizeVideoDraft);selected=valid.find(row=>row.id===data.activeId)??valid[0];
   }
   if(cancelled)return;setRows(summaries);if(damaged)setWarning(`${damaged} 条视频记录损坏或版本不兼容，已跳过，旧数据未覆盖。`);
   activate(selected??newVideoDraft(),selected?.revision??null);initialized=true;
  }catch(err){if(cancelled)return;if(!cloud){activate(newVideoDraft(),null);initialized=true;}setError(storageMessage(err));setWarning("未能恢复视频草稿，旧记录未覆盖。当前内容不会覆盖旧稿。");setStatus("保存失败");}
  finally{if(!cancelled&&initialized)ready.current=true;}
 })();return()=>{cancelled=true;ready.current=false;};},[activate,store,cloud]);
 const update=useCallback((change:(old:VideoDraft)=>VideoDraft)=>{if(!ready.current||!latest.current||lock.current)return;const next=change(latest.current);if(next===latest.current)return;const stamped={...next,updatedAt:new Date().toISOString()};latest.current=stamped;setDraft(stamped);setStatus("等待自动保存…");},[]);
 const save=useCallback(async():Promise<boolean>=>{const operation=queue.current.catch(()=>undefined).then(async()=>{const current=latest.current;if(!ready.current||!current)return false;if(current===lastSaved.current&&revision.current!==null)return true;if(!Number.isInteger(current.brief.duration)||current.brief.duration<10||current.brief.duration>600){setError("请填写 10～600 秒的整数时长，再保存视频草稿。当前内容仍保留。请重试。");setStatus("保存失败");return false;}setStatus("保存中…");try{const stored=await store.write(current,revision.current);revision.current=stored.revision;lastSaved.current=current;addRow(stored);setError("");setStatus(latest.current===current?savedLabel:"等待自动保存…");return true;}catch(err){setError(storageMessage(err));setStatus("保存失败");return false;}});queue.current=operation;return operation;},[addRow,savedLabel,store]);
 useEffect(()=>{if(!draft||!ready.current||draft===lastSaved.current)return;const timer=setTimeout(()=>void save(),1000);return()=>clearTimeout(timer);},[draft,save]);
 useEffect(()=>{const hide=()=>{if(document.visibilityState==="hidden"&&latest.current!==lastSaved.current)void save();};const unload=(event:BeforeUnloadEvent)=>{if(latest.current!==lastSaved.current){event.preventDefault();event.returnValue="";}};document.addEventListener("visibilitychange",hide);window.addEventListener("beforeunload",unload);return()=>{document.removeEventListener("visibilitychange",hide);window.removeEventListener("beforeunload",unload);};},[save]);
 async function change(operation:()=>Promise<void>){if(lock.current||!ready.current)return false;lock.current=true;setSwitching(true);try{if(!await save())return false;await operation();return true;}catch(err){setError(storageMessage(err));setStatus("保存失败");return false;}finally{lock.current=false;setSwitching(false);}}
 async function persistNew(next:VideoDraft){const stored=await store.write(next,null);addRow(stored);activate(stored,stored.revision);}
 async function getRow(id:string){if("getDraft" in store)return store.getDraft(id);const all=await store.read();const found=all.drafts.find(row=>typeof row==="object"&&row!==null&&"id" in row&&row.id===id);return videoDraftSchema.parse(found);}
 return {draft,rows,status,error,warning,switching,update,save,cloud,
  latest:()=>latest.current,
  create:()=>change(()=>persistNew(newVideoDraft())),
  createFromHotspot:(input:HotspotTransfer)=>change(()=>persistNew(videoFromHotspot(input))),
  navigateSafely:(navigate:()=>void)=>change(async()=>{navigate();}),
  open:(id:string)=>change(async()=>{const next=await getRow(id);await store.setActive(id);activate(next,next.revision);}),
  duplicate:(id:string)=>change(async()=>persistNew(cloneVideoDraft(await getRow(id)))),
  preserve:()=>change(async()=>{if(!latest.current)return;const stored=await store.write(cloneVideoDraft(latest.current),null,false);addRow(stored);}),
  rename:(id:string,name:string)=>change(async()=>{if(!name.trim())throw new Error("请填写草稿名称。");const row=await getRow(id);const saved=await store.write({...row,name:name.trim().slice(0,80),updatedAt:new Date().toISOString()},row.revision,false);addRow(saved);if(latest.current?.id===id)activate({...latest.current,name:saved.name,updatedAt:saved.updatedAt},saved.revision);}),
  remove:(id:string)=>change(async()=>{await store.remove(id);setRows(old=>old.filter(row=>row.id!==id));if(latest.current?.id===id)activate(newVideoDraft(),null);}),
 };
}
export type VideoWorkspace=ReturnType<typeof useVideoWorkspace>;

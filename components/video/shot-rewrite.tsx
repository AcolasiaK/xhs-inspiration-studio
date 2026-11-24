"use client";
import {AiUsageStatus,useAiTask} from "../ai/usage-status";
import {useEffect,useRef,useState} from "react";
import {RewriteModal,RewriteSettings} from "@/components/rewrite/modal";
import {requestVideo} from "@/lib/video/client";
import {videoFingerprint,type VideoDraft} from "@/lib/video/drafts";
import {formatShot,validateShot,type Shot} from "@/lib/video/schema";
import type {PublicConfig} from "@/lib/types";

export function ShotRewrite({draft,targetId,config,timeoutMs,stale,onClose,onApply}:{draft:VideoDraft;targetId:string;config:PublicConfig;timeoutMs:number;stale:boolean;onClose:()=>void;onApply:(fingerprint:string,shot:Shot)=>Promise<boolean>}){
  const aiTask=useAiTask();
  void config; // Retain the existing component prop contract during migration.
  const [snapshot]=useState(()=>({generation:draft[draft.phase]!,fingerprint:videoFingerprint(draft),targetId}));
  const [instruction,setInstruction]=useState(""),[output,setOutput]=useState<Shot|null>(null),[busy,setBusy]=useState(false),[applying,setApplying]=useState(false),[error,setError]=useState("");
  const controller=useRef<AbortController|null>(null),working=useRef(false),mounted=useRef(true);
  const {input,result}=snapshot.generation,index=result.shots.findIndex(s=>s.shotId===snapshot.targetId),original=result.shots[index];
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
  function close(){controller.current?.abort();onClose();}
  async function start(){
    if(working.current)return;
    working.current=true;setBusy(true);setError("");setOutput(null);const abort=new AbortController();controller.current=abort;const ai=aiTask.start();
    try{const data=await requestVideo({action:"rewrite",input,current:result,targetId:snapshot.targetId,instruction},"",abort,timeoutMs,ai.id);if(!mounted.current||abort.signal.aborted)return;if(!data.shot)throw new Error("镜头结果不完整，原内容仍保留。");setOutput(data.shot);}
    catch(e){if(mounted.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:"重写失败，原镜头仍保留。");}
    finally{working.current=false;controller.current=null;if(mounted.current){setBusy(false);aiTask.finish();}}
  }
  async function accept(){
    if(!output||working.current)return;working.current=true;setApplying(true);
    try{const shot=validateShot(input,result,snapshot.targetId,output);if(!await onApply(snapshot.fingerprint,shot)){setError("草稿或镜头已变化，未覆盖最新内容。请关闭后重新发起。");return;}onClose();}
    catch(e){setError(e instanceof Error?e.message:"采用失败，原内容仍保留。");}
    finally{working.current=false;if(mounted.current)setApplying(false);}
  }
  return <RewriteModal label="单个镜头" result={!!output} directionLabel="按镜头要求" busy={busy} applying={applying} error={error} copyText={output?formatShot(output,index):""} onClose={close} onStart={()=>void start()} onEdit={()=>{setOutput(null);setError("");}} onApply={()=>void accept()} onCopyError={setError}
    warning={stale?"输入已改变；本次仍依据原方案的要求与实际素材。":null}
    settings={<RewriteSettings instruction={instruction} onInstruction={setInstruction} maxLength={1000} busy={busy} basis={<>
      <AiUsageStatus task={aiTask}/><p>镜头 {index+1} · 成片 {original.start}～{original.end} 秒，保持镜头编号与时间范围。</p><p>{"使用当前配置的 API 用量。"}</p>
      <p>主题：{input.brief.topic}；风格：{input.brief.style} {input.brief.customStyle}</p><p>{input.phase==="after"?`实际素材：${input.footage.materials}`:`拍摄场景：${input.brief.location||"未指定"}`}</p>
    </>}/>}
  >{output&&<p className="rw-text">{formatShot(output,index)}</p>}</RewriteModal>;
}

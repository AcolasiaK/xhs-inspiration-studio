"use client";

import { ArrowLeft, Check, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AiUsageStatus, useAiTask } from "@/components/ai/usage-status";
import { ImageCapabilityRecovery } from "@/components/ai/image-capability-recovery";
import { PersonalActionDock } from "./action-dock";
import { SceneHeader } from "@/components/scene-header";
import { AppShell } from "@/components/app-shell";
import { ImageUploader } from "@/components/image-uploader";
import { PersonalNoteEditor, PersonalAssist, type PersonalResultProps } from "./note-workspace";
import { VideoDialog } from "@/components/video/dialog";
import { prepareImage } from "@/lib/images";
import { MAX_IMAGES } from "@/lib/constants";
import { generationMetaSchema } from "@/lib/schema";
import { travelResearchSchema, type TravelResearch } from "@/lib/travel-research";
import { cloudFetch } from "@/lib/cloud/client";
import { applyPersonalResearchRefresh, personalResearchRetry, personalResultResearchChanged } from "@/lib/personal/research-refresh";
import { safePersonalSearchQuery } from "@/lib/personal/search-query";
import type { PublicConfig, StudioImage } from "@/lib/types";
import { personalRequest, PersonalRequestError, type PersonalRequestPhase } from "@/lib/personal/client";
import { personalTaskPhaseMessage, type PersonalTaskFeedback, type PersonalTaskStage } from "@/lib/personal/feedback";
import { parsePersonalCustomLength } from "@/lib/personal/body-length";
import type { PersonalInput } from "@/lib/personal/schema";
import type { PersonalDraft } from "@/lib/personal/drafts";
import { isPersonalPromptStale, samePersonalStyleBasis, personalInputKey, personalResultFingerprint, validatePersonalClientResult } from "@/lib/personal/flow";
import { usePersonalWorkspace } from "@/lib/personal/use-workspace";
import { PersonalDrawer } from "./drawer";
import { PersonalRewrite, type PersonalChoice } from "./rewrite";
import { ResearchInfo } from "./research-info";
import { HotspotReference } from "./hotspot-reference";
import { PersonalTaskFeedbackCard } from "./task-feedback";
import { WorkflowNav } from "./workflow-nav";
import { WorkflowStep } from "./workflow-step";
import { PromptDirection } from "./prompt-direction";
import { personalStyleChanges, personalStepAfterSuccess, initialPersonalStep, personalDirectionPreview, personalPromptSummary, type PersonalStep } from "@/lib/personal/presentation";
import { rewriteLabels } from "@/components/rewrite/result";
import { usePersonalStyles } from "@/lib/personal/style-client";
import { builtinRuleSnapshot, isBuiltinStyle } from "@/lib/personal/style-rules";
import { PersonalStyleChoices } from "./style-picker";
import { PersonalPolishControls } from "./polish";
import { ruleSnapshotSchema } from "@/lib/personal/style-rules";
import "./studio.css";
import "./style-manager.css";
import "./research-info.css";
import "./task-feedback.css";
import "./workflow.css";

const aspects: {key:PersonalInput["referenceAspects"][number];label:string}[]=[{key:"tone",label:"语气"},{key:"structure",label:"正文结构"},{key:"opening",label:"开头"},{key:"rhythm",label:"句子和段落节奏"},{key:"imageCopy",label:"图上文字"}];
function researchWarning(research:TravelResearch|null){return research&&research.status!=="disabled"&&(research.status!=="success"||!research.sources.length||research.potentialConflict)?research.notice||"本次没有取得可核实资料，可关闭检索或无资料继续。":undefined;}
function showSection(target:PersonalStep,focus:boolean){
  const element=document.getElementById(target==="result"?"personal-result":`personal-${target}`);
  if(!element)return;
  if(focus)element.focus({preventScroll:true});
  const nav=document.querySelector<HTMLElement>(".personal-flow-nav");
  const offset=nav?nav.getBoundingClientRect().height+(parseFloat(getComputedStyle(nav).top)||0)+12:20;
  const main=element.closest<HTMLElement>(".workbench-main");
  if(main)main.scrollTo({top:Math.max(0,main.scrollTop+element.getBoundingClientRect().top-main.getBoundingClientRect().top-offset),behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
}

export function PersonalStudio({config}:{config:PublicConfig}){
  void config; // Retain the existing component prop contract during migration.
  const router=useRouter();
  const aiTask=useAiTask();
  const [completedNotice,setCompletedNotice]=useState<string|null>(null),[completing,setCompleting]=useState(false);
  useEffect(()=>{
    if(!completedNotice)return;
    const timer=window.setTimeout(()=>setCompletedNotice(null),3000);
    return ()=>window.clearTimeout(timer);
  },[completedNotice]);
  const completingRef=useRef(false);
  const workspace=usePersonalWorkspace();
  const styleLibrary = usePersonalStyles();
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [task,setTask]=useState<PersonalTaskFeedback|null>(null);
  const [refreshState,setRefreshState]=useState<{draftId:string;pending:boolean;message:string}|null>(null);
  const [refreshPlace,setRefreshPlace]=useState<{draftId:string;value:string}|null>(null);
  const refreshRequest=useRef<{draftId:string;controller:AbortController}|null>(null);
  const [canCancel,setCanCancel]=useState(false);
  const [directionBases,setDirectionBases]=useState<Record<string,string>>({});
  const [steps,setSteps]=useState<Record<string,PersonalStep>>({});
  const [focusTarget,setFocusTarget]=useState<{draftId:string;step:PersonalStep;focus:boolean}|null>(null);
  useEffect(()=>{if(!focusTarget||focusTarget.draftId!==workspace.draft?.id)return;const frame=requestAnimationFrame(()=>showSection(focusTarget.step,focusTarget.focus));return()=>cancelAnimationFrame(frame);},[focusTarget,workspace.draft?.id]);
  const [drawer,setDrawer]=useState(false),[choice,setChoice]=useState<PersonalChoice|null>(null),[decision,setDecision]=useState<"stale"|"regenerate"|null>(null);
  const [customLengthEntry,setCustomLengthEntry]=useState<{draftId:string;value:string}|null>(null);
  const working=useRef(false),abort=useRef<AbortController|null>(null),mounted=useRef(true),latest=useRef<PersonalDraft|null>(null);
  useEffect(()=>{latest.current=workspace.draft;},[workspace.draft]);
  useEffect(()=>{
    const request=refreshRequest.current;
    if(request && (workspace.switching || request.draftId!==workspace.draft?.id)) request.controller.abort();
  },[workspace.draft?.id,workspace.switching]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;abort.current?.abort();};},[]);
  const draft=workspace.draft;
  if(!draft)return <AppShell disabled><main className="page-main"><h1>个人创作</h1><p role="status">{workspace.storageError?"个人草稿暂时无法读取。":"正在读取个人创作草稿…"}</p>{workspace.storageError&&<><p className="storage-error">{workspace.storageError} 原有记录没有覆盖。</p><button type="button" className="secondary-button" onClick={()=>window.location.reload()}>重新加载页面</button></>}</main></AppShell>;
  const researchChanged=personalResultResearchChanged(draft);
  const stale=isPersonalPromptStale(draft), resultStale=Boolean(draft.generatedInput&&(JSON.stringify(draft.generatedInput.input)!==JSON.stringify(draft.input)||JSON.stringify(draft.generatedInput.imageIds)!==JSON.stringify(draft.images.map(i=>i.id))||draft.generatedInput.confirmedPrompt!==draft.prompt||researchChanged));
  const disabled=busy||workspace.switching;
  const savedRetry=personalResearchRetry(draft);
  const retryPlace=savedRetry.query || (refreshPlace?.draftId===draft.id ? refreshPlace.value : "");
  const refreshFeedback=refreshState?.draftId===draft.id ? refreshState : null;
  const styleChanges=personalStyleChanges(draft);
  const activeTask=task?.draftId===draft.id?task:null;
  const selected = draft.input.styles.length === 1 ? draft.input.styles[0] : undefined;
  const styleRecord = styleLibrary.data?.styles.find(style => style.id === selected);
  const activeRules = styleRecord?.versions.find(v => v.snapshot.versionId === styleRecord.activeVersionId)?.snapshot;
  const pinned = draft.input.ruleSnapshot ?? draft.promptInput?.ruleSnapshot ?? draft.generatedInput?.input.ruleSnapshot
    ?? (draft.promptInput && selected && isBuiltinStyle(selected) ? builtinRuleSnapshot(selected) : undefined);
  const newerRules = pinned && pinned.styleId === selected && activeRules?.versionId !== pinned.versionId ? activeRules : undefined;
  const currentStep=steps[draft.id]??initialPersonalStep;
  function selectStep(step:PersonalStep,focus=true){setSteps(old=>({...old,[draft!.id]:step}));setFocusTarget({draftId:draft!.id,step,focus});}
  function openStep(step:PersonalStep){selectStep(step);}
  function advance(stage:"prompt"|"note",draftId:string){const step=personalStepAfterSuccess(stage);setSteps(old=>({...old,[draftId]:step}));setFocusTarget({draftId,step,focus:true});}
  const direction=personalDirectionPreview(draft.prompt,draft.input);
  const directionBasis=directionBases[draft.id]??draft.generatedInput?.confirmedPrompt;
  const directionPending=Boolean(direction.core&&draft.prompt!==directionBasis&&draft.prompt!==draft.generatedInput?.confirmedPrompt);
  function editPrompt(value:string){
    // An edited arrangement is explicit user input. Edits elsewhere cannot silently
    // certify an unchanged plan; an absent baseline after reload is also unverified.
    const previous=personalPromptSummary(draft!.prompt).core,next=personalPromptSummary(value).core;
    if(next&&next!==previous)setDirectionBases(old=>({...old,[draft!.id]:value}));
    workspace.update(old=>({...old,prompt:value}));
  }
  const promptConfirmed=Boolean(draft.generatedInput&&draft.generatedInput.confirmedPrompt===draft.prompt&&!researchChanged);
  const promptStatus=styleChanges.direction?"风格待更新":stale?"素材待确认":!draft.promptInput?"待生成":promptConfirmed?"已确认":"待确认";
  const inputStatus=activeTask?.stage==="prompt"&&activeTask.status!=="success"?{running:"处理中",error:"生成失败",cancelled:"已取消"}[activeTask.status]:stale?"已修改":draft.promptInput?"已完成":"待填写";
  const directionStatus=activeTask?.stage==="note"&&activeTask.status!=="success"?{running:"生成笔记中",error:"生成失败",cancelled:"已取消"}[activeTask.status]:promptStatus;
  const resultStatus=resultStale?"保留上次笔记":draft.generation?"已生成":"待生成";
  const customLengthText=customLengthEntry?.draftId===draft.id?customLengthEntry.value:String(draft.input.customLength);
  const customLengthInvalid=draft.input.bodyLength==="custom"&&parsePersonalCustomLength(customLengthText)===null;
  function input<K extends keyof PersonalInput>(key:K,value:PersonalInput[K]){workspace.update(old=>({...old,input:{...old.input,[key]:value}}));}
  function taskPhase(stage:PersonalTaskStage,snapshot:PersonalDraft,phase:PersonalRequestPhase){if(mounted.current)setTask({draftId:snapshot.id,stage,status:"running",detail:personalTaskPhaseMessage(stage,phase,snapshot.images.length>0,snapshot.input.search)});}
  function taskFailure(stage:PersonalTaskStage,reason:unknown,controller?:AbortController,draftId=latest.current?.id){
    if(!mounted.current||!draftId)return;
    const cancelled=controller?.signal.aborted||(reason instanceof PersonalRequestError&&reason.code==="CANCELLED");
    const message=typeof reason==="string"?reason:reason instanceof Error?reason.message:"暂时无法完成，请稍后重试。";
    const needsImageTest = !cancelled && stage === "note" && reason instanceof PersonalRequestError && ["VISION_UNVERIFIED", "VISION_UNSUPPORTED"].includes(reason.code);
    setTask({draftId,stage,needsImageTest,status:cancelled?"cancelled":"error",detail:cancelled?"本次操作已取消，输入和已有内容保留。可以修改要求后再试。":/保留|未覆盖|不会覆盖/.test(message)?message:`${message} 输入和已有内容已保留，可修改后重试。`});
  }
  function cancelTask(){abort.current?.abort();setTask(old=>old?.status==="running"?{...old,detail:"正在取消，请稍候；输入和已有内容会保留。"}:old);}
  async function addImages(files:File[]){
    if(working.current||!files.length)return;const current=latest.current;if(!current)return;
    if(current.images.length+files.length>MAX_IMAGES){setError("最多上传 9 张图片。");return;}
    working.current=true;setBusy(true);const loaded:StudioImage[]=[];
    try{for(const file of files)loaded.push(await prepareImage(file));let accepted=false;workspace.update(old=>{if(old.id!==current.id||old.images.length+loaded.length>MAX_IMAGES)return old;accepted=true;return {...old,images:[...old.images,...loaded]};});if(!accepted)throw new Error("草稿已改变，图片未添加。请重试。");setError("");}
    catch(e){loaded.forEach(i=>URL.revokeObjectURL(i.preview));setError(e instanceof Error?e.message:"图片无法读取。");}finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  function moveImage(index:number,delta:number){workspace.update(old=>{const images=[...old.images],to=index+delta;if(to<0||to>=images.length)return old;[images[index],images[to]]=[images[to],images[index]];return {...old,images};});}
  async function refreshResearch(){
    const snapshot=latest.current;
    if(!snapshot || workspace.cloud || workspace.switching || working.current) return;
    const {query,guideScope}=personalResearchRetry(snapshot);
    const place=query || safePersonalSearchQuery(refreshPlace?.draftId===snapshot.id ? refreshPlace.value : "");
    if(!place){
      setRefreshState({draftId:snapshot.id,pending:false,message:"请填写公开地点或景点名称，再重新检索。"});
      return;
    }
    const controller=new AbortController();
    const deadline=AbortSignal.timeout(100_000);
    const signal=AbortSignal.any([controller.signal,deadline]);
    refreshRequest.current={draftId:snapshot.id,controller};
    abort.current=controller;
    working.current=true;
    setBusy(true);
    setRefreshState({draftId:snapshot.id,pending:true,message:"正在用浏览器检索攻略…"});
    let message="此次检索未写入草稿。";
    try{
      const response=await cloudFetch("/api/travel-research",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({place,enabled:true,scope:"personal",guideScope}), signal,
      });
      const data=await response.json();
      signal.throwIfAborted();
      if(!response.ok) throw new Error(typeof data?.error?.message==="string" ? data.error.message : "检索暂时失败，请重试。");
      const parsed=travelResearchSchema.safeParse(data?.research);
      if(!parsed.success) throw new Error("未收到有效的攻略资料，原有来源已保留。");
      const research={...parsed.data,query:parsed.data.query || place,guideScope:parsed.data.guideScope ?? guideScope};
      let updatedPrompt:string|undefined;
      workspace.update(current=>{
        const applied=applyPersonalResearchRefresh(current,snapshot,research);
        message=applied.message;
        if(applied.draft.prompt!==current.prompt) updatedPrompt=applied.draft.prompt;
        return applied.draft;
      });
      if(updatedPrompt){
        const next=updatedPrompt;
        setDirectionBases(bases=>(bases[snapshot.id] ?? snapshot.generatedInput?.confirmedPrompt)===snapshot.prompt
          ? {...bases,[snapshot.id]:next} : bases);
      }
    }catch(reason){
      message=controller.signal.aborted ? "已取消攻略检索。" : deadline.aborted ? "攻略检索超时，可以重试。" :
        reason instanceof Error ? reason.message : "攻略检索暂时失败，可以重试。";
    }finally{
      working.current=false;
      abort.current=null;
      refreshRequest.current=null;
      if(mounted.current){
        setBusy(false);
        setRefreshState({draftId:snapshot.id,pending:false,message});
      }
    }
  }
  async function createPrompt(){
    if(working.current||!mounted.current)return;const snap=latest.current;if(!snap)return;
    if(customLengthInvalid){taskFailure("prompt","请填写 100～1200 之间的整数作为自定义字数。");return;}
    if(snap.input.styles.length!==1){taskFailure("prompt","请明确选择一种写作风格；旧内容和原生成依据保留。");return;}
    if(!snap.input.experience.trim()){taskFailure("prompt","请先写下你的经历、想法或感受。");return;}
    if(snap.prompt&&!window.confirm("重新生成会替换当前提示词，已生成的笔记不会被覆盖。继续吗？"))return;
    working.current=true;setBusy(true);setError("");setNotice("");taskPhase("prompt",snap,"preparing");const controller=new AbortController();abort.current=controller;setCanCancel(true);const key=personalInputKey(snap);const ai=aiTask.start();
    try{const data=await personalRequest({action:"prompt",input:snap.input,imageIds:snap.images.map(i=>i.id)},snap.images,controller,{source:ai.id,onPhase:phase=>taskPhase("prompt",snap,phase)});
      if(typeof data?.prompt!=="string"||!data.prompt.trim()||data.prompt.length>12000)throw new Error("提示词不完整，已有内容仍保留。");
      const boundInput={...structuredClone(snap.input),ruleSnapshot:ruleSnapshotSchema.parse(data.ruleSnapshot)};
      const research=data.research==null?null:travelResearchSchema.parse(data.research);let applied=false;
      workspace.update(old=>{if(old.id!==snap.id||personalInputKey(old)!==key)return old;applied=true;return {...old,input:boundInput,prompt:data.prompt,promptInput:structuredClone(boundInput),promptImageIds:snap.images.map(i=>i.id),promptResearch:research};});
      if(!applied)throw new Error("草稿或输入已改变，未采用过期提示词。");if(mounted.current){setDirectionBases(old=>({...old,[snap.id]:data.prompt}));setTask({draftId:snap.id,stage:"prompt",status:"success",detail:"创作方向已准备好，请查看并确认。",researchWarning:researchWarning(research)});advance("prompt",snap.id);}
    }catch(e){taskFailure("prompt",e,controller,snap.id);}finally{working.current=false;abort.current=null;if(mounted.current){setBusy(false);setCanCancel(false);aiTask.finish();}}
  }
  async function performGenerate(){
    if(working.current||!mounted.current)return;const snap=latest.current;if(!snap)return;
    if(customLengthInvalid){taskFailure("note","请填写 100～1200 之间的整数作为自定义字数。");return;}
    if(!snap.input.experience.trim()||!snap.prompt.trim()){taskFailure("note","请先填写经历并生成或填写创作提示词。");return;}
    working.current=true;setBusy(true);setError("");setNotice("");taskPhase("note",snap,"preparing");const controller=new AbortController();abort.current=controller;setCanCancel(true);const key=personalInputKey(snap),prompt=snap.prompt,ids=snap.images.map(i=>i.id),oldResult=JSON.stringify(snap.generation?.result);const ai=aiTask.start();
    try{const data=await personalRequest({action:"generate",input:snap.input,imageIds:ids,confirmedPrompt:prompt,...(snap.promptResearch?{research:snap.promptResearch}:{})},snap.images,controller,{source:ai.id,onPhase:phase=>taskPhase("note",snap,phase)});
      const boundInput={...structuredClone(snap.input),ruleSnapshot:ruleSnapshotSchema.parse(data.ruleSnapshot)};
      const result=validatePersonalClientResult(data?.result,ids,boundInput),meta=generationMetaSchema.parse({...data?.meta,...(ai.name&&!ai.issue?{aiSelection:{id:ai.id,name:ai.name,model:ai.model,revision:ai.revision}}:{})}),research=data?.research==null?snap.promptResearch:travelResearchSchema.parse(data.research);let applied=false;
      workspace.update(old=>{if(old.id!==snap.id||personalInputKey(old)!==key||old.prompt!==prompt||JSON.stringify(old.generation?.result)!==oldResult)return old;applied=true;return {...old,input:boundInput,promptInput:{...old.promptInput!,ruleSnapshot:boundInput.ruleSnapshot},generation:{result,mode:"live",imageIds:ids,meta,...(research?{research}:{})},resultImages:[...snap.images],generatedInput:{input:structuredClone(boundInput),confirmedPrompt:prompt,research,imageIds:ids},hasUserEdits:false,polishUndo:undefined};});
      if(!applied)throw new Error("草稿或内容已改变，未覆盖最新编辑。");if(mounted.current){setTask({draftId:snap.id,stage:"note",status:"success",detail:`5 个标题、正文和 10 个话题已生成${ids.length?`，含 ${ids.length} 张图片配文`:""}。在笔记结果区查看、编辑和复制。`,researchWarning:researchWarning(research)});advance("note",snap.id);}
    }catch(e){taskFailure("note",e,controller,snap.id);}finally{working.current=false;abort.current=null;if(mounted.current){setBusy(false);setCanCancel(false);aiTask.finish();}}
  }
  function requestGenerate(staleApproved=false){const current=latest.current;if(disabled||working.current||!current)return;if(customLengthInvalid){taskFailure("note","请填写 100～1200 之间的整数作为自定义字数。");return;}if(!current.promptInput||!current.prompt.trim()){taskFailure("note","请先生成并确认创作提示词。");return;}if(!samePersonalStyleBasis(current.input,current.promptInput)){taskFailure("note","风格或规则版本已改变。请重新生成并确认创作提示词，再生成笔记；旧内容保留。");return;}if(isPersonalPromptStale(current)&&!staleApproved){setDecision("stale");return;}if(current.generation&&current.hasUserEdits){setDecision("regenerate");return;}void performGenerate();}
  async function chooseRegenerate(preserve:boolean){if(working.current)return;working.current=true;setBusy(true);setDecision(null);let saved=true;try{if(preserve){setTask({draftId:draft!.id,stage:"note",status:"running",detail:"正在保存独立副本，保存成功后才开始生成。"});saved=await workspace.preserveCurrent();}}catch{saved=false;}finally{working.current=false;if(mounted.current)setBusy(false);}if(!mounted.current)return;if(!saved){taskFailure("note","未能保存副本，本次没有生成，原内容仍保留。");return;}await performGenerate();}
  const status={loading:"正在读取",idle:"尚未保存",pending:"等待保存",saving:"保存中",saved:workspace.cloud?"已保存到账号":"已保存到本机",error:"保存失败"}[workspace.saveStatus];
  const taskCard=activeTask?(activeTask.status==="success"?<p className="personal-success-inline" role="status">✓ {activeTask.stage==="prompt"?"创作提示词已生成，请确认方向后继续。":"笔记已生成，可以编辑和复制。"}</p>:<PersonalTaskFeedbackCard feedback={activeTask} recovery={activeTask.needsImageTest ? <ImageCapabilityRecovery key={aiTask.namespace} disabled={disabled} onRetry={()=>requestGenerate()}/> : undefined} onCancel={canCancel?cancelTask:undefined} onRetry={()=>{if(activeTask.stage==="prompt")void createPrompt();else requestGenerate();}} onView={()=>openStep(activeTask.stage==="prompt"?"prompt":"result")} disabled={workspace.switching||(busy&&activeTask.status!=="running")}/>):null;
  async function finishNote(){if(disabled||working.current||completingRef.current)return;if(customLengthInvalid){setError("请先填写有效的自定义字数，以便下一篇沿用。");return;}if(draft!.input.styles.length!==1&&!window.confirm("旧笔记将完整保存。下一篇采用新草稿默认的日常分享，你可再明确选择其他风格；不会取旧组合中的第一个。继续吗？"))return;completingRef.current=true;setCompleting(true);try{const id=await workspace.finishCurrent();if(id){setError("");setNotice("");setTask(null);setChoice(null);setDecision(null);setCustomLengthEntry(null);setCompletedNotice(id);setFocusTarget(null);document.querySelector(".personal-main")?.scrollTo({top:0,behavior:"smooth"});}}finally{completingRef.current=false;if(mounted.current)setCompleting(false);}}
  const resultProps:PersonalResultProps={generation:draft.generation,images:draft.resultImages,busy:disabled,stale:resultStale&&!styleChanges.result,onComplete:()=>void finishNote(),completing,
    researchControl:draft.generatedInput?.research?<ResearchInfo research={draft.generatedInput.research} title="这篇笔记的参考来源（不包含在正文中）"/>:undefined,
    onChange:result=>workspace.update(old=>({...old,hasUserEdits:true,generation:old.generation?{...old.generation,result}:null})),
    onRegenerate:()=>{openStep("prompt");requestGenerate();},onRewrite:()=>setChoice({target:"body"}),onPartial:setChoice,onError:setError};
  return <AppShell disabled={disabled} navigateSafely={workspace.navigateSafely}><div className="studio-shell personal-studio workbench-page">
    <SceneHeader scene="writing" title="个人创作" description="">
      <div className="personal-toolbar-actions">
        <span className={`personal-save-status status-${workspace.saveStatus}`} role="status">{status}</span>
        {workspace.saveStatus==="error"&&<button type="button" onClick={()=>void workspace.save()}>重试保存</button>}
        <button type="button" disabled={disabled} onClick={()=>void workspace.create()}>新建草稿</button>
        <button type="button" disabled={disabled} onClick={()=>setDrawer(true)}>个人草稿箱</button>
        <button type="button" disabled={disabled} onClick={()=>void workspace.navigateSafely(()=>router.push("/personal/completed"))}>已完成笔记</button>
      </div>
    </SceneHeader>
    <main className="personal-main workbench-main">
      {(workspace.storageError||workspace.readWarning)&&<p className="storage-error" role="alert">{workspace.storageError||workspace.readWarning} 当前页面内容仍保留。</p>}
      {error&&<div className="storage-error" role="alert">{error}<button type="button" className="text-button" onClick={()=>setError("")}>关闭</button></div>}{notice&&<p className="video-success" role="status">{notice}</p>}
      {completedNotice&&<div className="toast personal-completion-toast" role="status"><Check size={15} aria-hidden="true"/>已保存到已完成笔记</div>}
      {newerRules && pinned && <div className="storage-warning" role="status">
        本稿使用「{pinned.content.name}」v{pinned.version}，当前启用 v{newerRules.version}。
        <button type="button" className="secondary-button" disabled={disabled} onClick={()=>{
          workspace.update(old=>({...old,input:{...old.input,styles:[newerRules.styleId],ruleSnapshot:newerRules}}));
          selectStep("input");
          setNotice("已切换风格，请重新生成创作方向。");
        }}>采用 v{newerRules.version}</button>
      </div>}
      <WorkflowNav active={currentStep} statuses={{input:inputStatus,prompt:directionStatus,result:resultStatus}}
        completed={{input:Boolean(draft.promptInput)&&!stale,prompt:promptConfirmed&&!stale,result:Boolean(draft.generation)&&!resultStale}}
        onSelect={step=>selectStep(step,false)} running={activeTask?.status==="running"?(activeTask.stage==="prompt"?"正在生成创作方向…":"正在生成笔记…"):undefined}
        onCancel={canCancel?cancelTask:undefined}/>
      <div className="personal-workspace">
        <WorkflowStep step="input" title="输入内容" subtitle="先把经历、想法或素材写下来，不必提前整理好。" status={inputStatus} active={currentStep==="input"} feedback={activeTask?.stage==="prompt"&&activeTask.status!=="success"?taskCard:null}>
<fieldset disabled={disabled} className="personal-fields"><div className="personal-story-fields">
<label className="field"><span className="personal-field-label">这次想分享什么？ <em>必填</em></span><textarea value={draft.input.experience} maxLength={4000} rows={4} onChange={e=>input("experience",e.target.value)} placeholder="今天做了什么、去了哪里，或者有什么想法？口语化地写就可以。"/></label>
<label className="field">主题或标题方向（选填）<input value={draft.input.topic} maxLength={100} onChange={e=>input("topic",e.target.value)} placeholder="例如：一次安静的周末"/></label>
<div className="personal-field-group">
<label className="field">最想表达的感受或观点（选填）<textarea value={draft.input.coreIntent} maxLength={600} rows={2} onChange={e=>input("coreIntent",e.target.value)} placeholder="例如：热闹中感受到自在；平常的一天也有值得留意的小事。也可以写完全不同的想法。"/></label>
</div>
<details className="personal-details personal-images"><summary>添加图片（选填，最多 9 张）<span className="personal-image-count">{draft.images.length>0?` · 已选 ${draft.images.length} 张`:""}</span></summary><ImageUploader images={draft.images} disabled={disabled} onAdd={files=>void addImages(files)} onRemove={id=>workspace.update(old=>({...old,images:old.images.filter(i=>i.id!==id)}))} onMove={moveImage}/></details></div><div className="personal-settings-fields"><h3>创作设置</h3><PersonalStyleChoices library={styleLibrary} showUpdate={false} input={draft.input} disabled={disabled} legacy={Boolean(draft.promptInput||draft.generatedInput)} onChange={snapshot=>workspace.update(old=>({...old,input:{...old.input,styles:[snapshot.styleId],ruleSnapshot:snapshot}}))} onManage={()=>void workspace.navigateSafely(()=>router.push("/personal/styles"))}/>
<div className="personal-field-group">
<fieldset className="personal-options" aria-label="内容真实性" aria-describedby="personal-truth-help"><legend>内容创作方式</legend><div className="personal-truth-grid"><label className={draft.input.truth==="truthful"?"is-selected":""}><input type="radio" name="personal-truth" aria-label="真实润色" checked={draft.input.truth==="truthful"} onChange={()=>input("truth","truthful")}/><span>真实润色</span></label><label className={draft.input.truth==="creative"?"is-selected":""}><input type="radio" name="personal-truth" aria-label="创意发挥" checked={draft.input.truth==="creative"} onChange={()=>input("truth","creative")}/><span>创意发挥</span></label></div></fieldset>
<p id="personal-truth-help" className="field-hint">{draft.input.truth==="truthful"?"按真实经历润色，不虚构事实。":"允许补充虚构情节，发布前请确认。"}</p>
</div>
<label className="field">正文长度<select value={draft.input.bodyLength} onChange={e=>input("bodyLength",e.target.value as PersonalInput["bodyLength"])}><option value="auto">自动：优先遵循文字里的长度要求</option><option value="short">短篇：约 150～250 字</option><option value="medium">中篇：约 350～550 字</option><option value="long">长篇：约 650～850 字</option><option value="custom">自定义目标字数</option></select></label>
{draft.input.bodyLength==="custom"&&<label className="field">自定义目标字数<input type="number" inputMode="numeric" min={100} max={1200} step={1} value={customLengthText} aria-invalid={customLengthInvalid} aria-describedby="personal-length-help" onChange={e=>{const value=e.target.value;setCustomLengthEntry({draftId:draft.id,value});const parsed=parsePersonalCustomLength(value);if(parsed!==null)input("customLength",parsed);}}/><span id="personal-length-help" className={customLengthInvalid?"personal-length-error":"personal-length-help"}>{customLengthInvalid?"请输入 100～1200 之间的整数；有效后才会保存。":"请输入 100～1200 之间的整数。"}</span></label>}
<details className="personal-details personal-advanced"><summary>更多创作设置<span className="personal-image-count">{draft.input.search?" · 已开启攻略检索":" · 补充要求与参考"}</span></summary><div className="personal-advanced-content"><details className="personal-details"><summary>补充要求与本次风格</summary><div className="personal-detail-fields">
<label className="field">本次风格补充（选填）<textarea value={draft.input.customStyle} maxLength={1000} rows={2} onChange={e=>input("customStyle",e.target.value)} placeholder="例如：口语自然，短段落"/></label>
<label className="field">其他补充要求（选填）<textarea value={draft.input.requirements} maxLength={2000} rows={3} onChange={e=>input("requirements",e.target.value)}/></label>
</div></details>
<details className="personal-help"><summary>写作设置说明</summary><p>输入简短也会按目标篇幅展开，字数可适度浮动。手动长度优先于旧提示词；自动模式遵循文字里的要求，未指定时约 350～550 字。</p><p>核心感受会在第二步提示词开头展示，可修改后确认。正文与重写沿用确认的方向。</p><p>旅行攻略默认侧重记录与感受；可在自定义风格中改为实用攻略或两者均衡。环游中国默认正文与话题合计约 1000 字内，手动长度优先。</p></details>
{draft.input.hotspotReference&&<HotspotReference value={draft.input.hotspotReference} disabled={disabled} onChange={value=>input("hotspotReference",value)} onRemove={()=>input("hotspotReference",null)}/>}
<details className="personal-details"><summary>参考文案（选填）</summary><label className="field">粘贴参考文字<textarea value={draft.input.referenceText} maxLength={6000} rows={4} onChange={e=>input("referenceText",e.target.value)} /></label><fieldset className="personal-options"><legend>希望参考的写法</legend><div className="personal-option-list">{aspects.map(a=><label key={a.key}><input type="checkbox" checked={draft.input.referenceAspects.includes(a.key)} onChange={e=>input("referenceAspects",e.target.checked?[...draft.input.referenceAspects,a.key]:draft.input.referenceAspects.filter(x=>x!==a.key))}/><span>{a.label}</span></label>)}</div></fieldset><p className="field-hint">仅参考写法，不照搬内容，也不把参考经历当成本次事实。</p></details>
<div className="personal-search">
  <label className="personal-check"><input type="checkbox" role="switch" checked={draft.input.search} onChange={e=>input("search",e.target.checked)}/><span>{workspace.cloud ? "联网检索创作背景" : "浏览器攻略检索"}</span></label>
  {draft.input.search && <p className="field-hint">{workspace.cloud ? "生成提示词时使用云端配置的搜索服务，可能使用服务额度。" : "生成提示词时，浏览器会按地点查找游览路线和交通资料。"}</p>}
  <details className="personal-help"><summary>检索方式</summary>
    <p>{workspace.cloud ? "云端使用单独配置的搜索服务。" : "使用本机浏览器搜索公开网页。遇到安全验证时，请在保留的标签页完成验证后重试。"}</p>
    {!workspace.cloud && <p>至少找到 3 个不同的可用页面，且资料覆盖游览顺序和交通后，就会结束检索。最多查 2 轮，共 90 秒，到时展示已找到的资料和还缺的信息。</p>}
    <p>只用公开关键词检索。来源可在提示词下方查看，票价、开放时间和班次请按出行日期核实。</p>
  </details>
  {draft.input.search && <label className="field">地点或检索关键词（选填）<input value={draft.input.searchPlace} maxLength={100} onChange={e=>input("searchPlace",e.target.value)} placeholder="留空自动提取；填写后优先使用"/></label>}
</div>
        </div></details></div></fieldset>
        <details className="storage-help"><summary>草稿存储</summary><p>{workspace.cloud?"个人草稿保存在当前账号下。":"草稿保存在当前浏览器；清除站点数据可能丢失。"}</p></details></WorkflowStep>
        <WorkflowStep step="prompt" title="确认创作方向" subtitle="先看写作安排，确认后再生成笔记。" status={directionStatus} active={currentStep==="prompt"} feedback={activeTask?.stage==="note"&&activeTask.status!=="success"?taskCard:null}>
          {!draft.promptInput?<div className="personal-pending-step"><p>还没有创作提示词。先填写经历与要求，再生成并确认方向。</p><button type="button" className="secondary-button" onClick={()=>openStep("input")}><ArrowLeft/>返回填写内容</button></div>:<>
          {styleChanges.direction?<p className="storage-warning" role="status">{styleChanges.direction}</p>:stale&&<p className="storage-warning" role="status">素材或图片已改变，请重新生成方向，或核对当前完整提示词后继续。</p>}
          {draft.promptInput.ruleSnapshot&&<p className="personal-rule-version">提示词规则：{draft.promptInput.ruleSnapshot.content.name} · v{draft.promptInput.ruleSnapshot.version}</p>}
          <PromptDirection key={`${draft.id}:direction`} prompt={draft.prompt} input={draft.input} pending={directionPending}/>
          <details className="personal-details personal-full-prompt" key={draft.id}><summary>查看 / 编辑完整提示词</summary><p className="personal-prompt-edit-help">生成笔记时使用以下完整文本；真实性和手选篇幅以当前设置为准。</p><label className="field"><span className="sr-only">创作提示词</span><textarea value={draft.prompt} disabled={disabled} maxLength={12000} rows={8} onChange={e=>editPrompt(e.target.value)}/></label></details>
          <ResearchInfo key={`${draft.id}:research`} research={draft.promptResearch} compact title="提示词的参考来源（不包含在正文中）"/>
          {!workspace.cloud && (draft.promptInput.search || (draft.promptResearch && draft.promptResearch.status!=="disabled")) && <div>
            {savedRetry.query
              ? <p className="field-hint">检索关键词：{savedRetry.query}</p>
              : <label className="field">检索地点或关键词<input value={retryPlace} maxLength={100} disabled={disabled} onChange={e=>setRefreshPlace({draftId:draft.id,value:e.target.value})} placeholder="例如：泉州 开元寺 西街"/></label>}
            <button type="button" className="secondary-button" disabled={disabled || !retryPlace.trim()} onClick={()=>void refreshResearch()}><RotateCcw aria-hidden="true"/>重新检索攻略</button>
            {refreshFeedback?.pending && <button type="button" className="text-button" onClick={()=>refreshRequest.current?.controller.abort()}>取消检索</button>}
            {refreshFeedback && <p className="field-hint" role="status">{refreshFeedback.message}</p>}
          </div>}
          </>}
        </WorkflowStep>
        <WorkflowStep step="result" title="查看与调整笔记" subtitle="内容可以直接修改，满意后复制或保存。" status={resultStatus} active={currentStep==="result"} feedback={activeTask?.stage==="note"&&activeTask.status==="success"?taskCard:null}
          actions={<PersonalPolishControls key={`polish:${draft.id}`} draft={draft} disabled={disabled} update={workspace.update}/> }>
          {styleChanges.result&&<p className="storage-warning" role="status">{styleChanges.result}</p>}
          {draft.generation?.mode==="live"&&<p className="personal-rule-version">生成时所选模型：{draft.generation.meta.aiSelection?`${draft.generation.meta.aiSelection.name} · ${draft.generation.meta.aiSelection.model}`:"历史记录未保存模型信息"}</p>}
          {draft.generatedInput?.input.ruleSnapshot&&<p className="personal-rule-version">原笔记规则：{draft.generatedInput.input.ruleSnapshot.content.name} · v{draft.generatedInput.input.ruleSnapshot.version}</p>}{draft.generatedInput?.rewrites?.length? <details className="personal-rule-version"><summary>局部重写依据（{draft.generatedInput.rewrites.length} 次）</summary>{draft.generatedInput.rewrites.map((entry,i)=><p key={i}>{new Date(entry.at).toLocaleString()} · {rewriteLabels[entry.target as keyof typeof rewriteLabels]||"局部重写"} · {entry.input.ruleSnapshot?.content.name} v{entry.input.ruleSnapshot?.version}</p>)}</details>:null}
          {draft.generation?<PersonalNoteEditor key={`note:${draft.id}`} {...resultProps} hideActions onBack={()=>openStep("prompt")}/>:<div className="personal-pending-step"><p>{draft.promptInput?"创作提示词已准备好，请先到第二步确认，再生成笔记。":"还没有笔记。请先填写内容、生成并确认创作提示词。"}</p><button type="button" className="secondary-button" onClick={()=>openStep(draft.promptInput?"prompt":"input")}><ArrowLeft/>{draft.promptInput?"前往确认创作方向":"返回填写内容"}</button></div>}
        </WorkflowStep>
      </div>
    </main>
    <PersonalActionDock>
      <AiUsageStatus task={aiTask}/>
      {currentStep==="input"&&<div className="personal-dock-buttons">
        <span className="personal-small-note personal-cost-note">使用 API 用量</span>
        <button className="generate-button" type="button" disabled={disabled} onClick={()=>void createPrompt()}>{activeTask?.stage==="prompt"&&activeTask.status==="running"?"正在生成创作方向…":"生成创作方向"}</button>
      </div>}
      {currentStep==="prompt"&&<div className="personal-dock-buttons">
        <button type="button" className="secondary-button" onClick={()=>openStep("input")}><ArrowLeft/>返回修改</button>
        {!styleChanges.direction&&draft.promptInput&&<button type="button" className="secondary-button" disabled={disabled} onClick={()=>void createPrompt()}><RotateCcw/>重新生成方向</button>}
        {styleChanges.direction||!draft.promptInput
          ? <button type="button" className="generate-button" disabled={disabled} onClick={()=>void createPrompt()}>更新创作方向</button>
          : <button type="button" className="generate-button" disabled={disabled||!draft.prompt.trim()} onClick={()=>requestGenerate()}>{activeTask?.stage==="note"&&activeTask.status==="running"?"正在生成笔记…":"确认并生成笔记"}</button>}
      </div>}
      {currentStep==="result"&&<PersonalAssist {...resultProps} section="actions" hideRecord regenerateLabel={styleChanges.direction?"更新创作方向":undefined} onBack={()=>openStep("prompt")} onRegenerate={()=>{openStep("prompt");if(!styleChanges.direction)requestGenerate();}}/>}
      {canCancel&&<button type="button" className="text-button" onClick={cancelTask}>取消本次生成</button>}
    </PersonalActionDock>
    {drawer&&<PersonalDrawer workspace={workspace} onClose={()=>setDrawer(false)}/>}
    {choice&&draft.generation&&draft.generatedInput&&<PersonalRewrite draft={draft} choice={choice} onClose={()=>setChoice(null)} onApply={(fingerprint,result,_target,rewriteBasis)=>{let applied=false;workspace.update(old=>{if(personalResultFingerprint(old)!==fingerprint||!old.generation)return old;applied=true;return {...old,generation:{...old.generation,result},generatedInput:old.generatedInput?{...old.generatedInput,rewrites:[...(old.generatedInput.rewrites||[]),rewriteBasis]}:null,hasUserEdits:true};});if(applied){setNotice("新内容已应用，正在自动保存。");}return applied;}}/>}
    {decision==="stale"&&<VideoDialog title="提示词可能已过期" onClose={()=>setDecision(null)}><p>当前经历、核心感受、长度或图片已改变。你可以重新生成提示词，或继续使用当前已编辑的提示词与当前输入、图片。继续时，核心方向以这份提示词为准，不会自动换成第一步的新填写；参考来源沿用上次提示词保存的资料。</p><div className="regenerate-actions"><button className="secondary-button" type="button" onClick={()=>{setDecision(null);void createPrompt();}}><RotateCcw/>重新生成提示词</button><button className="generate-button" type="button" onClick={()=>{setDecision(null);requestGenerate(true);}}>继续使用当前提示词</button><button className="text-button" type="button" onClick={()=>setDecision(null)}>取消</button></div></VideoDialog>}
    {decision==="regenerate"&&<VideoDialog title="保留已修改的内容？" onClose={()=>setDecision(null)}><p>可以先保存独立副本；新结果通过校验后才替换当前结果，失败时保留原内容。</p><div className="regenerate-actions"><button className="generate-button" type="button" onClick={()=>void chooseRegenerate(true)}>保留修改并重新生成</button><button className="secondary-button" type="button" onClick={()=>void chooseRegenerate(false)}>不保留副本，重新生成</button><button className="text-button" type="button" onClick={()=>setDecision(null)}>取消</button></div></VideoDialog>}
  </div></AppShell>;
}

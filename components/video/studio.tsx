"use client";
import { useEffect,useRef,useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen,LoaderCircle,Sparkles,Download } from "lucide-react";
import { AiUsageStatus, useAiTask } from "../ai/usage-status";
import { SceneHeader } from "@/components/scene-header";
import { AppShell } from "../app-shell";
import { CreationActionDock } from "../creation-action-dock";
import { VideoInput } from "./input-panel";
import { VideoResults } from "./result-panel";
import { VideoDraftDrawer } from "./draft-drawer";
import { VideoDialog } from "./dialog";
import { ShotRewrite } from "./shot-rewrite";
import { RewriteModal } from "../rewrite/modal";
import { TextField } from "./fields";
import { useVideoWorkspace } from "@/lib/video/use-workspace";
import { applyVideoPlan,applyVideoShot,snapshotVideo,videoFingerprint,VIDEO_TRANSFER_KEY,type VideoGeneration } from "@/lib/video/drafts";
import { formatVideoPlan,inputIssue,videoSnapshotSchema,type VideoPlan,type VideoSnapshot } from "@/lib/video/schema";
import { requestVideo } from "@/lib/video/client";
import { analyzeHashtags,textFilename } from "@/lib/format";
import { hotspotTransferSchema } from "@/lib/hotspot-transfer";
import type { PublicConfig } from "@/lib/types";
import "./video.css";

type Preview = {plan:VideoPlan;input:VideoSnapshot;meta:VideoGeneration["meta"];fingerprint:string};
export function VideoStudio({config,timeoutMs}:{config:PublicConfig;timeoutMs:number}){
 
 const router=useRouter();
 const workspace=useVideoWorkspace(),draft=workspace.draft;
 const aiTask=useAiTask();
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[drawer,setDrawer]=useState(false),[regenerate,setRegenerate]=useState(false),[rewriteId,setRewriteId]=useState<string|null>(null),[instruction,setInstruction]=useState(""),[preview,setPreview]=useState<Preview|null>(null),[applying,setApplying]=useState(false),[importError,setImportError]=useState(""),[importAttempt,setImportAttempt]=useState(0);
 const form=useRef<HTMLFormElement>(null);
 const working=useRef(false),controller=useRef<AbortController|null>(null),mounted=useRef(true),handledTransfer=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
 useEffect(()=>{if(!draft||handledTransfer.current)return;handledTransfer.current=true;void(async()=>{let raw:string|null;try{raw=sessionStorage.getItem(VIDEO_TRANSFER_KEY);}catch{setImportError("无法读取待导入选题。当前草稿未修改。");return;}if(!raw)return;let value:unknown;try{value=JSON.parse(raw);}catch{value=null;}const parsed=hotspotTransferSchema.safeParse(value);if(!parsed.success){setImportError("选题信息不完整，请返回热点重新选择。当前草稿未修改。");return;}if(!await workspace.createFromHotspot(parsed.data)){setImportError("原稿未能保存或新稿创建失败，请检查存储后重试导入。");return;}try{sessionStorage.removeItem(VIDEO_TRANSFER_KEY);}catch{/* 新稿已保存，禁止在本次页面再次导入。 */}setImportError("");setNotice("已为热点创建独立视频草稿，原稿保留。请先核实热点事实。");})();},[draft,workspace,importAttempt]);
 if(!draft)return <AppShell disabled><main className="workspace-loading" role="status">{!workspace.error&&<LoaderCircle className="spin"/>}<h1>视频创作</h1>{workspace.error ? <><p className="storage-error" role="alert">{workspace.error} 原有草稿未被覆盖。</p><button type="button" className="secondary-button" onClick={()=>window.location.reload()}>重新读取或登录</button></> : <p>正在读取{workspace.cloud ? "云端" : "本机"}视频草稿…</p>}</main></AppShell>;
 const generation=draft[draft.phase],disabled=busy||workspace.switching||applying;
 const stale=Boolean(generation&&JSON.stringify(generation.input)!==JSON.stringify(snapshotVideo(draft)));
 const selectedShot=generation?.result.shots.find(s=>s.shotId===rewriteId);
 async function launch(preserve=false){
  if(working.current||workspace.switching||!workspace.latest())return;
  working.current=true;setBusy(true);setError("");setNotice("");
  const abort=new AbortController();controller.current=abort;
  const ai=aiTask.start();
  try{
   if(preserve&&!await workspace.preserve())throw new Error("未能保存独立副本，本次未调用 AI。当前内容仍保留，请重试保存。");
   if(abort.signal.aborted||!mounted.current)return;
   const current=workspace.latest()!;
   
   const input=videoSnapshotSchema.parse(snapshotVideo(current));
   const issue=inputIssue(input);if(issue)throw new Error(issue);
   const fingerprint=videoFingerprint(current);
   const output=await requestVideo({action:"generate",input,current:null,targetId:"",instruction},"",abort,timeoutMs,ai.id);
   if(!mounted.current||abort.signal.aborted)return;
   if(!workspace.latest()||videoFingerprint(workspace.latest()!)!==fingerprint)throw new Error("草稿或相关内容已改变，未使用过期结果。请按最新内容重试。");
   if(output.plan&&output.meta)setPreview({plan:output.plan,input,meta:output.meta,fingerprint});
   setRegenerate(false);setRewriteId(null);
  }catch(err){if(mounted.current)setError(err instanceof Error&&err.name!=="ZodError"?err.message:"请检查输入、时长（10～600 秒）和内容长度。原方案仍保留。");}
  finally{working.current=false;controller.current=null;if(mounted.current){setBusy(false);aiTask.finish();}}
 }
 function startGenerate(){
  if(disabled||working.current)return;
  const invalidDuration=form.current?.querySelector<HTMLInputElement>('input[type="number"]:invalid');
  if(invalidDuration){
   const settings=invalidDuration.closest<HTMLDetailsElement>('.video-input-options');
   if(settings)settings.open=true;
   setError("请填写 10～600 秒的整数时长。原方案仍保留。");
   invalidDuration.focus();
   invalidDuration.scrollIntoView({block:"center"});
   return;
  }
  setError("");setInstruction("");if(generation){setRegenerate(true);}else void launch();
 }
 async function applyPreview(){
  if(!preview||working.current)return;working.current=true;setApplying(true);let applied=false;
  try{workspace.update(old=>{const next=applyVideoPlan(old,preview.fingerprint,preview.plan,preview.input,preview.meta);applied=next!==old;return next;});if(!applied){setError("草稿已改变，预览已过期，原内容没有被替换。");setPreview(null);return;}setPreview(null);setInstruction("");const saved=await workspace.save();setNotice(saved?`新内容已应用并保存到${workspace.cloud ? "云端" : "本机"}。`:"新内容已应用，但保存失败；内容仍在页面，请重试保存或复制留存。");}finally{working.current=false;setApplying(false);}
 }
 function download(){if(!generation)return;try{const tags=analyzeHashtags(generation.result.hashtags);if(draft!.phase==="after"&&!tags.valid)throw new Error("请先把标签整理为 10 个有效话题，再导出。原输入保留。");const blob=new Blob(["\uFEFF",formatVideoPlan(generation.result,draft!.phase)],{type:"text/plain;charset=utf-8"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=textFilename(draft!.name);document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice("文字导出已发起，请检查浏览器下载列表。");}catch(err){setError(err instanceof Error?err.message:"导出失败，请复制文案留存。");}}
 return <AppShell disabled={disabled} navigateSafely={workspace.navigateSafely}><div className="video-page creation-studio workbench-page"><SceneHeader scene="film" title="视频创作" description="" variant={draft.phase}><button type="button" className="history-button" disabled={disabled} onClick={()=>setDrawer(true)}><FolderOpen size={16}/>视频草稿箱</button></SceneHeader>
 <div className="workbench-controls"> <div className="video-toolbar"><div className="video-modes" role="group" aria-label="视频创作阶段">{([['before','拍摄前','拍摄策划'],['after','拍摄后','剪辑策划']] as const).map(([phase,title,sub])=><button key={phase} type="button" aria-pressed={draft.phase===phase} disabled={disabled} onClick={()=>{workspace.update(old=>({...old,phase}));setError("");setInstruction("");}}><strong>{title}</strong><span>{sub}</span></button>)}</div><label>草稿<input aria-label="当前视频草稿" value={draft.name} maxLength={80} disabled={disabled} onChange={e=>workspace.update(old=>({...old,name:e.target.value}))}/></label><span role="status" data-testid="video-save-state">{workspace.status}</span><button className="secondary-button" type="button" disabled={!generation||disabled} onClick={download}><Download size={14}/>导出方案</button><details className="video-stage-help"><summary>阶段说明</summary><p>选题、时长与风格共用；两个阶段分别保存输入和方案。</p></details></div></div><main className="video-main workbench-main">
 {workspace.error&&<div className="video-error" role="alert">{workspace.error}<button type="button" className="secondary-button" disabled={disabled} onClick={()=>void workspace.save()}>重试保存视频草稿</button></div>}{workspace.warning&&<p className="video-notice">{workspace.warning}</p>}
 {importError&&<div className="video-error" role="alert">{importError}<button type="button" className="secondary-button" onClick={()=>{handledTransfer.current=false;setImportAttempt(n=>n+1);}}>重试导入视频选题</button></div>}
 {notice&&<p className="video-success" role="status">{notice}</p>}
 <div className={`video-grid ${generation ? "has-result" : "is-empty"}`}><div className="creation-pane" role="region" aria-label="视频创作输入" tabIndex={0}><form ref={form} id="video-creation-form" noValidate onSubmit={e=>{e.preventDefault();startGenerate();}}><VideoInput draft={draft} disabled={disabled} onChange={next=>workspace.update(()=>next)} onManageStyles={()=>void workspace.navigateSafely(()=>router.push("/personal/styles"))}/></form><details className="storage-help"><summary>草稿存储</summary><p>{workspace.cloud ? "视频草稿保存在你的账号下，登录后可跨设备继续编辑。可复制或导出文案留存。" : "草稿保存在当前设备、当前浏览器。清除站点数据可能丢失；暂不支持跨设备同步。可复制或导出文案留存。"}</p></details></div>
 <div className="creation-pane creation-output" role="region" aria-label="视频创作结果" tabIndex={0}><VideoResults key={`${draft.id}:${draft.phase}:${generation?.meta.completedAt??"empty"}`} generation={generation} disabled={disabled} stale={stale} saveStatus={workspace.status} saveError={workspace.error} onRetrySave={()=>void workspace.save()} onChange={result=>workspace.update(old=>{const previous=old[old.phase];return previous?{...old,[old.phase]:{...previous,result,edited:true}}:old;})} onRewrite={id=>{setError("");setInstruction("");setRewriteId(id);}} onRegenerate={startGenerate} onError={setError}/></div>
 </div></main>
 <CreationActionDock label="视频生成操作">
   <div className="creation-action-context"><div className="creation-action-status"><AiUsageStatus task={aiTask}/><p className="mode-description">文字要求发送至所选 AI，产生 API 用量</p></div></div>
   <div className="creation-action-buttons"><button type="submit" form="video-creation-form" className="generate-button" disabled={disabled}>{busy?<LoaderCircle size={17} className="spin"/>:<Sparkles size={17}/>}<span>{busy?"正在生成方案…":draft.phase==="before"?"生成拍摄方案":"生成剪辑方案"}</span></button>{busy&&<button type="button" className="text-button" onClick={()=>controller.current?.abort()}>取消本次生成</button>}</div>
   {error&&!rewriteId&&!regenerate&&<p className="creation-action-feedback video-error" role="alert">{error}</p>}
 </CreationActionDock></div>
 {drawer&&<VideoDraftDrawer workspace={workspace} onClose={()=>setDrawer(false)}/>}
 {regenerate&&<VideoDialog title="重新生成整份方案" locked={busy} onClose={()=>setRegenerate(false)}><AiUsageStatus task={aiTask}/><p className="video-hint">{generation?.edited?"这份方案有手动修改，可先保存独立副本。":"可保存当前方案的独立副本再生成。"}新结果会先预览，确认后才替换；失败时旧方案保留。</p><TextField label="本次重新生成的补充要求" multiline max={1000} value={instruction} onChange={setInstruction}/>{error&&<p className="video-error" role="alert">{error}</p>}<div className="video-dialog-actions"><button type="button" className="generate-button" disabled={disabled} onClick={()=>void launch(true)}>保留修改并重新生成</button><button type="button" className="secondary-button" disabled={disabled} onClick={()=>void launch(false)}>不保留副本，重新生成</button><button type="button" className="text-button" onClick={()=>{controller.current?.abort();if(!busy)setRegenerate(false);}}>{busy?"取消本次生成":"取消，继续编辑"}</button></div>{busy&&<p role="status" className="video-hint">正在处理，请稍候…</p>}</VideoDialog>}
 {rewriteId&&generation&&selectedShot&&<ShotRewrite draft={draft} targetId={rewriteId} config={config} timeoutMs={timeoutMs} stale={stale} onClose={()=>setRewriteId(null)} onApply={async(fingerprint,shot)=>{let applied=false;workspace.update(old=>{const next=applyVideoShot(old,fingerprint,shot);applied=next!==old;return next;});if(!applied)return false;const saved=await workspace.save();setNotice(saved?"新镜头已应用并保存。":"新镜头已应用，但保存失败；内容仍在页面，请重试保存。");return true;}}/>}
 {preview&&<RewriteModal label={preview.input.phase==="before"?"拍摄脚本":"剪辑方案"} resultTitle={preview.input.phase==="before"?"拍摄脚本生成结果":"剪辑方案生成结果"} result directionLabel="整份方案" applying={applying} copyText={formatVideoPlan(preview.plan,preview.input.phase)} onCopyError={setError} error={error} onClose={()=>setPreview(null)} onEdit={()=>{setPreview(null);setRegenerate(true);}} onStart={()=>{setPreview(null);setRegenerate(true);}} onApply={()=>void applyPreview()}><p className="rw-text">{formatVideoPlan(preview.plan,preview.input.phase)}</p></RewriteModal>}

 </AppShell>;
}

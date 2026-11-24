"use client";

import { AiUsageStatus, useAiTask } from "../ai/usage-status";
import { useEffect, useRef, useState } from "react";
import { RewriteModal, RewriteSettings, rewriteDirectionLabel } from "@/components/rewrite/modal";
import { RewriteResult, rewriteLabels, partialCopyText } from "@/components/rewrite/result";
import { analyzeHashtags } from "@/lib/format";
import { type PartialChoice, type PartialResult } from "@/lib/partial-client";
import type { RewriteDirection } from "@/lib/rewrite-request";
import { personalRequest } from "@/lib/personal/client";
import type { PersonalDraft, PersonalRewriteBasis } from "@/lib/personal/drafts";
import { latestPersonalRewriteBasis } from "@/lib/personal/drafts";
import { personalCaptionText } from "@/lib/personal/captions";
import { personalResultFingerprint, validatePersonalPartial } from "@/lib/personal/flow";
import { PersonalStylePicker } from "./style-picker";
import { ruleSnapshotSchema, type RuleSnapshot } from "@/lib/personal/style-rules";
import type { PersonalInput } from "@/lib/personal/schema";
import type { ContentResult } from "@/lib/schema";

export type PersonalChoice = PartialChoice | {target:"body"};
export function PersonalRewrite({ draft, choice, onClose, onApply }: {draft:PersonalDraft;choice:PersonalChoice;onClose:()=>void;onApply:(fingerprint:string,result:ContentResult,target:PersonalChoice["target"],basis:PersonalRewriteBasis)=>boolean}) {
  const aiTask=useAiTask();
  const [snapshot] = useState(() => ({draft, fingerprint:personalResultFingerprint(draft)}));
  const [direction,setDirection]=useState<RewriteDirection>("natural"), [instruction,setInstruction]=useState(""), [candidate,setCandidate]=useState(0);
  const [output,setOutput]=useState<{body:string;titles:string[];imageCaptions:ContentResult["imageCaptions"];hashtags:string[]}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const working=useRef(false), controller=useRef<AbortController|null>(null), mounted=useRef(true);
  
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
  const current=snapshot.draft.generation!.result, basis=snapshot.draft.generatedInput!, images=snapshot.draft.resultImages;
  const target=choice.target;
  const prior=latestPersonalRewriteBasis(basis.rewrites||[],choice);
  const [rewriteInput,setRewriteInput]=useState<PersonalInput>(()=>structuredClone(prior?.input||basis.input));
  const [rewritePrompt,setRewritePrompt]=useState(prior?.confirmedPrompt||basis.confirmedPrompt);
  const [changing,setChanging]=useState((prior?.input||basis.input).styles.length!==1),[confirmed,setConfirmed]=useState(false);
  const [outputBasis,setOutputBasis]=useState<PersonalRewriteBasis|null>(null);
  function changeRules(rules:RuleSnapshot){setRewriteInput(old=>({...old,styles:[rules.styleId],ruleSnapshot:rules}));setChanging(true);setConfirmed(false);}

  async function start(){
    if(working.current)return;
    if((basis.rewrites?.length||0)>=100){setError("此笔记已保存 100 次重写依据，请完整重新生成新版本后继续；历史记录保留。");return;}
    if(rewriteInput.styles.length!==1||(changing&&!confirmed)||!rewritePrompt.trim()){setError("请明确选择一种风格，查看并确认本次重写的方向与规则。");return;}
    if(target==="tag_one"&&!analyzeHashtags(current.hashtags).valid){setError("请先整理为 10 个不重复的话题；当前内容仍保留。");return;}
    working.current=true;setBusy(true);setError("");setOutput(null);const abort=new AbortController();controller.current=abort;const ai=aiTask.start();
    try{
      const data=await personalRequest({action:"rewrite",input:rewriteInput,imageIds:basis.imageIds,confirmedPrompt:rewritePrompt,...(basis.research?{research:basis.research}:{}),rewrite:{...choice,direction,instruction,current}},images,abort,{source:ai.id});
      const usedInput={...rewriteInput,ruleSnapshot:ruleSnapshotSchema.parse(data.ruleSnapshot)};
      const value=data?.rewrite;
      if(!value||typeof value.body!=="string"||!Array.isArray(value.titles)||!Array.isArray(value.imageCaptions)||!Array.isArray(value.hashtags))throw new Error("重写结果不完整，原内容仍保留。");
      if(target==="body") { if(!value.body.trim()||value.body.length>8000)throw new Error("新正文不完整，原内容仍保留。"); }
      else if(!validatePersonalPartial(value as PartialResult,choice as PartialChoice,current,basis.imageIds,usedInput)) throw new Error("重写结果数量、图片或话题不合格，原内容仍保留。");
      if(mounted.current&&!abort.signal.aborted){setOutput(value);setOutputBasis({target,...("targetIndex" in choice?{targetIndex:choice.targetIndex}:{}),...(choice.target==="caption_one"?{targetImageId:choice.targetImageId}:{}),at:new Date().toISOString(),input:usedInput,confirmedPrompt:rewritePrompt});setCandidate(0);}
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:"重写失败，原内容仍保留。");}
    finally{working.current=false;controller.current=null;if(mounted.current){setBusy(false);aiTask.finish();}}
  }
  function accept(){
    if(!output||!outputBasis)return;
    if(target==="body"?(!output.body.trim()||output.body.length>8000):!validatePersonalPartial(output,choice as PartialChoice,current,basis.imageIds,outputBasis.input)){setError("重写结果不合格，原内容仍保留。");return;}
    let next:ContentResult=current;
    if(target==="body")next={...current,body:output.body};
    else if(target==="title_one"){const index=choice.targetIndex??0,title=output.titles[candidate];if(!title||current.titles.some((x,i)=>i!==index&&x.trim().toLocaleLowerCase()===title.trim().toLocaleLowerCase())){setError("候选标题与已有标题重复，请选择其他候选。");return;}next={...current,titles:current.titles.map((x,i)=>i===index?title:x)};}
    else if(target==="titles_all")next={...current,titles:output.titles};
    else if(target==="caption_one")next={...current,imageCaptions:current.imageCaptions.map(x=>x.imageId===choice.targetImageId?output.imageCaptions[0]:x)};
    else if(target==="captions_all")next={...current,imageCaptions:output.imageCaptions};
    else if(target==="tag_one"){const tags=analyzeHashtags(current.hashtags).tags;next={...current,hashtags:tags.map((x,i)=>i===(choice.targetIndex??0)?output.hashtags[candidate]:x)};if(!analyzeHashtags(next.hashtags).valid){setError("替换后话题不合格，原内容仍保留。");return;}}
    else next={...current,hashtags:output.hashtags};
    if(!onApply(snapshot.fingerprint,next,target,outputBasis)){setError("草稿或原内容已改变，本次预览没有覆盖最新内容。请重新发起。");return;}onClose();
  }
  function close(){controller.current?.abort();onClose();}
  return <RewriteModal label={rewriteLabels[target]} result={!!output} directionLabel={rewriteDirectionLabel(direction)} busy={busy} error={error} copyText={output?(target==="body"?output.body:(target==="caption_one"||target==="captions_all"?output.imageCaptions.map(c=>`图片 ${images.findIndex(i=>i.id===c.imageId)+1}\n${personalCaptionText(c)}`).join("\n\n"):partialCopyText(output,images))):""}
    onClose={close} onStart={()=>void start()} onEdit={()=>{setOutput(null);setError("");}} onApply={accept} onCopyError={setError}
    warning={JSON.stringify(draft.input)!==JSON.stringify(basis.input)||draft.prompt!==basis.confirmedPrompt?"输入或方向已改变；本次沿用原结果确认的提示词与图片。":null}
    settings={<RewriteSettings direction={direction} onDirection={setDirection} instruction={instruction} onInstruction={setInstruction} busy={busy} basis={<>
      <AiUsageStatus task={aiTask}/><p>{"点击后使用 API 用量。"}沿用原结果已确认的方向、风格和真实性；不会自动联网。</p>
      <p>{target==="caption_one"||target==="captions_all"?`配文依据生成时的 ${images.length} 张图片。`:"本次不会把图片或逐图配文发送给模型。"}</p>
      <p>规则：{rewriteInput.ruleSnapshot?`${rewriteInput.ruleSnapshot.content.name} · v${rewriteInput.ruleSnapshot.version}`:rewriteInput.styles.length===1?"原始内置 v1":"旧多风格待确认"}</p>
      {!changing&&<button type="button" className="text-button" disabled={busy} onClick={()=>setChanging(true)}>为本次重写重新选择规则并确认依据</button>}
      {changing&&<div className="personal-rewrite-basis"><p>原笔记与原生成依据保留。只为这次重写选择一种风格，旧提示词中的组合风格不再采用。</p><PersonalStylePicker input={rewriteInput} legacy disabled={busy} onChange={changeRules}/><label className="field">本次重写确认的核心方向与写作安排<textarea value={rewritePrompt} rows={6} maxLength={12000} disabled={busy} onChange={e=>{setRewritePrompt(e.target.value);setConfirmed(false);}}/></label><label className="personal-check"><input type="checkbox" checked={confirmed} disabled={busy||rewriteInput.styles.length!==1} onChange={e=>setConfirmed(e.target.checked)}/>我已确认上述方向，按选定的单一风格与规则版本重写</label></div>}
      <p>真实性：{rewriteInput.truth==="truthful"?"真实润色":"创意发挥"}</p><p className="rw-text">{changing?"旧内容仅在采用新结果后替换。":rewritePrompt}</p>
    </>}/>}
  >{output&&(target==="body"?<p className="rw-text">{output.body}</p>:<RewriteResult output={output} choice={choice as PartialChoice} images={images} selected={candidate} onSelect={setCandidate} paragraphCaptions/>)}</RewriteModal>;
}

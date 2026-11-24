"use client";
/* eslint-disable @next/next/no-img-element -- Local snapshot object URLs. */
import { useEffect, useRef, useState } from 'react';
import { AiUsageStatus, useAiTask } from './ai/usage-status';
import { RewriteModal, RewriteSettings, rewriteDirectionLabel } from "./rewrite/modal";
import { RewriteResult, rewriteLabels, partialCopyText } from "./rewrite/result";
import type { Draft } from '@/lib/drafts';
import type { PublicConfig } from '@/lib/types';
import type { RewriteDirection } from '@/lib/rewrite-request';
import { analyzeHashtags } from '@/lib/format';
import { partialFingerprint, submitPartial, validatePartial, type PartialChoice, type PartialResult } from '@/lib/partial-client';

type Props = { draft: Draft; choice: PartialChoice; config: PublicConfig; stale: boolean; onClose: () => void; onApply: (fingerprint: string, choice: PartialChoice, result: PartialResult, selected: number) => boolean };
export function PartialRewriteDialog({ draft, choice, config, stale, onClose, onApply }: Props) {
  void config; // Retain the existing component prop contract during migration.
  const aiTask=useAiTask();
  const controller=useRef<AbortController|null>(null), working=useRef(false), mounted=useRef(true);
  const [snapshot] = useState(() => ({ generation: draft.generation!, generatedInput: draft.generatedInput, images: draft.resultImages, fingerprint: partialFingerprint(draft) }));
  const [direction,setDirection]=useState<RewriteDirection>('natural');
  const [instruction,setInstruction]=useState('');
  const [output,setOutput]=useState<PartialResult|null>(null);
  const [selected,setSelected]=useState(0);
  const [busy,setBusy]=useState(false), [progress,setProgress]=useState(''), [error,setError]=useState('');
  const current=snapshot.generation.result, tags=analyzeHashtags(current.hashtags);
  const selectedTitleConflict = choice.target === 'title_one' && output?.titles[selected] && current.titles.some((x,i)=>i!==choice.targetIndex && x.trim().toLocaleLowerCase()===output.titles[selected].trim().toLocaleLowerCase());
  useEffect(()=>{ mounted.current=true;return()=>{mounted.current=false;controller.current?.abort()}; },[]);
  function close(){controller.current?.abort();onClose();}
  async function start(){
    if(working.current)return;
    setError('');
    if(draft.mode!=='live'){setError('请先关闭窗口并切换到真实生成模式；演示模式不会调用 AI。');return;}
    if(!snapshot.generatedInput || !snapshot.images.length || JSON.stringify(snapshot.images.map(x=>x.id))!==JSON.stringify(snapshot.generatedInput.imageIds)){setError('找不到这份结果对应的完整图片和要求，请重新生成后再试。');return;}
    if(choice.target==='tag_one' && (!tags.valid || tags.duplicateCount)){setError('请先整理为 10 个不重复且有效的话题，再重写单个话题；原输入已保留。');return;}
    working.current=true; const next=new AbortController();controller.current=next;const aiSource=aiTask.start().id;setBusy(true);setOutput(null);setSelected(0);
    try{
      const result=await submitPartial({brief:snapshot.generatedInput.brief,current,images:snapshot.images,choice,direction,instruction,research:snapshot.generation.research,controller:next,onProgress:setProgress,aiSource});
      if(!mounted.current||next.signal.aborted)return;setOutput(result);setProgress('');
    }catch(e){if(mounted.current&&!next.signal.aborted){setError(e instanceof Error?e.message:'重写失败，原内容仍保留。');setProgress('');}}
    finally{working.current=false;controller.current=null;if(mounted.current){setBusy(false);aiTask.finish();}}
  }
  function accept(){ if(!output || selectedTitleConflict)return; if(!validatePartial(output,choice,current,snapshot.generatedInput!.imageIds)){setError("结果不合格，原内容仍保留。");return;} if(!onApply(snapshot.fingerprint,choice,output,selected)){setError('内容、图片或草稿已发生变化，未覆盖最新内容。请关闭后重新发起。');return;}onClose(); }
  const brief=snapshot.generatedInput?.brief;
  const basis=<><AiUsageStatus task={aiTask}/><p>{`发送至 当前 AI 配置，产生 API 用量。`}复用 {snapshot.generation.research?.sources.length??0} 条资料，不自动联网。</p>
    {brief&&<dl><dt>主题</dt><dd>{brief.topic}</dd><dt>语气 / 受众</dt><dd>{brief.tone} / {brief.audience||'未指定'}</dd><dt>补充要求</dt><dd>{brief.details||'无'}</dd><dt>常用要求</dt><dd>{brief.styleNotes||'无'}</dd><dt>必提 / 禁用</dt><dd>{brief.mustInclude||'无'} / {brief.forbidden||'无'}</dd><dt>Emoji</dt><dd>{brief.emoji?'允许':'不使用'}</dd></dl>}
    <div className="rw-images">{snapshot.images.map((image,i)=><img key={image.id} src={image.preview} alt={`生成时的图片 ${i+1}`}/>)}</div></>;
  return <RewriteModal label={rewriteLabels[choice.target]} result={!!output} directionLabel={rewriteDirectionLabel(direction)} busy={busy} progress={progress} error={error} copyText={output?partialCopyText(output,snapshot.images):''}
    onClose={close} onStart={()=>void start()} onEdit={()=>{setOutput(null);setError('');}} onApply={accept} onCopyError={setError} startDisabled={draft.mode!=='live'} applyDisabled={Boolean(selectedTitleConflict)}
    warning={selectedTitleConflict?'候选与已有标题重复，请选择其他候选。':draft.mode!=='live'?'演示模式不调用 AI，请切换为真实生成。':stale?'输入已改变；本次仍依据原结果生成时的要求和图片。':snapshot.generation.mode==='demo'?'原结果是演示样例，请确认其与图片相符后重写。':null}
    settings={<RewriteSettings direction={direction} onDirection={setDirection} instruction={instruction} onInstruction={setInstruction} busy={busy} basis={basis}/>}
  >{output&&<RewriteResult output={output} choice={choice} images={snapshot.images} selected={selected} onSelect={setSelected}/>}</RewriteModal>;
}

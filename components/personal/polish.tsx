'use client';
import { useEffect, useRef, useState } from 'react';
import { AiUsageStatus, useAiTask } from '../ai/usage-status';
import { Sparkles } from 'lucide-react';
import { RewriteModal } from '@/components/rewrite/modal';
import type { PersonalDraft } from '@/lib/personal/drafts';
import { applyPolish, undoPolish, canPolish, capturePolish, polishCopyText, type PolishTicket } from '@/lib/personal/polish';
import { polishScopeLabels, type PolishField, type PolishResponse, type PolishScope } from '@/lib/personal/polish-schema';
import { requestPersonalPolish } from '@/lib/personal/polish-client';

type FieldComparison = {key:string;label:string;before:string;after:string;changed:boolean};

export function comparePolishFields(before:PolishField[], after:PolishField[]):FieldComparison[] {
 const revised=new Map(after.map(field=>[field.key,field.text]));
 let imageNumber=0;
 return before.map(field=>{
  let label='正文';
  if(field.key.startsWith('title:')) label=`标题 ${Number(field.key.slice(6))+1}`;
  else if(field.key.startsWith('caption:')) label=`图片 ${++imageNumber} 配文`;
  else if(field.key==='cover:headline') label='封面主标题';
  else if(field.key==='cover:subline') label='封面副标题';
  const text=revised.get(field.key) ?? field.text;
  const changed=field.text.trim()!==text.trim();
  return {key:field.key,label,before:field.text,after:changed?text:field.text,changed};
 });
}

export function polishChangeMessage(fields:FieldComparison[],applied=false) {
 const changes=fields.filter(field=>field.changed);
 if(!changes.length) return '本次返回的内容与原文相同。';
 const body=fields.find(field=>field.key==='body');
 const titles=changes.filter(field=>field.key.startsWith('title:')).length;
 const covers=changes.filter(field=>field.key.startsWith('cover:')).length;
 const captions=changes.filter(field=>field.key.startsWith('caption:')).length;
 const parts=[body?.changed && '正文',titles && `${titles} 个标题`,covers && `${covers} 处封面文案`,captions && `${captions} 条图片配文`].filter(Boolean).join('、');
 const message=applied ? `已采用${parts}的修改。` : `本次修改了${parts}。`;
 return message+(body && !body.changed ? '正文未改。' : '');
}

/** Mounted with the draft ID as key, so switching drafts cancels the preview. */
export function PersonalPolishControls({draft,disabled,update}:{draft:PersonalDraft;disabled:boolean;update:(change:(old:PersonalDraft)=>PersonalDraft)=>void}){
 const [open,setOpen]=useState(false),[notice,setNotice]=useState('');
 function revert(){let message='';update(old=>{try{const next=undoPolish(old);message='已撤回本次润色，正在自动保存。';return next;}catch(e){message=e instanceof Error?e.message:'撤回失败，当前内容保留。';return old;}});setNotice(message);}
 function accept(ticket:PolishTicket,result:PolishResponse){
  if(disabled)return '笔记正在更新，请稍后重新润色。';
  let message='草稿已改变，请重新润色。',applied=false;
  update(old=>{try{const next=applyPolish(old,ticket,result);applied=true;return next;}catch(e){message=e instanceof Error?e.message:'未采用润色，原文保留。';return old;}});
  if(applied){setNotice(polishChangeMessage(comparePolishFields(ticket.request.fields,result.fields),true));return undefined;}return message;
 }
 return <><div className="personal-polish-toolbar"><div className="personal-inline-actions">
  {draft.polishUndo&&<button type="button" className="text-button" disabled={disabled} onClick={revert}>撤回本次润色</button>}
  <button type="button" className="secondary-button" disabled={disabled||!canPolish(draft)} onClick={()=>{setNotice('');setOpen(true);}}><Sparkles size={15}/>润色文案</button>
 </div>{!canPolish(draft)&&<p className="field-hint">生成文案后可润色。</p>}{notice&&<p className="field-hint" role="status">{notice}</p>}</div>
 {open&&draft.generation&&draft.generatedInput&&<PersonalPolish draft={draft} onClose={()=>setOpen(false)} onApply={accept}/>}</>;
}

export function PersonalPolishPreview({fields,scope}:{fields:FieldComparison[];scope:PolishScope}){
 const changes=fields.filter(field=>field.changed).sort((a,b)=>Number(b.key==='body')-Number(a.key==='body'));
 const fullLabel={all:'查看完整文案',body:'查看完整正文',captions:'查看全部配文'}[scope];
 return <div className="personal-polish-preview">
  {changes.map(field=><section className="personal-polish-change" key={field.key} aria-label={`${field.label}修改对照`}>
   <h4>{field.label}</h4>
   <dl className="personal-polish-pair">
    <div><dt>修改前</dt><dd className="rw-text">{field.before}</dd></div>
    <div><dt>修改后</dt><dd className="rw-text">{field.after}</dd></div>
   </dl>
  </section>)}
  <details className="personal-polish-full">
   <summary>{fullLabel}</summary>
   {fields.filter(field=>field.after.trim()).map(field=><section key={field.key}>
    <h4>{field.label}</h4><p className="rw-text">{field.after}</p>
   </section>)}
  </details>
 </div>;
}
export function PersonalPolish({draft,onClose,onApply}:{draft:PersonalDraft;onClose:()=>void;onApply:(ticket:PolishTicket,result:PolishResponse)=>string|undefined}){
 const aiTask=useAiTask();
 const [scope,setScope]=useState<PolishScope>('all'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [preview,setPreview]=useState<{ticket:PolishTicket;result:PolishResponse;fields:FieldComparison[]}|null>(null);
 const working=useRef(false),abort=useRef<AbortController|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;abort.current?.abort();};},[]);
 async function start(){
  if(working.current)return;
  let ticket:PolishTicket;
  try{ticket=capturePolish(draft,scope);}catch(e){setError(e instanceof Error?e.message:'当前文案无法润色。');return;}
  working.current=true;setBusy(true);setError('');setPreview(null);
  const controller=new AbortController();abort.current=controller;const ai=aiTask.start();
  try{
   const result=await requestPersonalPolish(ticket.request,controller,{source:ai.id});
   if(mounted.current&&!controller.signal.aborted){
    const fields=comparePolishFields(ticket.request.fields,result.fields);
    const reviewed={...result,fields:fields.map(({key,after})=>({key,text:after}))};
    setPreview({ticket,result:reviewed,fields});
   }
  }catch(e){if(mounted.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:'润色失败，原文保留。');}
  finally{working.current=false;abort.current=null;if(mounted.current){setBusy(false);aiTask.finish();}}
 }
 function close(){abort.current?.abort();onClose();}
 function accept(){if(!preview||busy)return;const message=onApply(preview.ticket,preview.result);if(message)setError(message);else onClose();}
 const unchanged=Boolean(preview&&!preview.fields.some(field=>field.changed));
 return <RewriteModal label="文案" result={!!preview} resultTitle="润色预览" directionLabel={polishScopeLabels[scope]} busy={busy} error={error}
  progress="正在润色，原文保持不变…" copyText={preview?polishCopyText(preview.result.fields):''} onCopyError={setError}
  onClose={close} onStart={()=>void start()} onEdit={()=>{setPreview(null);setError('');}} onApply={accept} startDisabled={!canPolish(draft,scope)} applyDisabled={unchanged}
  labels={{title:'润色文案',close:'关闭润色文案',description:'减少套话和重复，保留原意。预览后采用，不满意可关闭。',resultDescription:preview?polishChangeMessage(preview.fields):undefined,edit:'调整范围',resultHeading:unchanged?'本次文案':'修改对照',cancelBusy:'取消润色',again:'再次润色',apply:'采用润色',busy:'正在润色…',retry:'重试润色',start:'开始润色'}}
  settings={<fieldset className="personal-polish-settings" disabled={busy}><legend>润色范围</legend><div className="personal-polish-scopes">{(['all','body','captions'] as const).map(value=><label key={value}><input type="radio" name="personal-polish-scope" value={value} checked={scope===value} disabled={!canPolish(draft,value)} onChange={()=>{setScope(value);setError('');}}/>{polishScopeLabels[value]}</label>)}</div>{!canPolish(draft,'captions')&&<p className="rw-muted">没有可处理的逐图配文。</p>}<AiUsageStatus task={aiTask}/><p className="rw-muted">点击后使用 API 用量。</p></fieldset>}
 >{preview&&<PersonalPolishPreview fields={preview.fields} scope={preview.ticket.request.scope}/>}</RewriteModal>;
}

"use client";

import * as React from "react";
import { LoaderCircle, Sparkles, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { RewriteDirection } from "@/lib/rewrite-request";

export const rewriteDirections: { value: RewriteDirection; label: string }[] = [
  {value:"natural",label:"更自然"},{value:"concise",label:"更简洁"},
  {value:"appealing",label:"更有吸引力"},{value:"detailed",label:"更详细"},{value:"custom",label:"自定义要求"},
];
export function rewriteDirectionLabel(direction: RewriteDirection) { return rewriteDirections.find(d=>d.value===direction)!.label; }

export function RewriteSettings({direction,onDirection,instruction,onInstruction,busy,basis,maxLength=500}: {
  direction?:RewriteDirection;onDirection?:(value:RewriteDirection)=>void;
  instruction:string;onInstruction:(value:string)=>void;busy:boolean;basis:React.ReactNode;maxLength?:number;
}) {
  return <div className="rw-settings">
    {direction&&onDirection&&<label className="rw-field">修改方向<select disabled={busy} value={direction} onChange={e=>onDirection(e.target.value as RewriteDirection)}>{rewriteDirections.map(d=><option value={d.value} key={d.value}>{d.label}</option>)}</select></label>}
    <label className="rw-field">补充要求（选填）<textarea rows={3} value={instruction} disabled={busy} maxLength={maxLength} onChange={e=>onInstruction(e.target.value)} placeholder="例如：语气更自然，保留重点，少一些刻意的抒情。"/></label>
    <details className="rw-basis"><summary>本次重写依据</summary><div>{basis}</div></details>
  </div>;
}

type Props = {
  label:string;resultTitle?:string;result:boolean;directionLabel:string;
  busy?:boolean;applying?:boolean;progress?:string;error?:string;warning?:React.ReactNode;
  settings?:React.ReactNode;children?:React.ReactNode;copyText:string;
  onClose:()=>void;onStart:()=>void;onEdit:()=>void;onApply:()=>void;onCopyError:(error:string)=>void;
  startDisabled?:boolean;applyDisabled?:boolean;
  labels?:Partial<Record<"title"|"close"|"description"|"resultDescription"|"edit"|"resultHeading"|"cancelBusy"|"again"|"apply"|"busy"|"retry"|"start",string>>;
};

/** Shared rewrite/polish preview shell; other confirmation dialogs are unchanged. */
export function RewriteModal(props:Props) {
  const dialog=React.useRef<HTMLDialogElement>(null);
  const heading=React.useRef<HTMLHeadingElement>(null);
  const titleId=React.useId();
  React.useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  React.useEffect(()=>{if(props.result)heading.current?.focus({preventScroll:true});},[props.result]);
  React.useEffect(()=>{if(props.error)dialog.current?.querySelector(".rw-error")?.scrollIntoView({block:"nearest"});},[props.error]);
  return <dialog ref={dialog} className="rewrite-modal" aria-labelledby={titleId} onCancel={e=>{e.preventDefault();if(!props.applying)props.onClose();}}>
    <RewriteLayout {...props} titleId={titleId} headingRef={heading}/>
  </dialog>;
}

export function RewriteLayout({label,resultTitle,result,directionLabel,busy=false,applying=false,progress,error,warning,settings,children,copyText,onClose,onStart,onEdit,onApply,onCopyError,startDisabled,applyDisabled,labels={},titleId,headingRef}:Props & {titleId:string;headingRef?:React.Ref<HTMLHeadingElement>}) {
  return <>
    <header className="rw-header"><div className="rw-title-row"><h2 ref={headingRef} id={titleId} tabIndex={-1}>{result?(resultTitle??`${label}重写结果`):(labels.title??`重写${label}`)}</h2><button type="button" className="rw-close" aria-label={labels.close??`关闭${label}重写`} disabled={applying} onClick={onClose}><X size={18}/></button></div>
      <div className="rw-subtitle"><p role={result?"status":undefined}>{result?(labels.resultDescription??`已生成 · ${directionLabel}`):(labels.description??"生成后可预览，采用前不会替换现有内容。")}</p>{result&&<button type="button" className="rw-link" disabled={applying} onClick={onEdit}>{labels.edit??"修改要求"}</button>}</div>
    </header>
    <div className="rw-content" aria-busy={busy}>
      {warning&&<div className="rw-warning" role="status">{warning}</div>}
      {!result?settings:<section className="rw-new-result"><div className="rw-result-heading"><h3>{labels.resultHeading??`新${label}`}</h3><CopyButton text={copyText} label="复制新结果" onError={onCopyError}/></div>{children}</section>}
      {busy&&<p className="rw-progress" role="status"><LoaderCircle size={15} className="spin"/>{progress||"正在重写，请稍候…"}</p>}
      {error&&<p className="rw-error" role="alert">{error}</p>}
    </div>
    <footer className={`rw-footer${result?" is-result":""}`}>
      <button type="button" className="rw-secondary rw-dismiss" disabled={applying} onClick={onClose}>{result?"关闭":busy?(labels.cancelBusy??"取消本次重写"):"取消"}</button>
      {result?<><button type="button" className="rw-secondary" disabled={applying||busy||startDisabled} onClick={onStart}>{labels.again??"重新重写"}</button><button type="button" className="rw-primary" disabled={applying||busy||applyDisabled} onClick={onApply}>{applying?"正在保存…":(labels.apply??"使用此结果")}</button></>:<button type="button" className="rw-primary" disabled={busy||startDisabled} onClick={onStart}>{busy?<LoaderCircle size={15} className="spin"/>:<Sparkles size={15}/>} {busy?(labels.busy??"正在重写…"):error?(labels.retry??"重试重写"):(labels.start??"开始重写")}</button>}
    </footer>
  </>;
}

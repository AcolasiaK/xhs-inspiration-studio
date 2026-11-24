"use client";

import * as React from "react";
import { personalDirectionPreview } from "@/lib/personal/presentation";
import type { PersonalInput } from "@/lib/personal/schema";

function DirectionExcerpt({core,preview}:{core:string;preview:string}) {
  const [expanded,setExpanded]=React.useState(false);
  const [overflow,setOverflow]=React.useState(false);
  const text=React.useRef<HTMLParagraphElement>(null);
  React.useEffect(()=>{
    const element=text.current;if(!element)return;
    const observer=new ResizeObserver(()=>{if(!expanded)setOverflow(element.scrollHeight>element.clientHeight+1);});
    observer.observe(element);return()=>observer.disconnect();
  },[expanded,preview]);
  return <div className="personal-core-excerpt">
    <p id="personal-direction-excerpt" ref={text} className={`personal-core-direction${expanded?" is-expanded":""}`}>{expanded?core:preview}</p>
    {(core!==preview||overflow||expanded)&&<button type="button" className="text-button personal-summary-toggle" aria-expanded={expanded} aria-controls="personal-direction-excerpt" onClick={()=>setExpanded(value=>!value)}>{expanded?"收起":"展开摘要"}</button>}
  </div>;
}

export function PromptDirection({ prompt, input, pending = false }: { prompt: string; input: PersonalInput; pending?: boolean }) {
  const direction=personalDirectionPreview(prompt,input);
  return <div className="personal-direction">
    {pending?<p className="personal-core-direction" role="status">写作安排待核对，请展开完整提示词查看；确认生成时仍使用当前全文。</p>:direction.core?<DirectionExcerpt key={prompt} core={direction.core} preview={direction.preview}/>:<p className="personal-core-direction">提示词已准备好，可展开查看</p>}
    <p className="personal-direction-settings" aria-label="本次实际执行设置"><span>{direction.writingLabel}</span><i aria-hidden="true">·</i><span>{direction.lengthLabel}</span><i aria-hidden="true">·</i><span>{direction.truthLabel}{input.truth==="creative"?"（可能虚构）":""}</span></p>
    {direction.conflict&&<p className="personal-direction-conflict" role="status">{direction.conflict}</p>}
  </div>;
}

"use client";

import { useEffect, useRef } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { PersonalStep } from "@/lib/personal/presentation";

export const personalFlowSteps: {key:PersonalStep;title:string}[] = [
  {key:"input",title:"输入内容"}, {key:"prompt",title:"确认创作方向"}, {key:"result",title:"查看与调整笔记"},
];

export function WorkflowNav({ active, statuses, completed, onSelect, running, onCancel }: {
  active: PersonalStep; statuses: Record<PersonalStep,string>; completed: Record<PersonalStep,boolean>;
  onSelect: (step:PersonalStep)=>void; running?: string; onCancel?:()=>void;
}) {
  const nav=useRef<HTMLElement>(null);
  useEffect(()=>{
    const element=nav.current,studio=element?.closest<HTMLElement>(".personal-studio");
    if(!element||!studio)return;
    const observer=new ResizeObserver(()=>studio.style.setProperty("--personal-flow-height",`${element.getBoundingClientRect().height}px`));
    observer.observe(element);
    return()=>{observer.disconnect();studio.style.removeProperty("--personal-flow-height");};
  },[]);
  return <nav ref={nav} className="personal-flow-nav" aria-label="个人创作步骤">
    <div className="personal-flow-tabs" role="tablist" aria-label="选择创作步骤" aria-orientation="horizontal">
      {personalFlowSteps.map(({key,title},index)=><button key={key} type="button" role="tab"
        id={`personal-tab-${key}`} aria-controls={`personal-${key}`} aria-selected={active===key}
        aria-current={active===key?"step":undefined} tabIndex={active===key?0:-1}
        aria-label={`${String(index+1).padStart(2,"0")} ${title}，${statuses[key]}`}
        className={`personal-flow-tab${completed[key]?" is-complete":""}`} onClick={()=>onSelect(key)}
        onKeyDown={event=>{
          const target=event.key==="ArrowRight"?(index+1)%3:event.key==="ArrowLeft"?(index+2)%3:event.key==="Home"?0:event.key==="End"?2:null;
          if(target===null)return;
          event.preventDefault();onSelect(personalFlowSteps[target].key);
          nav.current?.querySelector<HTMLButtonElement>(`#personal-tab-${personalFlowSteps[target].key}`)?.focus({preventScroll:true});
        }}>
        <span className="personal-flow-dot" aria-hidden="true">{completed[key]&&active!==key?<Check/>:String(index+1).padStart(2,"0")}</span>
        <span className="personal-flow-label"><span className="personal-flow-title-full">{title}</span><span className="personal-flow-title-short">{key==="input"?"输入内容":key==="prompt"?"确认方向":"调整笔记"}</span><small>{active===key?"当前 · ":""}{statuses[key]}</small></span>
      </button>)}
    </div>
    {running&&<div className="personal-flow-progress"><span role="status"><LoaderCircle className="spin"/>{running}</span>{onCancel&&<button type="button" className="text-button" onClick={onCancel}>取消本次操作</button>}</div>}
  </nav>;
}

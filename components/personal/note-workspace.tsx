"use client";
/* eslint-disable @next/next/no-img-element -- Draft images use existing local Blob URLs. */

import { XhsTitleEditor } from "@/components/xhs-title-editor";
import { isTitleWithinLimit } from "@/lib/xhs-title";
import * as React from "react";
import { AlignLeft, ArrowLeft, Images, RotateCcw, Sparkles, Type } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { PersonalInlineTags } from "./inline-tags";
import { PersonalCopyMenu } from "./copy-menu";
import { personalCaptionText } from "@/lib/personal/captions";
import { plainPersonalBody } from "@/lib/personal/note-format";
import { analyzeHashtags } from "@/lib/format";
import type { ContentResult } from "@/lib/schema";
import type { Generation, StudioImage } from "@/lib/types";
import type { PartialChoice } from "@/lib/partial-client";

export type PersonalResultProps = {
  generation: Generation | null;
  images: StudioImage[];
  busy: boolean;
  stale: boolean;
  researchControl?: ReactNode;
  onChange: (result: ContentResult) => void;
  onRegenerate: () => void;
  regenerateLabel?: string;
  onRewrite: () => void;
  onPartial: (choice: PartialChoice) => void;
  onError: (message: string) => void;
  onComplete?: () => void;
  completing?: boolean;
};

export function PersonalNoteEditor(props: PersonalResultProps & { onBack?: () => void; hideActions?: boolean }) {
  const { generation, images, busy, stale, researchControl, onChange, onRewrite, onPartial, onError } = props;
  const result = generation?.result;
  const bodyForCopy = result ? plainPersonalBody(result.body) : "";
  return <div className="personal-note" aria-busy={busy}>
    {!result ? <div className="personal-note-empty"><AlignLeft size={30}/><h3>在这里，把想法写完整</h3><p>先在第二步确认提示词，再生成笔记。<br/>标题、正文和话题会一起出现。</p></div> : <>
      {generation.mode === "demo" && <p className="storage-warning" role="status">固定演示样例，不代表已识别图片或完成真实生成。</p>}
      {stale && <p className="storage-warning" role="status">创作依据已更新，这里保留上次笔记和对应图片。</p>}
      <fieldset disabled={busy} className="personal-note-fields">
        <PersonalAssist {...props} section="titles"/>
        <div className="personal-card-heading personal-body-heading"><label htmlFor="result-body">笔记正文</label><div className="personal-inline-actions"><button type="button" className="text-button" onClick={onRewrite}><Sparkles/>AI 重写正文</button><CopyButton text={bodyForCopy} label="复制正文" onError={onError}/></div></div>
        <textarea id="result-body" className="personal-body-editor" rows={18} maxLength={8000} value={result.body} onChange={e=>onChange({...result,body:e.target.value})}/>
        <p className="personal-body-count">{Array.from(bodyForCopy.replace(/\s/gu,"")).length} 字符（不计空白与格式标记）· 修改后自动保存</p>
        <PersonalInlineTags value={result.hashtags} onChange={hashtags=>onChange({...result,hashtags})} onError={onError} onPartial={onPartial}/>
        <details className="personal-secondary"><summary><Type size={15}/>封面文案</summary><div className="personal-secondary-content"><div className="personal-inline-actions"><CopyButton text={`${result.coverCopy.headline}\n${result.coverCopy.subline}`} label="复制封面" onError={onError}/></div><label className="field">封面主标题<input value={result.coverCopy.headline} maxLength={150} onChange={e=>onChange({...result,coverCopy:{...result.coverCopy,headline:e.target.value}})}/></label><label className="field">封面副标题<input value={result.coverCopy.subline} maxLength={250} onChange={e=>onChange({...result,coverCopy:{...result.coverCopy,subline:e.target.value}})}/></label></div></details>
        {result.imageCaptions.length>0 && <details className="personal-secondary"><summary><Images size={15}/>逐图配文 <span>{result.imageCaptions.length} 张</span></summary><div className="personal-secondary-content"><button className="text-button" type="button" onClick={()=>onPartial({target:"captions_all"})}><Sparkles/>AI 重新生成全部配文</button>{result.imageCaptions.map((caption,index)=>{
          const image=images.find(item=>item.id===caption.imageId);
          const edit=(field:"headline"|"description",value:string)=>onChange({...result,imageCaptions:result.imageCaptions.map(old=>old.imageId===caption.imageId?{...old,[field]:value}:old)});
          return <article className="personal-caption" key={caption.imageId} data-testid="caption-row" data-image-id={caption.imageId}><div className="personal-caption-photo">{image&&<img src={image.preview} alt={`配文对应图片 ${index+1}：${image.file.name}`}/>}<span>图片 {index+1}</span></div><div className="personal-caption-fields"><div className="personal-caption-preview">{caption.headline&&<h3>{caption.headline}</h3>}<p>{caption.description}</p></div><details className="personal-caption-edit"><summary>编辑配文</summary><CaptionHeadlineField value={caption.headline} index={index} onChange={value=>edit("headline",value)}/><label className="field">配文<textarea aria-label={`图片 ${index+1} 补充说明`} rows={4} maxLength={700} value={caption.description} onChange={e=>edit("description",e.target.value)}/></label></details><div className="personal-inline-actions"><button type="button" className="text-button" aria-label={`AI 重写图片 ${index+1} 配文`} onClick={()=>onPartial({target:"caption_one",targetImageId:caption.imageId})}><Sparkles/>AI 重写</button><CopyButton text={personalCaptionText(caption)} label={`复制图片 ${index+1} 配文`} onError={onError}/></div></div></article>;
        })}</div></details>}
      </fieldset>
      {researchControl}
      {props.hideActions && generation.mode === "live" && <GenerationRecord generation={generation}/>}
      {result.warnings.length>0 && <aside className="personal-result-warnings"><h3>发布前请确认</h3><ul>{result.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></aside>}
      {!props.hideActions && <PersonalAssist {...props} section="actions"/>}
    </>}
  </div>;
}

export function PersonalAssist({ generation, busy, onChange, onRegenerate, onPartial, onError, section = "all", onBack, onComplete, completing, regenerateLabel, hideRecord }: PersonalResultProps & {section?: "all"|"titles"|"actions"; onBack?:()=>void; hideRecord?:boolean}) {
  const result=generation?.result, tagStatus=result?analyzeHashtags(result.hashtags):null;
  const canCopy=Boolean(result&&tagStatus?.valid);
  return <aside className="personal-assist" aria-label="创作辅助" aria-busy={busy}><fieldset disabled={busy}>
    {section!=="actions"&&<section className="personal-title-options"><div className="personal-card-heading"><h3>标题备选{result&&<span className="personal-title-count"> · {result.titles.length} 个</span>}</h3><button type="button" className="text-button" disabled={!result} onClick={()=>onPartial({target:"titles_all"})}><Sparkles/>AI 重新生成全部标题</button></div>
      {!result?<p className="personal-assist-empty">生成后可编辑、复制或重写标题。</p>:<div className="personal-titles">{result.titles.map((title,index)=><div className="personal-title-option" key={index}>
        <span className="personal-title-number" aria-hidden="true">{String(index+1).padStart(2,"0")}</span>
        <XhsTitleEditor multiline label={`标题 ${index+1}`} value={title} onChange={value=>onChange({...result,titles:result.titles.map((old,i)=>i===index?value:old)})}/>
        <div className="personal-title-actions"><button className="text-button" type="button" aria-label={`AI 重写标题 ${index+1}`} onClick={()=>onPartial({target:"title_one",targetIndex:index})}><Sparkles/>AI 重写</button><CopyButton text={title} disabled={!isTitleWithinLimit(title)} label={`复制标题 ${index+1}`} title={`复制标题 ${index+1}`} onError={onError}/></div>
      </div>)}</div>}
    </section>}
    {section!=="titles"&&<section className="personal-shortcuts"><div className="personal-shortcut-buttons">
      {onBack&&<button type="button" className="secondary-button personal-back" onClick={onBack}><ArrowLeft/>返回调整方向</button>}
      <div className="personal-final-actions">
        <PersonalCopyMenu result={result??null} disabled={!canCopy||busy} onError={onError}/>
        <button type="button" className="secondary-button" disabled={!result||busy} onClick={onRegenerate}><RotateCcw/>{regenerateLabel || "重新生成笔记"}</button>
        {onComplete&&<button type="button" className="generate-button personal-save-next" disabled={!result||busy||completing} onClick={onComplete}>{completing?"正在保存…":"保存并写下一篇"}</button>}
      </div>
    </div>{result&&!canCopy&&<p className="storage-warning" role="status">请整理为 10 个有效话题后复制；标题可单独复制。</p>}{!hideRecord&&generation?.mode==="live"&&<GenerationRecord generation={generation}/>}</section>}
  </fieldset></aside>;
}

function GenerationRecord({generation}:{generation:Generation}) {
  return <details className="personal-help"><summary>生成记录</summary><p>这份结果当时处理约 {(generation.meta.durationMs/1000).toFixed(1)} 秒。恢复历史内容不代表本次连接验证成功。</p></details>;
}

// Keep a legacy headline editable while it is being cleared; never reintroduce a
// title field for a newly generated paragraph-only caption.
function CaptionHeadlineField({value,index,onChange}:{value:string;index:number;onChange:(value:string)=>void}){
  const [focused,setFocused]=React.useState(false);
  return value||focused ? <label className="field">短标题<input aria-label={`图片 ${index+1} 短标题`} maxLength={150} value={value} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} onChange={e=>onChange(e.target.value)}/></label> : null;
}

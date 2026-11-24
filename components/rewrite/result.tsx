/* eslint-disable @next/next/no-img-element -- Local snapshot previews. */
import * as React from "react";
import type { PartialChoice, PartialResult } from "@/lib/partial-client";
import type { StudioImage } from "@/lib/types";

export const rewriteLabels = {body:"正文",title_one:"单个标题",titles_all:"全部标题",caption_one:"单张图片配文",captions_all:"全部图片配文",tag_one:"单个话题",tags_all:"全部话题"};
export function partialCopyText(output:PartialResult, images:StudioImage[]) {
  if(output.titles.length)return output.titles.join("\n");
  if(output.hashtags.length)return output.hashtags.join(" ");
  return output.imageCaptions.map(c=>`图片 ${images.findIndex(i=>i.id===c.imageId)+1}\n${c.headline}\n${c.description}`).join("\n\n");
}
export function RewriteResult({output,choice,images,selected,onSelect,paragraphCaptions=false}: {output:PartialResult;choice:PartialChoice;images:StudioImage[];selected:number;onSelect:(index:number)=>void;paragraphCaptions?:boolean}) {
  if(choice.target==="title_one"||choice.target==="tag_one")return <fieldset className="rw-candidates"><legend>选择一个候选，再点击「使用此结果」</legend>{(choice.target==="title_one"?output.titles:output.hashtags).map((text,i)=><label key={i}><input type="radio" name="rewrite-candidate" checked={selected===i} onChange={()=>onSelect(i)}/><span>{text}</span></label>)}</fieldset>;
  if(choice.target==="titles_all")return <ol className="rw-list">{output.titles.map((t,i)=><li key={i}>{t}</li>)}</ol>;
  if(choice.target==="tags_all")return <div className="rw-tags">{output.hashtags.map(t=><span key={t}>{t}</span>)}</div>;
  return <div>{output.imageCaptions.map(c=>{const index=images.findIndex(i=>i.id===c.imageId),image=images[index];return <section className="rw-caption" key={c.imageId}>{image&&<img src={image.preview} alt={`配文对应图片 ${index+1}`}/>}<div><h3>图片 {index+1}{(!paragraphCaptions||c.headline)&&` · ${c.headline}`}</h3><p className="rw-text">{c.description}</p></div></section>;})}</div>;
}

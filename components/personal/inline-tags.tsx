"use client";

import * as React from "react";
import { ListFilter, Plus, Sparkles, X } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { analyzeHashtags, formatHashtags } from "@/lib/format";
import { finishPersonalTag, personalTagsCanRewriteOne, personalTagEntries } from "@/lib/personal/note-format";
import type { PartialChoice } from "@/lib/partial-client";

type Props = {
  value: string[]; onChange: (tags: string[]) => void;
  onError: (message: string) => void; onPartial: (choice: PartialChoice) => void;
};

export function PersonalInlineTags(props: Props) {
  // Only a presentation flag: no second text value. First edit materializes legacy rows
  // into the same draft field; subsequent keystrokes are never split or normalized.
  const [edited, setEdited] = React.useState(false);
  const value = edited ? props.value : personalTagEntries(props.value);
  return <PersonalTagFields {...props} value={value} onChange={tags=>{setEdited(true);props.onChange(tags);}}/>;
}

/** The draft's raw array is the only editing value; unfinished entries also autosave. */
export function PersonalTagFields({ value, onChange, onError, onPartial }: Props) {
  const tags = analyzeHashtags(value), canRewrite = personalTagsCanRewriteOne(value);
  const message = tags.invalidCount ? "有话题含无效字符，请修改；已保留原输入。"
    : tags.count < 10 ? `还需补充 ${10 - tags.count} 个不同话题。`
      : tags.count > 10 ? `请删减 ${tags.count - 10} 个话题。`
        : tags.duplicateCount ? `有 ${tags.duplicateCount} 个重复项，可整理去重。`
          : !canRewrite ? "可复制；整理为逐个话题后可单项重写。"
            : "点击话题文字直接修改；复制时统一用空格分隔。";
  function change(index: number, text: string) { onChange(value.map((tag, i) => i === index ? text : tag)); }
  function tidy() {
    if (tags.invalidCount) { onError("请先修改无效字符；未整理或丢弃原输入。"); return; }
    if (tags.count > 12) { onError("话题过多，请先删减至 10 个；原输入已保留。"); return; }
    onChange(tags.tags);
  }
  return <section className="personal-inline-tags" aria-labelledby="personal-tags-title">
    <div className="personal-card-heading"><h3 id="personal-tags-title">话题 <span className="hashtag-count" aria-live="polite">{tags.count} / 10</span></h3><div className="personal-inline-actions">
      <button type="button" className="text-button" onClick={tidy} disabled={!value.length}><ListFilter/>整理格式与去重</button>
      <button type="button" className="text-button" onClick={()=>onPartial({target:"tags_all"})}><Sparkles/>重新生成全部话题</button>
      <CopyButton text={formatHashtags(value)} label="复制话题" disabled={!tags.valid} describedBy="personal-tags-help" onError={onError}/>
    </div></div>
    <div className="personal-tag-fields">{value.map((tag,index)=><div className="personal-tag-field" key={index}>
      <input aria-label={`话题 ${index+1}`} value={tag} maxLength={800} size={Math.max(7,Math.min(24,Array.from(tag).length*2))} placeholder="#输入话题" aria-describedby="personal-tags-help"
        onChange={e=>change(index,e.target.value)} onBlur={()=>{const next=finishPersonalTag(tag);if(next!==tag)change(index,next);}}/>
      <button type="button" className="text-button personal-icon-action" aria-label={`AI 重写话题 ${index+1}`} title="AI 重写此话题" disabled={!canRewrite} onClick={()=>onPartial({target:"tag_one",targetIndex:index})}><Sparkles/></button>
      <button type="button" className="text-button personal-icon-action" aria-label={`删除话题 ${index+1}`} title="删除此话题" onClick={()=>onChange(value.filter((_,i)=>i!==index))}><X/></button>
    </div>)}<button type="button" className="text-button personal-add-tag" disabled={value.length>=12} onClick={()=>onChange([...value,""])}><Plus/>添加话题</button></div>
    <p id="personal-tags-help" className="personal-small-note" role="status">{message}{value.length>=12?" 最多暂存 12 项，请删除多余项。":""}</p>
  </section>;
}

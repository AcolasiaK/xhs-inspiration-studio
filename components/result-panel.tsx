"use client";
/* eslint-disable @next/next/no-img-element -- Uploaded images use local object URLs, not an image service. */

import { XhsTitleEditor } from "@/components/xhs-title-editor";
import { isTitleWithinLimit } from "@/lib/xhs-title";
import * as React from "react";
import { AlignLeft, CircleAlert, Hash, Images, RefreshCw, Sparkles, Type } from "lucide-react";
import { CopyButton } from "./copy-button";
import { EmptyResult } from "./empty-result";
import { editableHashtags } from "./hashtag-text";
import { analyzeHashtags, formatAll, formatHashtags, formatNote } from "@/lib/format";
import type { ContentResult } from "@/lib/schema";
import type { Generation, StudioImage } from "@/lib/types";
import type { PartialChoice } from "@/lib/partial-client";
import type { ReactNode } from "react";

type Props = {
  generation: Generation | null; images: StudioImage[]; busy: boolean; stale: boolean;
  selectedTitleIndex: number; onSelectTitle: (index: number) => void;
  titleReview: boolean;
  hideEmptyCaptions?: boolean;
  paragraphCaptions?: boolean;
  compactGuidance?: boolean;
  emptyContent?: ReactNode;
  researchControl?: ReactNode;
  onChange: (result: ContentResult) => void; onRegenerate: () => void; onRewrite: () => void; onPartial: (choice: PartialChoice) => void; onError: (message: string) => void;
};

export function HashtagEditor({ value, onChange, onError, onPartial, compact = false }: { compact?: boolean; value: string[]; onChange: (tags: string[]) => void; onError: (message: string) => void; onPartial: (choice: PartialChoice) => void }) {
  // 编辑时保留原始输入和光标；只有失焦或用户主动整理时才统一前缀。
  const text = value.length === 1 ? value[0] : editableHashtags(value);
  const tags = analyzeHashtags(text);
  const message = tags.invalidCount ? `有 ${tags.invalidCount} 个话题含无法使用的字符，请在上方修改；原文字仍保留。`
    : tags.count < 10 ? `还需补充 ${10 - tags.count} 个不同的话题，结合图片和正文手动填写。`
      : tags.count > 10 ? `已有 ${tags.count} 个不同话题，请删减 ${tags.count - 10} 个。`
        : tags.duplicateCount ? `已识别 10 个有效话题，发现 ${tags.duplicateCount} 个重复项；复制时会去重。`
          : "已满足 10 个不同话题，可直接复制。";
  function change(next: string) { onChange([next]); }
  if (compact) return <section className="personal-card personal-tags" aria-labelledby="personal-tags-title">
    <div className="personal-card-heading"><h2 id="personal-tags-title"><Hash size={16} />话题标签</h2><CopyButton text={formatHashtags(text)} label="复制话题" disabled={!tags.valid} describedBy="hashtag-help" onError={onError}/></div>
    <div className="personal-tag-chips" aria-label="单个话题重写">{tags.tags.map((tag,index)=><button type="button" key={tag} disabled={!tags.valid||tags.duplicateCount>0} onClick={()=>onPartial({target:"tag_one",targetIndex:index})} aria-label={`AI 重写话题 ${tag}`} title="AI 重写这个话题">{tag}<span aria-hidden="true">↻</span></button>)}</div>
    <div className="hashtag-meta"><span className={tags.valid?"hashtag-count valid":"hashtag-count needs-work"} aria-live="polite">有效话题 {tags.count} / 10</span><button type="button" className="text-button" onClick={()=>onPartial({target:"tags_all"})}>AI 重新生成全部标签</button></div>
    <details className="personal-edit-tags"><summary>编辑话题</summary><label htmlFor="hashtags" className="sr-only">话题标签</label><textarea id="hashtags" value={text} onChange={e=>change(e.target.value)} onBlur={()=>{const next=editableHashtags(text);if(next!==text)change(next);}} rows={4} maxLength={800} aria-describedby="hashtag-help"/><button type="button" className="text-button" disabled={tags.invalidCount>0||!text.trim()} onClick={()=>change(tags.tags.join(" "))}>整理标签格式</button></details>
    <p id="hashtag-help" className="personal-small-note" role={!tags.valid?"status":undefined}>{tags.valid&&!tags.duplicateCount?"点击标签可单独 AI 重写；复制时自动用空格分隔。":message}</p>
    {tags.duplicateCount>0&&<p className="personal-small-note">先整理重复项，再单独重写话题。</p>}
  </section>;
  return <section className="result-section" aria-labelledby="hashtag-title">
    <div className="result-section-heading"><h3 id="hashtag-title"><Hash size={16} />相关话题</h3><div className="body-actions"><button type="button" className="secondary-button" onClick={() => onPartial({target:"tags_all"})}>AI 重新生成全部标签</button><CopyButton text={formatHashtags(text)} label="复制话题" disabled={!tags.valid} describedBy="hashtag-help" onError={onError} /></div></div>
    <label htmlFor="hashtags" className="sr-only">话题标签</label>
    <textarea id="hashtags" className="hashtag-editor" value={text} onChange={(event) => change(event.target.value)}
      onBlur={() => { const next = editableHashtags(text); if (next !== text) change(next); }} rows={3} maxLength={800} aria-describedby="hashtag-help" />
    <div className="hashtag-meta"><span className={tags.valid ? "hashtag-count valid" : "hashtag-count needs-work"} aria-live="polite">有效话题 {tags.count} / 10</span>
      <button type="button" className="text-button" disabled={tags.invalidCount > 0 || !text.trim()} onClick={() => change(tags.tags.join(" "))}>整理标签格式</button></div>
    <p id="hashtag-help" className="field-hint">{message} 用空格或逗号分隔；整理会去除重复项，每个话题只保留一个 #。</p>
    {text && <p className="hashtag-preview"><span>复制预览：</span>{formatHashtags(text) || "尚无有效话题"}</p>}
    {tags.tags.length > 0 && <div className="partial-tag-list" aria-label="单个话题重写">{tags.tags.map((tag, index) => <button type="button" className="text-button" key={tag} disabled={!tags.valid || tags.duplicateCount > 0} onClick={() => onPartial({target:"tag_one",targetIndex:index})} aria-label={`AI 重写话题 ${tag}`}>{tag} · AI 重写</button>)}</div>}
    {tags.duplicateCount > 0 && <p className="field-hint">单个话题重写前，请先整理重复项；也可选择重新生成全部标签。</p>}
  </section>;
}

export function ResultPanel({ generation, images, busy, stale, selectedTitleIndex, titleReview, hideEmptyCaptions = false, paragraphCaptions = false, compactGuidance = false, emptyContent, researchControl, onSelectTitle, onChange, onRegenerate, onRewrite, onPartial, onError }: Props) {
  const result = generation?.result;
  const copying = { onError };
  const tagStatus = result ? analyzeHashtags(result.hashtags) : null;
  const canCopyNote = Boolean(result && tagStatus?.valid && result.titles[selectedTitleIndex]?.trim() && isTitleWithinLimit(result.titles[selectedTitleIndex]));
  return <section className="result-panel" id="results" aria-labelledby="result-title" aria-busy={busy}>
    <div className="result-top"><div><div className="result-heading"><Sparkles size={18} /><h2 id="result-title">{result?"笔记结果":"笔记预览"}</h2>{result && <span className="result-badge">{generation?.mode === "demo" ? "演示样例" : "已生成"}</span>}</div></div>{result ? <div className="result-top-actions"><CopyButton text={canCopyNote ? formatNote(result, selectedTitleIndex) : ""} label="复制完整笔记" className="copy-all" disabled={!canCopyNote} describedBy="copy-note-help" {...copying} /><CopyButton text={formatAll(result)} label="复制全部文案" disabled={!tagStatus?.valid || !result.titles.every(isTitleWithinLimit)} describedBy="copy-note-help" {...copying} /></div> : null}</div>
    {!result ? emptyContent ?? <EmptyResult /> : <div className="result-content" inert={busy}>
      {generation?.mode === "demo" && <div className="demo-result-note"><CircleAlert size={16} /><span>这是固定咖啡主题样例，未识别你的图片或使用表单要求。可自由编辑体验。</span></div>}
      {generation?.mode === "live" && !compactGuidance && <div className="stale-note" role="status">真实生成记录 · 当时处理约 {(generation.meta.durationMs / 1000).toFixed(1)} 秒。恢复历史内容不代表本次 API 连接验证成功，{hideEmptyCaptions ? "请确认内容与实际经历相符。" : "请按原图确认文字内容。"}</div>}
      {stale && <div className="stale-note" role="status">输入或图片已调整。下方保留上次结果及其对应图片，重新生成后更新。</div>}
      {compactGuidance?<><details className="personal-help personal-result-help"><summary>复制说明与生成记录</summary><p id={canCopyNote?"copy-note-help":undefined}>完整笔记包含选中标题、正文和 10 个话题；全部文案还包括封面和逐图配文。</p>{generation?.mode==="live"&&<p>这份结果当时处理约 {(generation.meta.durationMs/1000).toFixed(1)} 秒。恢复历史内容不代表本次连接验证成功，发布前请确认事实。</p>}</details>{!canCopyNote&&<p id="copy-note-help" className="copy-note-help" role="status">请选择 20 字以内的非空标题，并保留 10 个有效话题后复制。</p>}</>:<p id="copy-note-help" className="copy-note-help">{canCopyNote ? "完整笔记包含选中标题、正文和 10 个话题；复制全部文案还包含封面和逐图配文。" : "请选择 20 字以内的非空标题，并保留 10 个有效话题后复制。"}</p>}
      <section className="result-section"><div className="result-section-heading"><h3><Type size={16} />标题灵感<span>选择一个标题组合完整笔记</span></h3><button type="button" className="secondary-button" onClick={() => onPartial({target:"titles_all"})}>AI 重新生成全部标题</button></div>{titleReview && <p className="storage-warning" role="status">标题已更新，当前暂选第 1 项，请重新选择用于发布的标题。</p>}<div className="titles-list" role="radiogroup" aria-label="选择完整笔记的标题">{result.titles.map((title, index) => <div className={`title-row ${selectedTitleIndex === index ? "selected" : ""}`} key={index}>
        <label className="title-radio"><input type="radio" name="selected-title" aria-label={`选择标题 ${index + 1}`} checked={selectedTitleIndex === index} onClick={() => { if (titleReview && selectedTitleIndex === index) onSelectTitle(index); }} onChange={() => onSelectTitle(index)} /><span className="title-index">0{index + 1}</span></label>
        <XhsTitleEditor label={`标题 ${index + 1}`} value={title} onChange={value => onChange({ ...result, titles: result.titles.map((old, i) => i === index ? value : old) })} /><button type="button" className="text-button" aria-label={`AI 重写标题 ${index + 1}`} onClick={() => onPartial({target:"title_one",targetIndex:index})}>AI 重写</button><CopyButton text={title} disabled={!isTitleWithinLimit(title)} label={`复制标题 ${index + 1}`} className="icon-copy" {...copying} /></div>)}</div></section>
      <section className="result-section"><div className="result-section-heading"><h3><Type size={16} />封面文案</h3><CopyButton text={`${result.coverCopy.headline}\n${result.coverCopy.subline}`} label="复制封面" {...copying} /></div><div className="cover-edit"><label htmlFor="cover-headline">主标题</label><input id="cover-headline" value={result.coverCopy.headline} onChange={(e) => onChange({ ...result, coverCopy: { ...result.coverCopy, headline: e.target.value } })} maxLength={150} /><label htmlFor="cover-subline">副标题</label><input id="cover-subline" value={result.coverCopy.subline} onChange={(e) => onChange({ ...result, coverCopy: { ...result.coverCopy, subline: e.target.value } })} maxLength={250} /></div></section>
      {(!hideEmptyCaptions || result.imageCaptions.length > 0) && <section className="result-section"><div className="result-section-heading"><h3><Images size={16} />逐图配文<span>让每张照片都有话可说</span></h3><button type="button" className="secondary-button" onClick={() => onPartial({target:"captions_all"})}>AI 重新生成全部配文</button></div><div className="caption-list">{result.imageCaptions.map((caption, index) => {
        const image = images.find((item) => item.id === caption.imageId);
        const edit = (field: "headline" | "description", value: string) => onChange({ ...result, imageCaptions: result.imageCaptions.map((old) => old.imageId === caption.imageId ? { ...old, [field]: value } : old) });
        return <div className="caption-row" key={caption.imageId} data-testid="caption-row" data-image-id={caption.imageId}>
          <div className="caption-image">{image && <img src={image.preview} alt={`配文对应图片 ${index + 1}：${image.file.name}`} />}<span>0{index + 1}</span></div><div className="caption-edit">{(!paragraphCaptions || caption.headline) && <input aria-label={`图片 ${index + 1} 短标题`} value={caption.headline} onChange={(e) => edit("headline", e.target.value)} maxLength={150} />}<textarea aria-label={`图片 ${index + 1} 补充说明`} value={caption.description} onChange={(e) => edit("description", e.target.value)} rows={2} maxLength={700} /><div className="body-actions"><button type="button" className="text-button" aria-label={`AI 重写图片 ${index + 1} 配文`} onClick={() => onPartial({target:"caption_one",targetImageId:caption.imageId})}>AI 重写</button><CopyButton text={`${caption.headline}\n${caption.description}`} label={`复制图片 ${index + 1} 配文`} {...copying} /></div></div>
        </div>;
      })}</div></section>}
      <section className="result-section"><div className="result-section-heading"><h3><AlignLeft size={16} />笔记正文</h3><div className="body-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onRewrite}><Sparkles size={14} />AI 重写正文</button><CopyButton text={result.body} label="复制正文" {...copying} /></div></div><label htmlFor="result-body" className="sr-only">笔记正文</label><textarea id="result-body" className="body-editor" value={result.body} onChange={(e) => onChange({ ...result, body: e.target.value })} rows={12} maxLength={8000} /><span className="char-count">{Array.from(result.body.replace(/\s/gu, "")).length} 字符（不计空白）· 可直接修改</span></section>
      <HashtagEditor key={`${generation!.mode}-${generation!.meta.completedAt}`} value={result.hashtags} onChange={(hashtags) => onChange({ ...result, hashtags })} onError={onError} onPartial={onPartial} />
      {researchControl}
      {result.warnings.length > 0 && <aside className="warnings"><h3><CircleAlert size={15} />发布前，确认一下</h3><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></aside>}
      <div className="result-bottom"><span>所有文字均可编辑，复制的是最新内容。</span><button type="button" className="secondary-button" disabled={busy} onClick={onRegenerate}><RefreshCw size={14} />重新生成</button></div>
    </div>}
  </section>;
}

import { isTitleWithinLimit } from "@/lib/xhs-title";
import { useId, useState, type ReactNode } from "react";
import { useCloud } from "@/components/cloud/context";
import { Clock3, Film, Sparkles } from "lucide-react";
import { CopyButton } from "../copy-button";
import { analyzeHashtags, formatHashtags } from "@/lib/format";
import { formatShot, formatVideoPlan, timelineIssue, materialsOf, type VideoPlan } from "@/lib/video/schema";
import type { VideoGeneration } from "@/lib/video/drafts";
import { PlanEditButton, PlanText } from "./plan-reading";
import { PlanEditor, type PlanEditTarget } from "./plan-editor";
import "./plan.css";

type Section = "shots" | "publishing" | "preparation" | "sound" | "warnings";
export function VideoResults({ generation, disabled, stale, saveStatus, saveError, onRetrySave, onChange, onRewrite, onRegenerate, onError }: {
  generation: VideoGeneration | null; disabled: boolean; stale: boolean; saveStatus: string; saveError: string;
  onRetrySave: () => void; onChange: (plan: VideoPlan) => void; onRewrite: (id: string) => void; onRegenerate: () => void; onError: (message: string) => void;
}) {
  const { cloud } = useCloud();
  
  const [section, setSection] = useState<Section>("shots");
  const [editing, setEditing] = useState<PlanEditTarget | null>(null);
  const id = useId();
  if (!generation) return <section className="video-card video-empty"><h2>视频方案</h2><p>仅文字策划，不解析或自动剪辑视频。</p></section>;
  const p = generation.result, phase = generation.input.phase, duration = generation.input.brief.duration;
  const timing = timelineIssue(p.shots, duration), tags = analyzeHashtags(p.hashtags), materials = materialsOf(generation.input.footage);
  const hasTags = phase === "after" || p.hashtags.length > 0;
  const hasBody = phase === "after" || Boolean(p.body);
  const completeValid = !timing && (!hasTags || tags.valid);
  const warnings = p.warnings.filter(w => w.trim());
  const sections: { key: Section; label: string }[] = phase === "before"
    ? [{ key: "shots", label: "拍摄步骤" }, { key: "publishing", label: "标题与封面" }, { key: "preparation", label: "拍摄准备" }, { key: "sound", label: "节奏与声音" }, { key: "warnings", label: `待核实 ${warnings.length}` }]
    : [{ key: "shots", label: "剪辑步骤" }, { key: "sound", label: "剪辑与声音" }, { key: "publishing", label: "发布内容" }, { key: "preparation", label: "准备与注意" }, { key: "warnings", label: `待核实 ${warnings.length}` }];
  const copyProps = { onError, disabled };
  const edit = (target: PlanEditTarget, label: string) => <PlanEditButton label={label} disabled={disabled} onClick={() => setEditing(target)} />;
  function heading(title: string, actions: ReactNode) { return <div className="plan-heading"><h3>{title}</h3><div className="plan-actions">{actions}</div></div>; }
  return <section className="video-card video-results" aria-label={phase === "before" ? "拍摄脚本方案区" : "剪辑方案区"}>
    <header className="plan-header">
      <div><div className="video-section-kicker">02 / YOUR PLAN</div><h2>{phase === "before" ? "拍摄脚本" : "剪辑方案"}</h2><div className="plan-meta"><span><Clock3 size={15} />成片 {duration} 秒</span><span><Film size={15} />{p.shots.length} 个镜头</span></div></div>
      <CopyButton text={formatVideoPlan(p, phase)} label={phase === "before" ? "复制整份拍摄脚本" : "复制整份剪辑方案"} {...copyProps} disabled={disabled || !completeValid || !p.titles.every(isTitleWithinLimit)} />
    </header>
    <p className={`plan-save ${saveError ? "plan-save-error" : ""}`} role="status">{saveStatus}{generation.edited && " · 已含手动编辑"}</p>
    {saveError && <div className="video-error" role="alert">{saveError} 当前页面内容保留，请先重试保存再离开。<button type="button" className="text-button" onClick={onRetrySave} disabled={disabled}>重试保存</button></div>}
    {stale && <p className="video-notice">输入已改变，下面保留上次方案。单镜头重写使用上次生成时的要求及素材，整份重新生成使用当前输入。</p>}
    {timing && <p className="video-error" role="alert">{timing} 请修正时间后复制整份方案。</p>}
    {hasTags && !tags.valid && <div className="video-error" role="alert">有效标签 {tags.count} / 10，请补齐或删减至 10 个有效且不重复的话题。原输入保留。<button type="button" className="text-button" disabled={disabled} onClick={() => setEditing({ kind: "hashtags" })}>修正标签</button></div>}
    <details className="video-basis"><summary>查看本方案的创作依据</summary><p>主题：{generation.input.brief.topic}；风格：{generation.input.brief.writingStyle ? `${generation.input.brief.writingStyle.content.name} · v${generation.input.brief.writingStyle.version}` : generation.input.brief.style} {generation.input.brief.customStyle}</p>{phase === "after" ? <ol>{materials.map((m, i) => <li key={m.id}>第 {i + 1} 段：{m.description}</li>)}</ol> : <p>拍摄场景：{generation.input.brief.location || "未指定"}</p>}<p>补充要求：{generation.input.brief.details || "未填写"}</p></details>
    <section className="plan-overview" aria-label="方案概览">
      {heading("方案概览", <>{edit({ kind: "overview" }, "编辑方案概览")}<CopyButton text={`核心思路：${p.coreIdea}\n\n推荐开头：${p.opening}`} label="复制概览" {...copyProps} /></>)}
      <PlanText text={p.coreIdea} collapsible />
      <div className="plan-opening"><span className="plan-label">推荐开头</span><PlanText text={p.opening} collapsible /></div>
    </section>
    <div className="plan-tabs" role="tablist" aria-label="方案内容分区" onKeyDown={e => {
      const index = sections.findIndex(item => item.key === section);
      const next = e.key === "ArrowRight" ? (index + 1) % sections.length : e.key === "ArrowLeft" ? (index - 1 + sections.length) % sections.length : e.key === "Home" ? 0 : e.key === "End" ? sections.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault(); setSection(sections[next].key);
      (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
    }}>{sections.map(item => <button type="button" key={item.key} id={`${id}-${item.key}`} role="tab" aria-selected={section === item.key} aria-controls={`${id}-panel`} tabIndex={section === item.key ? 0 : -1} onClick={() => setSection(item.key)}>{item.label}</button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${section}`} tabIndex={0} className="plan-panel">
      {section === "shots" && <>
        <div className="plan-section-intro"><h3>逐镜头{phase === "before" ? "拍摄" : "剪辑"}步骤</h3><p>按编号{phase === "before" ? "准备画面与拍法" : "选择素材并安排剪辑"}。时间均为成片安排。</p></div>
        <ol className="plan-steps">{p.shots.map((shot, i) => <li key={shot.shotId}><article className="plan-step" data-testid="video-shot" aria-label={`镜头 ${i + 1}`}>
          <header className="plan-step-header"><h4><span className="plan-step-number">{String(i + 1).padStart(2, "0")}</span>镜头 {String(i + 1).padStart(2, "0")}</h4><span className="plan-step-time">成片 <strong>{shot.start}～{shot.end}</strong> 秒</span></header>
          <div className="plan-visual"><span className="plan-label">{phase === "before" ? "画面 · 拍什么" : "画面 · 选什么素材"}</span><PlanText text={shot.visual} /></div>
          <dl className="plan-step-details">
            {phase === "after" && <div><dt>素材依据</dt><dd>{shot.materialIds.length ? shot.materialIds.map(materialId => <p key={materialId}>{materials.find(m => m.id === materialId)?.description ? `第 ${materials.findIndex(m => m.id === materialId) + 1} 段：${materials.find(m => m.id === materialId)?.description}` : "素材未匹配，请核对创作依据"}</p>) : "未指定素材，请核对创作依据"}</dd></div>}
            <div><dt>{phase === "before" ? "拍法" : "画面处理"}</dt><dd><PlanText text={shot.method} /></dd></div>
            <div><dt>旁白</dt><dd><PlanText text={shot.voice} empty="未填写；如不需要说话，可编辑标注为“不需要”。" /></dd></div>
            <div><dt>字幕</dt><dd><PlanText text={shot.subtitle} /></dd></div>
            <div><dt>剪辑</dt><dd><PlanText text={shot.editing} /></dd></div>
          </dl>
          <footer className="plan-actions">{edit({ kind: "shot", id: shot.shotId }, `编辑镜头 ${i + 1}`)}<CopyButton text={formatShot(shot, i)} label={`复制镜头 ${i + 1}`} {...copyProps} /><button type="button" className="secondary-button" disabled={disabled} onClick={() => onRewrite(shot.shotId)} aria-label={`AI 重写镜头 ${i + 1}`}><Sparkles size={14} />AI 重写</button></footer>
        </article></li>)}</ol>
      </>}
      {section === "publishing" && <>
        <section className="plan-block">{heading("参考标题", <>{edit({ kind: "titles" }, "编辑参考标题")}<CopyButton text={p.titles.join("\n")} label="复制所有标题" {...copyProps} disabled={disabled || !p.titles.every(isTitleWithinLimit)} /></>)}<ol className="plan-title-list">{p.titles.map((title, i) => <li key={i}><span className="plan-title-index">{String(i + 1).padStart(2, "0")}</span><PlanText text={title} /><CopyButton text={title} label={`复制视频标题 ${i + 1}`} {...copyProps} disabled={disabled || !isTitleWithinLimit(title)} /></li>)}</ol></section>
        <section className="plan-block">{heading("封面文案与画面", <>{edit({ kind: "cover" }, "编辑封面文案")}<CopyButton text={[p.cover.headline, p.cover.subline, p.cover.visualIdea].join("\n")} label="复制视频封面" {...copyProps} /></>)}<dl className="plan-reading-list">{([['headline', '主标题'], ['subline', '副标题'], ['visualIdea', '封面画面']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><PlanText text={p.cover[key]} /></dd></div>)}</dl></section>
        {hasBody && <section className="plan-block">{heading("发布正文", <>{edit({ kind: "body" }, "编辑发布正文")}<CopyButton text={p.body} label="复制视频正文" {...copyProps} /></>)}<PlanText text={p.body} collapsible /></section>}
        {hasTags && <section className="plan-block">{heading("话题标签", <>{edit({ kind: "hashtags" }, "编辑话题标签")}<CopyButton text={formatHashtags(p.hashtags)} label="复制视频标签" {...copyProps} disabled={disabled || !tags.valid} /></>)}<p className="plan-hashtags">{formatHashtags(p.hashtags) || "暂无标签，请编辑补充"}</p><p className="plan-help">有效标签 {tags.count} / 10{!tags.valid && " · 请通过编辑修正，原输入仍保留"}</p></section>}
      </>}
      {section === "preparation" && <section className="plan-block">{heading(phase === "before" ? "拍摄准备和注意事项" : "素材准备和注意事项", <>{edit({ kind: "preparation" }, "编辑准备与注意事项")}<CopyButton text={`准备：${p.preparation}\n\n注意事项：${p.notes}`} label="复制准备事项" {...copyProps} /></>)}<dl className="plan-reading-list"><div><dt>提前准备</dt><dd><PlanText text={p.preparation} /></dd></div><div><dt>注意事项</dt><dd><PlanText text={p.notes} /></dd></div></dl></section>}
      {section === "sound" && <section className="plan-block">{heading("转场、节奏与声音", <>{edit({ kind: "sound" }, "编辑剪辑与声音")}<CopyButton text={`转场：${p.editingAdvice.transitions}\n\n节奏：${p.editingAdvice.rhythm}\n\n原声：${p.editingAdvice.originalAudio}\n\n音乐：${p.editingAdvice.music}`} label="复制剪辑与声音" {...copyProps} /></>)}<dl className="plan-reading-list">{([['transitions', '转场'], ['rhythm', '节奏'], ['originalAudio', '原声'], ['music', '音乐氛围']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd><PlanText text={p.editingAdvice[key]} /></dd></div>)}</dl></section>}
      {section === "warnings" && <section className="plan-block">{heading("需要核实的信息", <>{edit({ kind: "warnings" }, "编辑需要核实的信息")}<CopyButton text={p.warnings.join("\n")} label="复制待核实信息" {...copyProps} /></>)}{warnings.length ? <ul className="plan-warnings">{warnings.map((warning, i) => <li key={i}><PlanText text={warning} /></li>)}</ul> : <p className="plan-help">本方案未列出待核实项。发布前仍请自行确认事实与素材使用条件。</p>}</section>}
    </div>
    <footer className="plan-footer"><p className="plan-help">编辑会自动保存到{cloud ? "云端" : "本机"}。AI 重写与重新生成均先预览，确认后才替换，{"产生 API 用量"}。</p><button type="button" className="secondary-button" disabled={disabled} onClick={onRegenerate}><Sparkles size={14} />重新生成整份{phase === "before" ? "拍摄脚本" : "剪辑方案"}</button></footer>
    {editing && <PlanEditor target={editing} plan={p} duration={duration} phase={phase} disabled={disabled} status={saveStatus} saveError={saveError} onRetry={onRetrySave} onChange={onChange} onClose={() => setEditing(null)} />}
  </section>;
}

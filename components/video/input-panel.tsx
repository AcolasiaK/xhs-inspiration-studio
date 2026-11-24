import { VIDEO_TYPES, type VideoBrief, type Footage } from "@/lib/video/schema";
import { WritingStylePicker } from "../writing-style-picker";
import { TextField, SelectField } from "./fields";
import type { VideoDraft } from "@/lib/video/drafts";

export function VideoInput({ draft, disabled, onChange, onManageStyles }: { draft: VideoDraft; disabled: boolean; onChange: (draft: VideoDraft) => void; onManageStyles: () => void }) {
  const b = draft.brief, f = draft.footage;
  const brief = (key: keyof VideoBrief, value: VideoBrief[keyof VideoBrief]) => onChange({ ...draft, brief: { ...b, [key]: value } });
  const footage = (key: keyof Footage, value: string) => onChange({ ...draft, footage: { ...f, [key]: value } });
  return <fieldset disabled={disabled} className="video-card video-input">
    <h2>{draft.phase === "before" ? "先说说，想拍什么？" : "记录已经拍到的素材"}</h2>
    <TextField label="视频选题或主题" required value={b.topic} onChange={v => brief("topic", v)} max={100} placeholder="例如：用一分钟记录周末的湖边散步" />
    {draft.phase === "after" && <>
      <TextField label="实际拍到的素材" required multiline max={5000} value={f.materials} onChange={v => footage("materials", v)} placeholder={"建议每段一行，例如：\n景区大门\n坐船过程\n湖面日落"} />
      <p className="video-hint">只以实际素材为依据，时间安排为成片时间。{draft.before && "拍摄计划中的镜头不代表已经拍到。"}</p>
    </>}
    <TextField label="想表达的内容或补充要求" multiline value={b.details} onChange={v => brief("details", v)} placeholder="想让观众记住什么？有哪些已确认的信息？" />
    <WritingStylePicker value={b.writingStyle} disabled={disabled} onChange={snapshot => brief("writingStyle", snapshot)} onManage={onManageStyles} />
    <details className="video-input-options"><summary>视频设置<span>{b.duration} 秒{b.writingStyle ? ` · ${b.writingStyle.content.name}` : ""}</span></summary>
      <TextField label="拍摄地点或场景" value={b.location} onChange={v => brief("location", v)} max={200} placeholder="不确定具体地点可以留空" />
      <div className="video-two"><SelectField label="视频类型" value={b.type} onChange={v => brief("type", v)}>{VIDEO_TYPES.map(v => <option key={v}>{v}</option>)}</SelectField><SelectField label="是否真人出镜" value={b.onCamera} onChange={v => brief("onCamera", v)}>{["不出镜", "出镜", "部分出镜", "待定"].map(v => <option key={v}>{v}</option>)}</SelectField></div>
      <div className="video-duration"><span>期望成片时长</span><div className="video-duration-options">{[15, 30, 60, 90, 180].map(v => <button type="button" className={b.duration === v ? "is-selected" : ""} key={v} aria-pressed={b.duration === v} onClick={() => brief("duration", v)}>{v < 60 ? `${v} 秒` : `${v / 60} 分钟`}</button>)}</div><label>自定义时长（10～600 秒）<input type="number" required min={10} max={600} step={1} value={b.duration || ""} onChange={e => brief("duration", Number(e.target.value))} /></label></div>
      <TextField label="本次风格补充" multiline max={1000} value={b.customStyle} onChange={v => brief("customStyle", v)} placeholder="例如：多留环境声，口播像朋友聊天。" />
      <TextField label="目标观众" value={b.audience} onChange={v => brief("audience", v)} max={200} />
      <div className="video-two"><TextField label="必须提到的内容" multiline value={b.mustInclude} onChange={v => brief("mustInclude", v)} max={500} placeholder="多项用逗号分隔" /><TextField label="禁止出现的内容" multiline value={b.forbidden} onChange={v => brief("forbidden", v)} max={500} placeholder="多项用逗号分隔" /></div>
    </details>
    {draft.phase === "after" && <details className="video-input-options"><summary>素材与剪辑要求<span>时长 · 原声 · 保留画面</span></summary>
      <TextField label="各段素材大致时长（选填）" value={f.durations} onChange={v => footage("durations", v)} max={1000} placeholder="例如：日落约 15 秒，其余不确定" />
      <div className="video-two"><TextField label="特别想保留的画面" value={f.keep} onChange={v => footage("keep", v)} max={1000} /><TextField label="不使用的画面" value={f.exclude} onChange={v => footage("exclude", v)} max={1000} /></div>
      <SelectField label="是否有原声" value={f.originalAudio} onChange={v => footage("originalAudio", v)}>{["不确定", "有原声", "无原声"].map(v => <option key={v}>{v}</option>)}</SelectField>
      <TextField label="剪辑想表达的重点" value={f.focus} onChange={v => footage("focus", v)} max={1000} />
      <TextField label="其他剪辑要求" multiline value={f.requirements} onChange={v => footage("requirements", v)} />
    </details>}
  </fieldset>;
}

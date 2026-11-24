import { XhsTitleEditor } from "@/components/xhs-title-editor";
import { useState } from "react";
import { analyzeHashtags } from "@/lib/format";
import { timelineIssue, type Shot, type VideoPlan } from "@/lib/video/schema";
import { VideoDialog } from "./dialog";
import { TextField } from "./fields";

export type PlanEditTarget = { kind: "shot"; id: string } | { kind: "overview" | "titles" | "cover" | "body" | "hashtags" | "preparation" | "sound" | "warnings" };
const names = { overview: "方案概览", titles: "参考标题", cover: "封面文案与画面", body: "发布正文", hashtags: "话题标签", preparation: "准备与注意事项", sound: "转场、节奏与声音", warnings: "需要核实的信息" };

export function PlanEditor({ target, plan, duration, phase, disabled, status, saveError, onRetry, onChange, onClose }: {
  target: PlanEditTarget; plan: VideoPlan; duration: number; phase: "before" | "after"; disabled: boolean;
  status: string; saveError: string; onRetry: () => void; onChange: (plan: VideoPlan) => void; onClose: () => void;
}) {
  const [original] = useState(() => structuredClone(plan));
  const index = target.kind === "shot" ? plan.shots.findIndex(s => s.shotId === target.id) : -1;
  const shot = plan.shots[index];
  const title = target.kind === "shot" ? `编辑镜头 ${index + 1}` : `编辑${names[target.kind]}`;
  const tags = analyzeHashtags(plan.hashtags);
  const timing = timelineIssue(plan.shots, duration);
  const change = (key: keyof VideoPlan, value: VideoPlan[keyof VideoPlan]) => onChange({ ...plan, [key]: value });
  const setShot = (key: keyof Shot, value: Shot[keyof Shot]) => change("shots", plan.shots.map(s => s.shotId === shot.shotId ? { ...s, [key]: value } : s));
  function undo() {
    if (!window.confirm(`撤销打开“${title}”后对此区域的修改？其他区域保持不变。`)) return;
    if (target.kind === "shot") {
      const old = original.shots.find(s => s.shotId === target.id);
      if (old) change("shots", plan.shots.map(s => s.shotId === target.id ? old : s));
    } else {
      const keys: (keyof VideoPlan)[] = target.kind === "overview" ? ["coreIdea", "opening"] : target.kind === "preparation" ? ["preparation", "notes"] : target.kind === "sound" ? ["editingAdvice"] : [target.kind];
      const next = { ...plan };
      for (const key of keys) Object.assign(next, { [key]: original[key] });
      onChange(next);
    }
    onClose();
  }
  return <VideoDialog title={title} onClose={onClose} locked={disabled}>
    <div className="plan-editor">
      <p className="plan-help">修改会即时更新当前草稿。完成或关闭窗口会保留修改；需要恢复打开前的内容，请选择「撤销本次编辑」。</p>
      <p className="plan-save" role="status">{status}</p>
      {saveError && <div className="video-error" role="alert">{saveError}<button type="button" className="text-button" disabled={disabled} onClick={onRetry}>重试保存</button></div>}
      <fieldset disabled={disabled}>
        {target.kind === "overview" && <><TextField label="核心思路" multiline value={plan.coreIdea} onChange={v => change("coreIdea", v)} /><TextField label="推荐开头" multiline max={1000} value={plan.opening} onChange={v => change("opening", v)} /></>}
        {target.kind === "titles" && plan.titles.map((t, i) => <label className="video-field" key={i}><span>视频标题 {i + 1}</span><XhsTitleEditor label={`视频标题 ${i + 1}`} value={t} onChange={v => change("titles", plan.titles.map((value, j) => i === j ? v : value))} /></label>)}
        {target.kind === "cover" && ([['headline', '封面主标题', 100], ['subline', '封面副标题', 200], ['visualIdea', '封面画面思路', 1000]] as const).map(([key, label, max]) => <TextField key={key} label={label} multiline value={plan.cover[key]} max={max} onChange={v => change("cover", { ...plan.cover, [key]: v })} />)}
        {target.kind === "shot" && shot && <>
          <p className="plan-help">这里是成片时间，所有镜头需从 0 秒连续衔接至 {duration} 秒。{phase === "after" && "素材仍对应本方案生成时的清单。"}</p>
          <div className="video-time"><label>开始秒<input aria-label={`镜头 ${index + 1} 开始秒`} type="number" min={0} max={600} value={shot.start} onChange={e => setShot("start", Number(e.target.value))} /></label><span>→</span><label>结束秒<input aria-label={`镜头 ${index + 1} 结束秒`} type="number" min={0} max={600} value={shot.end} onChange={e => setShot("end", Number(e.target.value))} /></label></div>
          {timing && <p className="video-error" role="alert">{timing}</p>}
          {([['visual', '画面拍什么', 1000], ['method', '怎么拍', 600], ['voice', '口播或旁白', 2000], ['subtitle', '屏幕字幕', 600], ['editing', '剪辑建议', 800]] as const).map(([key, label, max]) => <TextField key={key} label={`镜头 ${index + 1} ${label}`} value={shot[key]} multiline max={max} onChange={v => setShot(key, v)} />)}
        </>}
        {target.kind === "preparation" && <><TextField label="拍摄前准备 / 素材准备" multiline max={3000} value={plan.preparation} onChange={v => change("preparation", v)} /><TextField label="注意事项" multiline max={3000} value={plan.notes} onChange={v => change("notes", v)} /></>}
        {target.kind === "sound" && ([['transitions', '转场建议'], ['rhythm', '节奏建议'], ['originalAudio', '原声建议'], ['music', '音乐氛围建议']] as const).map(([key, label]) => <TextField key={key} label={label} value={plan.editingAdvice[key]} multiline max={1000} onChange={v => change("editingAdvice", { ...plan.editingAdvice, [key]: v })} />)}
        {target.kind === "body" && <TextField label="视频发布正文" multiline max={8000} value={plan.body} onChange={v => change("body", v)} />}
        {target.kind === "hashtags" && <><TextField label="视频话题标签" multiline value={plan.hashtags.join(" ")} onChange={v => change("hashtags", [v])} /><p className={tags.valid ? "plan-help" : "video-error"} role="status">有效标签 {tags.count} / 10{!tags.valid && "：请补齐或删减至 10 个有效且不重复的话题。原输入保留。"}</p><button type="button" className="text-button" disabled={tags.invalidCount > 0} onClick={() => change("hashtags", tags.tags)}>统一 # 并去重（不自动补造标签）</button></>}
        {target.kind === "warnings" && <TextField label="需要核实的信息" multiline max={6000} value={plan.warnings.join("\n")} onChange={v => change("warnings", v.split("\n").slice(0, 12).map(s => s.slice(0, 500)))} />}
        <div className="video-dialog-actions"><button type="button" className="secondary-button plan-done" onClick={onClose}>完成编辑，保留修改</button><button type="button" className="text-button" onClick={undo}>撤销本次编辑</button></div>
      </fieldset>
    </div>
  </VideoDialog>;
}

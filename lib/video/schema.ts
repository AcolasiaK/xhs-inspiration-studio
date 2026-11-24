import { isTitleWithinLimit, XHS_TITLE_RULE } from "../xhs-title";
import { z } from "zod";
import { analyzeHashtags, formatHashtags, splitTerms } from "../format";
import { ruleSnapshotSchema } from "../personal/style-rules";

export const VIDEO_TYPES = ["旅行", "日常生活", "真人口播", "产品展示", "其他"] as const;
export const VIDEO_STYLES = ["自然分享", "治愈氛围", "旅行攻略", "生活记录", "轻松幽默", "故事感"] as const;
export const phaseSchema = z.enum(["before", "after"]);
export type VideoPhase = z.infer<typeof phaseSchema>;
const text = (max = 2000) => z.string().max(max);
export const videoBriefSchema = z.object({
  topic: text(100), details: text(), location: text(200), type: z.enum(VIDEO_TYPES),
  onCamera: z.enum(["不出镜", "出镜", "部分出镜", "待定"]), duration: z.number().int().min(10).max(600),
  style: z.enum(VIDEO_STYLES), customStyle: text(1000), audience: text(200), mustInclude: text(500), forbidden: text(500),
  writingStyle: ruleSnapshotSchema.optional(),
});
export const footageSchema = z.object({ materials: text(5000), durations: text(1000), keep: text(1000), exclude: text(1000), originalAudio: z.enum(["不确定", "有原声", "无原声"]), focus: text(1000), requirements: text(2000) });
export const shotSchema = z.object({
  shotId: text(80), start: z.number().int().min(0).max(600), end: z.number().int().min(0).max(600),
  visual: text(1000), method: text(600), voice: text(2000), subtitle: text(600), editing: text(800), materialIds: z.array(text(80)).max(60),
});
export const videoPlanSchema = z.object({
  coreIdea: text(), opening: text(1000), titles: z.array(text(150)).max(5),
  cover: z.object({ headline: text(100), subline: text(200), visualIdea: text(1000) }),
  shots: z.array(shotSchema).max(24), preparation: text(3000), notes: text(3000),
  editingAdvice: z.object({ transitions: text(1000), rhythm: text(1000), originalAudio: text(1000), music: text(1000) }),
  body: text(8000), hashtags: z.array(text(2000)).max(30), warnings: z.array(text(500)).max(12),
});
export const videoSnapshotSchema = z.object({ phase: phaseSchema, brief: videoBriefSchema, footage: footageSchema, shootingReference: videoPlanSchema.nullable() });
export const videoRequestSchema = z.object({ action: z.enum(["generate", "rewrite"]), input: videoSnapshotSchema, current: videoPlanSchema.nullable(), targetId: text(80), instruction: text(1000) });
export type VideoBrief = z.infer<typeof videoBriefSchema>;
export type Footage = z.infer<typeof footageSchema>;
export type Shot = z.infer<typeof shotSchema>;
export type VideoPlan = z.infer<typeof videoPlanSchema>;
export type VideoSnapshot = z.infer<typeof videoSnapshotSchema>;
export type VideoRequest = z.infer<typeof videoRequestSchema>;
export const emptyVideoBrief: VideoBrief = { topic: "", details: "", location: "", type: "旅行", onCamera: "不出镜", duration: 60, style: "自然分享", customStyle: "", audience: "", mustInclude: "", forbidden: "" };
export const emptyFootage: Footage = { materials: "", durations: "", keep: "", exclude: "", originalAudio: "不确定", focus: "", requirements: "" };
export function materialsOf(footage: Footage) {
  return footage.materials.split(/[\n；;，,]+/u).map(s => s.trim()).filter(Boolean).map((description, index) => ({ id: `material-${index + 1}`, description }));
}
export function inputIssue(input: VideoSnapshot) {
  if (!input.brief.topic.trim()) return "请填写视频选题或主题。";
  if (input.phase === "after" && !materialsOf(input.footage).length) return "请描述实际拍到的素材；不能用拍摄计划代替实际素材。";
  if (materialsOf(input.footage).length > 60) return "素材最多描述 60 段，请先合并相近的片段。";
  return "";
}
export function timelineIssue(shots: Shot[], duration: number) {
  if (shots.length < 2 || shots.length > 24 || new Set(shots.map(s => s.shotId)).size !== shots.length || shots.some(s => !s.shotId.trim())) return "分镜需要 2～24 个互不重复的镜头。";
  let cursor = 0;
  for (const shot of shots) {
    if (shot.start !== cursor || shot.end <= shot.start || !Number.isInteger(shot.start) || !Number.isInteger(shot.end)) return "成片时间需要从 0 秒连续衔接，每个镜头的结束时间要晚于开始时间。";
    cursor = shot.end;
  }
  return cursor === duration ? "" : `分镜总时长应为 ${duration} 秒，当前为 ${cursor} 秒。`;
}
function voiceFits(shot: Shot) {
  // 保守上限只拦截明显无法读完的口播，不把文字估算声称为实际音轨测量。
  if (/^(不需要|无口播|无旁白|仅原声|保留原声)/u.test(shot.voice.trim())) return true;
  return Array.from(shot.voice.replace(/[\s\p{P}\p{S}]/gu, "")).length <= (shot.end - shot.start) * 6 + 12;
}
export function validateVideoPlan(input: VideoSnapshot, raw: unknown): VideoPlan {
  const parsed = videoPlanSchema.safeParse(raw);
  if (!parsed.success) throw new Error("生成方案结构不完整，请重试；旧方案仍保留。");
  const plan = parsed.data;
  const issue = timelineIssue(plan.shots, input.brief.duration);
  if (issue) throw new Error(issue);
  if (plan.shots.some(shot => !voiceFits(shot))) throw new Error("口播长度明显超出镜头时间，当前方案未采用，请缩短旁白或增加时长。");
  const required = [plan.coreIdea, plan.opening, plan.cover.headline, plan.cover.visualIdea, ...plan.shots.flatMap(s => [s.visual, s.method, s.voice, s.subtitle, s.editing])];
  if (required.some(s => !s.trim())) throw new Error("生成方案缺少必要内容；无口播或字幕时应明确写“不需要”。");
  if (plan.titles.some(title => !isTitleWithinLimit(title))) throw new Error(XHS_TITLE_RULE);
  const keys = plan.titles.map(s => s.normalize("NFKC").trim().toLocaleLowerCase("und"));
  if (keys.length !== 5 || keys.some(s => !s) || new Set(keys).size !== 5) throw new Error("需要 5 个不同的参考标题，当前结果不合格。");
  const materialIds = new Set(materialsOf(input.footage).map(m => m.id));
  if (input.phase === "after") {
    if (plan.shots.some(s => !s.materialIds.length || s.materialIds.some(id => !materialIds.has(id)))) throw new Error("分镜没有对应已描述的实际素材，已保留旧方案。");
    const tags = analyzeHashtags(plan.hashtags);
    if (plan.hashtags.length !== 10 || !tags.valid || tags.duplicateCount) throw new Error("标签必须恰好有 10 个有效且不重复的话题，当前结果未采用。");
    if (!plan.body.trim() || Object.values(plan.editingAdvice).some(s => !s.trim())) throw new Error("剪辑方向或发布正文不完整，当前结果未采用。");
    plan.hashtags = tags.tags;
  }
  const content = [plan.coreIdea, plan.opening, ...plan.titles, ...Object.values(plan.cover), ...plan.shots.flatMap(s => [s.visual, s.method, s.voice, s.subtitle, s.editing]), plan.preparation, plan.notes, ...Object.values(plan.editingAdvice), plan.body, ...plan.hashtags].join("\n");
  if (splitTerms(input.brief.forbidden).some(term => content.includes(term))) throw new Error("生成内容包含禁用词，当前结果未采用；请调整要求再试。");
  if (splitTerms(input.brief.mustInclude).some(term => !content.includes(term))) throw new Error("生成内容遗漏了必须提到的内容，当前结果未采用。");
  if (input.phase === "before" && !plan.preparation.trim()) throw new Error("缺少拍摄前准备，请重试。");
  return plan;
}
export function validateShot(input: VideoSnapshot, current: VideoPlan, targetId: string, raw: unknown): Shot {
  const parsed = shotSchema.safeParse(raw);
  const original = current.shots.find(s => s.shotId === targetId);
  if (!parsed.success || !original) throw new Error("重写镜头不完整或目标已不存在。");
  const next = parsed.data;
  if (next.end <= next.start || next.shotId !== original.shotId || next.start !== original.start || next.end !== original.end) throw new Error("重写镜头改变了编号或时间范围，原镜头未替换。");
  if (!voiceFits(next)) throw new Error("重写口播明显超出原镜头时间，原镜头未替换。");
  if ([next.visual,next.method,next.voice,next.subtitle,next.editing].some(s => !s.trim())) throw new Error("重写镜头内容不完整。");
  if (input.phase === "after" && (!next.materialIds.length || next.materialIds.some(id => !materialsOf(input.footage).some(m => m.id === id)))) throw new Error("重写镜头没有对应实际素材。");
  if (splitTerms(input.brief.forbidden).some(term => [next.visual,next.method,next.voice,next.subtitle,next.editing].some(s => s.includes(term)))) throw new Error("重写镜头包含禁用词，原镜头未替换。");
  return next;
}
export function formatShot(shot: Shot, index: number) { return `镜头 ${index + 1}｜成片 ${shot.start}～${shot.end} 秒\n画面：${shot.visual}\n拍法：${shot.method}\n口播 / 旁白：${shot.voice}\n字幕：${shot.subtitle}\n剪辑：${shot.editing}`; }
export function formatVideoPlan(plan: VideoPlan, phase: VideoPhase) {
  return [`【${phase === "before" ? "拍摄脚本" : "剪辑方案"}】`, `核心思路：${plan.coreIdea}`, `开头方式：${plan.opening}`, "\n【标题候选】", ...plan.titles.map((t,i)=>`${i+1}. ${t}`), "\n【封面】", plan.cover.headline, plan.cover.subline, plan.cover.visualIdea, "\n【分镜 · 成片时间，不是原视频时间】", ...plan.shots.map(formatShot), "\n【准备与注意事项】", plan.preparation, plan.notes, "\n【剪辑与声音方向】", ...Object.values(plan.editingAdvice), "\n【发布正文】", plan.body, "\n【话题标签】", formatHashtags(plan.hashtags), "\n【待确认】", ...plan.warnings].join("\n\n");
}

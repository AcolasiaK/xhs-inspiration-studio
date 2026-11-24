import { isTitleWithinLimit, XHS_TITLE_RULE } from "./xhs-title";
import { z } from "zod";
import { MAX_IMAGES, PURPOSES, TONES } from "./constants";
import { ruleSnapshotSchema } from "./personal/style-rules";

export const CREATION_TYPES = ["china", "travel", "emotion", "daily"] as const;
export const REFERENCE_ASPECTS = ["tone", "structure", "opening", "rhythm", "imageCopy"] as const;
export const CREATION_TYPE_LABELS = { china: "环游中国", travel: "旅行攻略", emotion: "情绪表达", daily: "日常分享" } as const;

export const briefSchema = z.object({
  topic: z.string().trim().min(1, "先写下这篇笔记的主题吧").max(100),
  details: z.string().trim().max(2000),
  audience: z.string().trim().max(100),
  tone: z.enum(TONES),
  purpose: z.enum(PURPOSES),
  length: z.enum(["short", "medium", "long"]),
  mustInclude: z.string().trim().max(500),
  forbidden: z.string().trim().max(500),
  emoji: z.boolean(),
  styleNotes: z.string().trim().max(1000).default(""),
  writingStyle: ruleSnapshotSchema.optional(),
  // 缺失字段的旧草稿统一按日常分享恢复，历史正文和图片不会被改写。
  creationTypes: z.array(z.enum(CREATION_TYPES)).min(1).max(4).refine((items) => new Set(items).size === items.length, "创作类型不能重复").default(["daily"]),
  primaryType: z.enum(CREATION_TYPES).default("daily"),
  travelFocus: z.enum(["experience", "guide", "balanced"]).default("experience"),
  dailyFocus: z.enum(["auto", "reflection", "record"]).default("auto"),
  supplementTravel: z.string().max(2000).default(""),
  supplementEmotion: z.string().max(2000).default(""),
  supplementDaily: z.string().max(2000).default(""),
  travelSearch: z.boolean().default(true),
  travelSearchPlace: z.string().trim().max(100).default(""),
  referenceText: z.string().max(6000).default(""),
  referenceAspects: z.array(z.enum(REFERENCE_ASPECTS)).max(5).refine((items) => new Set(items).size === items.length, "参考方向不能重复").default([]),
});
export type Brief = z.infer<typeof briefSchema>;
export type GenerationMode = "demo" | "live";

export const requestSchema = z.object({
  brief: briefSchema,
  mode: z.enum(["demo", "live"]),
  imageIds: z.array(z.string().uuid()).min(1).max(MAX_IMAGES)
    .refine((ids) => new Set(ids).size === ids.length, "图片 ID 不能重复"),
}).superRefine((value, ctx) => { if (!value.brief.creationTypes.includes(value.brief.primaryType)) ctx.addIssue({ code: "custom", path: ["brief", "primaryType"], message: "主要类型须从已选择的类型中指定。" }); });

// 给模型的 schema 保持简单；数量、ID 和内容约束在生成后独立验证。
export const modelResultSchema = z.object({
  titles: z.array(z.string()),
  coverCopy: z.object({ headline: z.string(), subline: z.string() }),
  imageCaptions: z.array(z.object({ imageId: z.string(), headline: z.string(), description: z.string() })),
  body: z.string(),
  hashtags: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type ContentResult = z.infer<typeof modelResultSchema>;

export const resultSchema = z.object({
  titles: z.array(z.string().trim().min(1).refine(isTitleWithinLimit, XHS_TITLE_RULE)).length(5)
    .refine((titles) => new Set(titles).size === 5, "标题应有五个不同候选"),
  coverCopy: z.object({ headline: z.string().trim().min(1).max(100), subline: z.string().max(200) }),
  imageCaptions: z.array(z.object({
    imageId: z.string().uuid(), headline: z.string().trim().min(1).max(100), description: z.string().max(500),
  })).min(1).max(MAX_IMAGES),
  body: z.string().trim().min(1).max(6000),
  // 保留空、重复与超量标签供业务校验和有限补正；不提前截断或伪造。
  hashtags: z.array(z.string().max(800)).max(80),
  // 最多 20 条模型提示，另外预留 2 条本地业务校验提示。
  warnings: z.array(z.string().max(500)).max(22),
});

export const generationMetaSchema = z.object({
  aiSelection: z.object({id:z.string().max(160),name:z.string().max(60),model:z.string().max(160),revision:z.string().max(160)}).optional(),
  durationMs: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
});

export const emptyBrief: Brief = {
  topic: "", details: "", audience: "", tone: "自然分享", purpose: "分享经历",
  length: "medium", mustInclude: "", forbidden: "", emoji: true, styleNotes: "",
  creationTypes: ["daily"], primaryType: "daily", travelFocus: "experience", dailyFocus: "auto",
  supplementTravel: "", supplementEmotion: "", supplementDaily: "", travelSearch: true, travelSearchPlace: "", referenceText: "", referenceAspects: [],
};
export const exampleBrief: Brief = {
  ...emptyBrief,
  topic: "把周末留给咖啡和自己", details: "想写一篇周末咖啡馆随记，语气像和朋友聊天。关注光线、空间和慢下来的感觉，避免过度种草。",
  audience: "想在周末放松的上班族", tone: "自然分享", purpose: "分享经历", length: "medium",
  mustInclude: "周末，慢下来", forbidden: "全网第一，闭眼冲", emoji: true, styleNotes: "",
};

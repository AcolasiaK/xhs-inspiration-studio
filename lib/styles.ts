import { z } from "zod";
import { briefSchema, type Brief } from "./schema";

export const stylePreferencesSchema = briefSchema.pick({ tone: true, audience: true, length: true, emoji: true, styleNotes: true, forbidden: true });
export type StylePreferences = z.infer<typeof stylePreferencesSchema>;
export const customStyleSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), name: z.string().trim().min(1).max(40),
  updatedAt: z.string().datetime(), preferences: stylePreferencesSchema,
});
export type CustomStyle = z.infer<typeof customStyleSchema>;
export type StyleTemplate = { id: string; name: string; preferences: StylePreferences };
export const PRESET_STYLES: StyleTemplate[] = [
  { id: "daily", name: "自然日常分享", preferences: { tone: "自然分享", audience: "喜欢记录日常的朋友", length: "medium", emoji: true, styleNotes: "像和朋友聊天，使用具体细节和自然段落，避免口号。", forbidden: "全网第一，闭眼冲" } },
  { id: "guide", name: "实用干货攻略", preferences: { tone: "干货攻略", audience: "希望快速学会方法的新手", length: "long", emoji: false, styleNotes: "先讲适用场景，再按步骤说明方法，突出注意事项，不编造数据。", forbidden: "百分百，保证成功" } },
  { id: "product", name: "克制产品介绍", preferences: { tone: "克制高级", audience: "关注产品细节的理性消费者", length: "medium", emoji: false, styleNotes: "用简洁、客观的描述介绍可见细节，不夸大功效，不伪造使用体验。", forbidden: "神器，必买，最强" } },
  { id: "humor", name: "轻松幽默表达", preferences: { tone: "轻松幽默", audience: "喜欢轻松表达的年轻读者", length: "short", emoji: true, styleNotes: "使用轻巧的比喻和短句，幽默适量，不嘲讽具体的人。", forbidden: "笑死所有人，全网第一" } },
];
export function preferencesFromBrief(brief: Brief): StylePreferences { return stylePreferencesSchema.parse(brief); }
export function applyStyle(brief: Brief, preferences: StylePreferences): Brief {
  // 白名单只更新六项偏好；主题、本次要求、必提内容和发布目的原样保留。
  return { ...brief, ...stylePreferencesSchema.parse(preferences) };
}

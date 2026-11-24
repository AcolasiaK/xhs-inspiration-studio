import { z } from "zod";
import { emptyBrief, type Brief } from "./schema";

export const HOTSPOT_TRANSFER_KEY = "xhs-hotspot-topic-v1";
export const hotspotTransferSchema = z.object({
  version: z.literal(1),
  topic: z.string().trim().min(1).max(150),
  angle: z.string().trim().min(1).max(1000),
  headline: z.string().trim().max(300),
  hotspotTitle: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(200),
  url: z.string().url().max(2048).refine((value) => {
    try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
  }),
});
export type HotspotTransfer = z.infer<typeof hotspotTransferSchema>;

/** 只把选题公开信息带入新草稿，旧草稿与私人素材不参与传递。 */
export function hotspotBrief(input: HotspotTransfer): Brief {
  const value = hotspotTransferSchema.parse(input);
  const details = [
    `创作角度：${value.angle}`,
    value.headline ? `参考标题：${value.headline}` : "",
    `关联热点：${value.hotspotTitle}`,
    `来源：${value.source} ${value.url}`,
    "发布前请核实热点事实和来源信息。",
  ].filter(Boolean).join("\n");
  return { ...emptyBrief, topic: value.topic.slice(0, 100), details: details.slice(0, 2000) };
}

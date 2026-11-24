import { z } from "zod";
import { briefSchema, emptyBrief, generationMetaSchema, type Brief, type GenerationMode } from "./schema";
import type { Generation, StudioImage } from "./types";
import { IMAGE_TYPES, MAX_FILE_BYTES, MAX_IMAGES } from "./constants";
import { prepareImage } from "./images";
import { analyzeHashtags, formatAll } from "./format";
import { travelResearchSchema } from "./travel-research";

// Version 3 protects new creation settings and reference sources from older clients
// that would otherwise strip unknown fields when saving a version 2 record.
export const LOCAL_DATA_VERSION = 3;
export type GenerationInput = { brief: Brief; imageIds: string[]; mode: GenerationMode };
export type Draft = {
  id: string; name: string; createdAt: string; updatedAt: string; brief: Brief; mode: GenerationMode;
  images: StudioImage[]; generation: Generation | null; resultImages: StudioImage[]; generatedInput: GenerationInput | null;
  selectedTitleIndex: number; hasUserEdits: boolean;
};
const idList = z.array(z.string().uuid()).max(MAX_IMAGES).refine((ids) => new Set(ids).size === ids.length);
// 草稿允许未填写主题，以及用户编辑后的空文案；不可用生成接口的严格校验覆盖它们。
export const draftBriefSchema = briefSchema.extend({
  topic: z.string().max(100), details: z.string().max(2000), audience: z.string().max(100),
  mustInclude: z.string().max(500), forbidden: z.string().max(500), styleNotes: z.string().max(1000).default(""),
});
const editedResultSchema = z.object({
  titles: z.array(z.string().max(150)).length(5),
  coverCopy: z.object({ headline: z.string().max(150), subline: z.string().max(250) }),
  imageCaptions: z.array(z.object({ imageId: z.string().uuid(), headline: z.string().max(150), description: z.string().max(700) })).max(MAX_IMAGES),
  body: z.string().max(8000), hashtags: z.array(z.string().max(800)).max(12), warnings: z.array(z.string().max(500)).max(22),
});
const storedImageSchema = z.object({
  id: z.string().uuid(), name: z.string().max(1024), lastModified: z.number().nonnegative(),
  blob: z.custom<Blob>((value) => value instanceof Blob && value.size > 0 && value.size <= MAX_FILE_BYTES && IMAGE_TYPES.includes(value.type)),
  width: z.number().int().positive(), height: z.number().int().positive(),
});
export const storedDraftSchema = z.object({
  // Versions 1 and 2 remain readable. Version 3 adds creation settings and source snapshots.
  version: z.union([z.literal(1), z.literal(2), z.literal(LOCAL_DATA_VERSION)]), revision: z.number().int().nonnegative(), id: z.string().uuid(),
  name: z.string().max(80), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  brief: draftBriefSchema, mode: z.enum(["demo", "live"]), imageIds: idList, resultImageIds: idList,
  assets: z.array(storedImageSchema).max(MAX_IMAGES * 2),
  generation: z.object({ result: editedResultSchema, mode: z.enum(["demo", "live"]), imageIds: idList, meta: generationMetaSchema, research: travelResearchSchema.optional() }).nullable(),
  generatedInput: z.object({ brief: draftBriefSchema, imageIds: idList, mode: z.enum(["demo", "live"]) }).nullable(),
  selectedTitleIndex: z.number().int().min(0).max(4).optional(), hasUserEdits: z.boolean().optional(),
}).superRefine((draft, ctx) => {
  const ids = draft.assets.map((image) => image.id);
  const expected = new Set([...draft.imageIds, ...draft.resultImageIds]);
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  const bad = new Set(ids).size !== ids.length || ids.length !== expected.size || ids.some((id) => !expected.has(id))
    || draft.assets.some((image) => image.width * image.height > 24_000_000)
    || (draft.generation ? !draft.generatedInput || !same(draft.generation.imageIds, draft.resultImageIds)
      || !same(draft.generation.result.imageCaptions.map((c) => c.imageId), draft.resultImageIds)
      || !same(draft.generatedInput.imageIds, draft.resultImageIds) || draft.generatedInput.mode !== draft.generation.mode
      : draft.resultImageIds.length > 0 || draft.generatedInput !== null);
  if (bad) ctx.addIssue({ code: "custom", message: "草稿图片与生成快照不一致" });
  if (draft.version >= 2 && (draft.selectedTitleIndex === undefined || draft.hasUserEdits === undefined)) {
    ctx.addIssue({ code: "custom", message: "新版草稿缺少标题选择或编辑状态" });
  }
});
export type StoredDraft = z.infer<typeof storedDraftSchema>;
export type DraftSummary = { id: string; name: string; updatedAt: string; contentMode: GenerationMode | null; thumbnail?: Blob; thumbnailId?: string; damaged?: boolean };
export function newDraft(): Draft {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: "未命名草稿", createdAt: now, updatedAt: now, brief: { ...emptyBrief }, mode: "demo", images: [], generation: null, resultImages: [], generatedInput: null, selectedTitleIndex: 0, hasUserEdits: false };
}
export function inputSnapshot(draft: Pick<Draft, "brief" | "images" | "mode">): GenerationInput {
  return { brief: { ...draft.brief }, imageIds: draft.images.map((image) => image.id), mode: draft.mode };
}
export function isDraftStale(draft: Draft): boolean {
  return Boolean(draft.generation && JSON.stringify(draft.generatedInput) !== JSON.stringify(inputSnapshot(draft)));
}
export function serializeDraft(draft: Draft, revision: number): StoredDraft {
  const assets = [...new Map([...draft.images, ...draft.resultImages].map((image) => [image.id, image])).values()];
  // 显式白名单：不保存 Object URL、访问口令、连接状态或任何服务端配置。
  return storedDraftSchema.parse({
    version: LOCAL_DATA_VERSION, revision, id: draft.id, name: draft.name.trim() || "未命名草稿",
    createdAt: draft.createdAt, updatedAt: draft.updatedAt, brief: draft.brief, mode: draft.mode,
    imageIds: draft.images.map((image) => image.id), resultImageIds: draft.resultImages.map((image) => image.id),
    assets: assets.map(({ id, file, width, height }) => ({ id, blob: file, name: file.name, lastModified: file.lastModified, width, height })),
    generation: draft.generation, generatedInput: draft.generatedInput,
    selectedTitleIndex: draft.selectedTitleIndex, hasUserEdits: draft.hasUserEdits,
  });
}
export async function hydrateDraft(value: unknown): Promise<Draft> {
  const stored = storedDraftSchema.parse(value);
  const loaded: StudioImage[] = [];
  try {
    for (const asset of stored.assets) {
      const image = await prepareImage(new File([asset.blob], asset.name, { type: asset.blob.type, lastModified: asset.lastModified }));
      loaded.push({ ...image, id: asset.id });
    }
    const byId = new Map(loaded.map((image) => [image.id, image]));
    return { id: stored.id, name: stored.name, createdAt: stored.createdAt, updatedAt: stored.updatedAt, brief: stored.brief, mode: stored.mode,
      images: stored.imageIds.map((id) => byId.get(id)!), resultImages: stored.resultImageIds.map((id) => byId.get(id)!),
      generation: stored.generation, generatedInput: stored.generatedInput,
      selectedTitleIndex: stored.selectedTitleIndex ?? 0, hasUserEdits: stored.hasUserEdits ?? Boolean(stored.generation) };
  } catch { loaded.forEach((image) => URL.revokeObjectURL(image.preview)); throw new Error("这份草稿的图片无法读取，原始记录未改动。请打开其他草稿。"); }
}
export function draftSummary(draft: StoredDraft): DraftSummary {
  return { id: draft.id, name: draft.name || "未命名草稿", updatedAt: draft.updatedAt, contentMode: draft.generation?.mode ?? null,
    thumbnail: draft.assets.find((image) => image.id === draft.imageIds[0])?.blob };
}
export function copyStoredDraft(source: StoredDraft): StoredDraft {
  const now = new Date().toISOString();
  return storedDraftSchema.parse({ ...structuredClone(source), version: LOCAL_DATA_VERSION,
    selectedTitleIndex: source.selectedTitleIndex ?? 0, hasUserEdits: source.hasUserEdits ?? Boolean(source.generation),
    id: crypto.randomUUID(), name: `${source.name.slice(0, 72)}（副本）`, revision: 0, createdAt: now, updatedAt: now });
}

/** A backup can be explicitly exported with a warning when the user's tags are incomplete. */
export function formatDraftExport(draft: Pick<Draft, "generation" | "selectedTitleIndex">, allowIncomplete = false): string {
  if (!draft.generation) throw new Error("当前草稿还没有文案可以导出。");
  const result = draft.generation.result;
  const tags = analyzeHashtags(result.hashtags);
  if (!tags.valid && !allowIncomplete) throw new Error(`当前有 ${tags.count} 个有效话题，请先调整为 10 个；也可以明确选择导出不完整备份。`);
  const selected = result.titles[draft.selectedTitleIndex] ?? "";
  const warning = tags.valid ? "" : "【导出提醒】话题尚未达到 10 个或含无效内容；请编辑后再用于发布。\n\n";
  const original = tags.valid ? "" : `\n\n【原始话题输入（供修正）】\n${result.hashtags.join(" ")}`;
  return `${warning}【选中的标题】\n${selected}\n\n${formatAll(result)}${original}`;
}

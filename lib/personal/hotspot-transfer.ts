import type { Hotspot, HotspotSuggestion } from "../server/hotspots-types";
import { newPersonalDraft, personalStoredSchema, serializePersonalDraft, type PersonalStored } from "./drafts";
import { hotspotReferenceLink, personalHotspotReferenceSchema } from "./hotspot-reference";

function knownTime(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function personalDraftFromHotspot(hotspot: Hotspot, suggestion?: HotspotSuggestion): PersonalStored {
  const url = hotspotReferenceLink(hotspot.url);
  if (!url) throw new Error("热点来源链接无效，请刷新后重试。原草稿未修改。");
  const draft = newPersonalDraft();
  draft.name = (suggestion?.topic || hotspot.title).trim().slice(0, 80) || "热点个人草稿";
  draft.input.hotspotReference = personalHotspotReferenceSchema.parse({
    title: hotspot.title, summary: hotspot.description || "", source: hotspot.source, url,
    publishedAt: knownTime(hotspot.publishedAt), collectedAt: knownTime(hotspot.collectedAt),
    angle: suggestion?.angle || "",
  });
  // Topic, experience, feelings and requirements intentionally remain empty.
  return serializePersonalDraft(draft, 0);
}
type Store = { ensureDraft(value: PersonalStored): Promise<PersonalStored> };
/** One stable draft per selection/retry; the store's ensure operation is atomic.
 * No old draft writes, no model calls, and no navigation until persistence succeeds.
 * Scope prevents a pending intent being reused after an account change. */
export function createPersonalHotspotStarter() {
  const intents = new Map<string, PersonalStored>();
  let running: Promise<PersonalStored> | null = null;
  return {
    start(store: Store, scope: string, hotspot: Hotspot, suggestion?: HotspotSuggestion): Promise<PersonalStored> {
      if (running) return running;
      const key = JSON.stringify([scope, hotspot, suggestion]);
      const operation = Promise.resolve().then(async () => {
        let draft = intents.get(key);
        if (!draft) { draft = personalDraftFromHotspot(hotspot, suggestion); intents.set(key, draft); }
        const saved = personalStoredSchema.parse(await store.ensureDraft(draft));
        if (saved.id !== draft.id) throw new Error("新草稿保存结果不一致，请重试。原草稿未修改。");
        return saved;
      });
      running = operation;
      void operation.finally(() => { if (running === operation) running = null; }).catch(() => undefined);
      return operation;
    },
  };
}

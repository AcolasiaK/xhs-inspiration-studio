import "server-only";
import { isCloudMode } from "@/lib/cloud/mode";
import { personalGuidePlaces, safePersonalSearchQuery } from "@/lib/personal/search-query";
import type { TravelResearch } from "@/lib/travel-research";
import { researchPersonalGuide } from "./personal-guide-research";
import { searchTravelInfo } from "./travel-search";

/** Personal drafts share the same local browser guide search across writing styles. */
export async function searchPersonalBackground(
  input: { query: string; enabled: boolean; signal?: AbortSignal; wholeDestination?: boolean },
  _source?: unknown,
): Promise<TravelResearch> {
  void _source;
  input.signal?.throwIfAborted();
  if (!input.enabled) return { status: "disabled", retrievedAt: null, sources: [], notice: "本次未开启攻略检索。" };

  const local = !isCloudMode();
  const query = local ? personalGuidePlaces(input.query).join(" ") : safePersonalSearchQuery(input.query);
  if (!query) return {
    status: "missing_place", retrievedAt: null, sources: [],
    notice: "未能确定可检索的公开地点或关键词。可在创作设置中补充后重新生成提示词。",
  };
  if (local) return researchPersonalGuide({query, signal:input.signal, wholeDestination:input.wholeDestination ?? !query.includes(" ")});
  return searchTravelInfo({
    place: query, enabled: true, signal: input.signal, background: true,
  });
}

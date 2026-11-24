import type { Draft } from "./drafts";
import type { TravelResearch } from "./travel-research";

/** Keep stale research from being attached to a different draft or a changed result. */
export function researchFingerprint(draft: Draft): string {
  return JSON.stringify({ id: draft.id, generation: draft.generation, generatedInput: draft.generatedInput });
}
export function applyResearchIfCurrent(draft: Draft, fingerprint: string, research: TravelResearch): Draft {
  if (!draft.generation || !draft.generatedInput || researchFingerprint(draft) !== fingerprint) return draft;
  if ((research.status !== "success" && research.status !== "partial") || research.sources.length === 0) return draft;
  return { ...draft, generation: { ...draft.generation, research } };
}

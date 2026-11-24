import type { HotspotEditorial } from "../hotspot-relevance";
export type Hotspot = { id: string; title: string; description: string; url: string; source: string; publishedAt: string | null; collectedAt: string; rank: number; editorial?: HotspotEditorial };
export type HotspotSuggestion = { hotspotId: string; topic: string; angle: string; headline: string; imageIdea: string; reason: string };
export type HotspotSourceStatus = { name: string; status: 'success' | 'error'; count: number; error?: string };
export type HotspotState = { items: Hotspot[]; lastSuccessAt: string | null; lastAttemptAt: string | null; updating: boolean; error: string | null; sources: HotspotSourceStatus[]; ordering: string; sourceNotice?: string | null; selectionNotice?: string | null; sourceCount?: number; filteredCount?: number; suggestions: HotspotSuggestion[]; suggestionGeneratedAt: string | null; suggestionError: string | null; suggestionLocked?: boolean; suggestionLastAttemptAt?: string | null; suggestionRequestId?: string | null; suggestionErrorCode?: string | null; suggestionItems?: Hotspot[]; suggestionSourceAt?: string | null; scheduler: 'running' | 'disabled'; storage: 'disk' | 'memory' };

export type HotspotCollection = { items: Hotspot[]; sourceCount: number; filteredCount: number };

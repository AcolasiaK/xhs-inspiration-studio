import type { ContentResult, GenerationMode } from "./schema";
import type { TravelResearch } from "./travel-research";

export type StudioImage = { id: string; file: File; preview: string; width: number; height: number };
export type GenerationMeta = { durationMs: number; completedAt: string; aiSelection?: {id:string;name:string;model:string;revision:string} };
export type Generation = { result: ContentResult; mode: GenerationMode; imageIds: string[]; meta: GenerationMeta; research?: TravelResearch };
export type PublicConfig = { liveAvailable: boolean; setupMessage: string; providerName: string };
export type ApiResponse = { result: ContentResult; mode: GenerationMode; meta: GenerationMeta; research?: TravelResearch };

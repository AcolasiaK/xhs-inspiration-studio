"use client";
import { useSyncExternalStore } from "react";
import { getAiSource, subscribeAiSource, type AiSource } from "@/lib/ai-source";
const relay = (): AiSource => "";
export function useAiSource() { return useSyncExternalStore(subscribeAiSource, getAiSource, relay); }

import "server-only";
import type { AiSource } from './ai-source';
export function generationTimeouts(profile = process.env.GENERATION_TIMEOUT_PROFILE, vercel = process.env.VERCEL, source: AiSource = 'relay') {
 if(process.env.APP_MODE==='cloud')return {totalMs:180_000,modelMs:150_000};
 if(typeof source==='object')return {totalMs:190_000,modelMs:(source.profile?.timeoutSeconds||60)*1000};
 return !vercel&&profile==='local'?{totalMs:100_000,modelMs:90_000}:{totalMs:50_000,modelMs:48_000};
}

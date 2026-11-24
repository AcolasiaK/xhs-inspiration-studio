import { presets, type ProfileInput, type PublicProfile } from './ai-config';
import { profileForm } from './ai-profile-client';

export function emptyAiForm(): ProfileInput {
  return { name: '', provider: 'openai', ...presets.openai, apiKey: '', model: '', timeoutSeconds: 120, maxOutputTokens: 8000 };
}

/** Comparison stays in page memory. Never persist an unfinished secret. */
export function sameAiForm(a: ProfileInput, b: ProfileInput) {
  return a.name.trim() === b.name.trim() && sameAiConnection(a, b);
}

export function sameAiConnection(a: ProfileInput, b: ProfileInput) {
  return a.provider === b.provider && a.protocol === b.protocol
    && a.baseUrl.trim().replace(/\/+$/, '') === b.baseUrl.trim().replace(/\/+$/, '')
    && a.model.trim() === b.model.trim() && a.apiKey.trim() === b.apiKey.trim()
    && Boolean(a.clearApiKey) === Boolean(b.clearApiKey)
    && a.timeoutSeconds === b.timeoutSeconds && a.maxOutputTokens === b.maxOutputTokens && a.jsonMode === b.jsonMode;
}

export function needsAiRetest(form: ProfileInput, saved: PublicProfile | null) {
  return Boolean(saved && !sameAiConnection({
    ...form, maxOutputTokens: saved.maxOutputTokens, timeoutSeconds: saved.timeoutSeconds,
  }, profileForm(saved)));
}

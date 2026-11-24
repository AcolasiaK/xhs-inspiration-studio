import 'server-only';
import { styleLearningRecoverySchema } from '../personal/style-learning';
import { OutputBudgetError } from './ai/output-budget';

const labels: Record<string, string> = { name: '建议风格名', summary: '风格概述', temperament: '整体气质', expression: '标题表达', language: '标题语言', appeal: '标题吸引力', relation: '标题与正文', body: '正文风格', captions: '逐图配文风格', imageText: '图文配合', transfer: '换素材时' };
/** Read complete JSON string fields for a labelled preview; never repair or adopt partial rules. */
export function previewStyleFragments(text: string) {
  const found = new Map<string, string>();
  let index = 0;
  function stringAt(start: number): { value: string; end: number } | null {
    let escaped = false;
    for (let i = start + 1; i < text.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (text[i] === '\\') { escaped = true; continue; }
      if (text[i] === '"') {
        try { return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }; } catch { return null; }
      }
    }
    return null;
  }
  while (index < text.length && found.size < 12) {
    if (text[index] !== '"') { index++; continue; }
    const key = stringAt(index); if (!key) break;
    index = key.end;
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    if (text[index] !== ':') continue;
    index++;
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
    if (text[index] !== '"') continue;
    const value = stringAt(index); if (!value) break;
    index = value.end;
    if (labels[key.value] && value.value.trim() && !found.has(key.value)) found.set(key.value, value.value.slice(0, 700));
  }
  return [...found].map(([key, text]) => ({ label: labels[key], text }));
}
export function styleLearningRecovery(error: OutputBudgetError) {
  const suggestedTokens = error.reason === 'exhausted'
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(32768, error.limit * 2))
    : Math.max(256, Math.floor(error.limit / 2));
  return styleLearningRecoverySchema.parse({ reason: error.reason, limit: error.limit, suggestedTokens, partial: previewStyleFragments(error.visibleText()) });
}

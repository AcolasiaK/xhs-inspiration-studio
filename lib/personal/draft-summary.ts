import type { PersonalInput } from './schema';
import { personalStyleLabel } from './presentation';

export const DEFAULT_PERSONAL_NAME = '未命名个人草稿';
const excerpt = (value: string, limit: number) => Array.from(value.trim().replace(/\s+/gu, ' ')).slice(0, limit).join('');

export function suggestedPersonalName(input: PersonalInput) {
  return excerpt(input.topic || input.experience.split(/[。！？!?\n]/u).find(line => line.trim()) || '', 24) || DEFAULT_PERSONAL_NAME;
}

export function personalSummaryDetails(draft: { input: PersonalInput; prompt: string; generation: unknown; name: string }) {
  return {
    excerpt: excerpt(draft.input.experience || draft.input.topic, 120),
    style: personalStyleLabel(draft.input),
    stage: draft.generation ? '已有笔记' : draft.prompt.trim() ? '已有创作方向' : draft.input.experience.trim() || draft.input.topic.trim() ? '已填写内容' : '待填写',
    suggestedName: draft.name === DEFAULT_PERSONAL_NAME ? suggestedPersonalName(draft.input) : '',
  };
}

export function filterPersonalSummaries<T extends { name: string; excerpt?: string; suggestedName?: string; updatedAt: string }>(rows: T[], search: string): T[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter(row => !query || [row.name, row.excerpt, row.suggestedName].join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

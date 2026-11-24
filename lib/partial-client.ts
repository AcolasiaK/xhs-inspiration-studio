import { isTitleWithinLimit } from "./xhs-title";
import { cloudJobFetch } from "./cloud/jobs-client";
import { isCloudClient } from "./cloud/client";
import { MAX_REQUEST_BYTES } from './constants';
import { compressImages } from './images';
import { analyzeHashtags } from './format';
import type { Brief, ContentResult } from './schema';
import { generationMetaSchema } from './schema';
import type { Draft } from './drafts';
import type { StudioImage } from './types';
import type { RewriteDirection } from './rewrite-request';
import type { TravelResearch } from './travel-research';
import { aiSourceHeader, getAiSource, type AiSource } from './ai-source';

export type PartialTarget = 'title_one' | 'titles_all' | 'caption_one' | 'captions_all' | 'tag_one' | 'tags_all';
export type PartialChoice = { target: PartialTarget; targetIndex?: number; targetImageId?: string };
export type PartialResult = { titles: string[]; imageCaptions: ContentResult['imageCaptions']; hashtags: string[] };
type Options = { brief: Brief; current: ContentResult; images: StudioImage[]; choice: PartialChoice; direction: RewriteDirection; instruction: string; accessToken?: string; research?: TravelResearch; controller: AbortController; onProgress: (text: string) => void; compress?: typeof compressImages; request?: typeof fetch; timeoutMs?: number; aiSource?: AiSource };

/** A snapshot includes all model inputs and current image order so late results never replace newer edits. */
export function partialFingerprint(draft: Draft) {
  return JSON.stringify({ id: draft.id, result: draft.generation?.result, version: draft.generation?.meta.completedAt, research: draft.generation?.research,
    generatedInput: draft.generatedInput, resultImageIds: draft.resultImages.map(x => x.id),
    currentInput: { brief: draft.brief, mode: draft.mode, imageIds: draft.images.map(x => x.id) } });
}
const comparisonKey = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase('und');
export function validatePartial(result: PartialResult, choice: PartialChoice, current: ContentResult, ids: string[]): boolean {
  if (!result || !Array.isArray(result.titles) || !Array.isArray(result.imageCaptions) || !Array.isArray(result.hashtags)) return false;
  if (choice.target === 'title_one' || choice.target === 'titles_all') {
    const expected = choice.target === 'title_one' ? 3 : 5;
    const titles = result.titles;
    return titles.length === expected && titles.every(x => typeof x === 'string' && !!x.trim() && isTitleWithinLimit(x) && !/[\r\n]/u.test(x))
      && new Set(titles.map(comparisonKey)).size === expected
      && !titles.some(x => current.titles.some(old => comparisonKey(x) === comparisonKey(old)))
      && !result.imageCaptions.length && !result.hashtags.length;
  }
  if (choice.target === 'caption_one' || choice.target === 'captions_all') {
    const expected = choice.target === 'caption_one' ? [choice.targetImageId] : ids;
    const captions = result.imageCaptions;
    return !result.titles.length && !result.hashtags.length && captions.length === expected.length
      && captions.every((x, i) => {
        if (!x || x.imageId !== expected[i] || typeof x.headline !== 'string' || !x.headline.trim() || x.headline.length > 100 || typeof x.description !== 'string' || !x.description.trim() || x.description.length > 500 || x.description.split(/\r?\n/u).filter(line => line.trim()).length < 2) return false;
        const old = current.imageCaptions.find(item => item.imageId === x.imageId);
        return Boolean(old && (comparisonKey(old.headline) !== comparisonKey(x.headline) || comparisonKey(old.description) !== comparisonKey(x.description)));
      });
  }
  const tags = result.hashtags;
  const normalized = analyzeHashtags(tags);
  const required = choice.target === 'tag_one' ? 3 : 10;
  if (result.titles.length || result.imageCaptions.length || tags.length !== required || normalized.count !== required || normalized.invalidCount || normalized.duplicateCount
      || tags.some((tag, i) => tag !== normalized.tags[i])) return false;
  if (choice.target === 'tag_one') {
    const original = analyzeHashtags(current.hashtags);
    if (!original.valid || original.duplicateCount || choice.targetIndex === undefined) return false;
    const existing = new Set(original.tags.map(comparisonKey));
    if (tags.some(x => existing.has(comparisonKey(x)))) return false;
  } else {
    const existing = new Set(analyzeHashtags(current.hashtags).tags.map(comparisonKey));
    if (existing.size === required && tags.every(x => existing.has(comparisonKey(x)))) return false;
  }
  return true;
}
export function applyPartialIfCurrent(current: Draft, fingerprint: string, choice: PartialChoice, output: PartialResult, selected: number): Draft {
  if (!current.generation || partialFingerprint(current) !== fingerprint) return current;
  const old = current.generation.result;
  const ids = current.resultImages.map(x => x.id);
  if (!validatePartial(output, choice, old, ids)) return current;
  let result: ContentResult = old;
  if (choice.target === 'title_one') {
    if (choice.targetIndex === undefined || choice.targetIndex < 0 || choice.targetIndex >= old.titles.length || !output.titles[selected]) return current;
    const value = output.titles[selected].trim();
    if (old.titles.some((x, i) => i !== choice.targetIndex && x.trim().toLocaleLowerCase() === value.toLocaleLowerCase())) return current;
    result = { ...old, titles: old.titles.map((x, i) => i === choice.targetIndex ? value : x) };
  } else if (choice.target === 'titles_all') result = { ...old, titles: output.titles.map(x => x.trim()) };
  else if (choice.target === 'caption_one') result = { ...old, imageCaptions: old.imageCaptions.map(x => x.imageId === choice.targetImageId ? output.imageCaptions[0] : x) };
  else if (choice.target === 'captions_all') result = { ...old, imageCaptions: output.imageCaptions };
  else if (choice.target === 'tag_one') {
    const tags = analyzeHashtags(old.hashtags).tags;
    if (choice.targetIndex === undefined || choice.targetIndex < 0 || choice.targetIndex >= tags.length || !output.hashtags[selected]) return current;
    result = { ...old, hashtags: tags.map((x, i) => i === choice.targetIndex ? output.hashtags[selected] : x) };
    if (!analyzeHashtags(result.hashtags).valid || analyzeHashtags(result.hashtags).duplicateCount) return current;
  } else result = { ...old, hashtags: output.hashtags };
  return { ...current, hasUserEdits: true, selectedTitleIndex: choice.target === 'titles_all' ? 0 : current.selectedTitleIndex, generation: { ...current.generation, result } };
}
export async function submitPartial(o: Options): Promise<PartialResult> {
  const source = o.aiSource ?? getAiSource();
  const cancelled = () => new Error('本次重写已取消，原内容仍保留。');
  if (o.controller.signal.aborted) throw cancelled();
  o.onProgress('正在准备原笔记对应的图片…');
  const compressed = await (o.compress ?? compressImages)(o.images, (done, total) => { if (!o.controller.signal.aborted) o.onProgress(`正在处理图片 ${done} / ${total}`); });
  if (o.controller.signal.aborted) throw cancelled();
  if (compressed.length !== o.images.length) throw new Error('图片处理不完整，原内容仍保留。');
  const form = new FormData();
  form.set('payload', JSON.stringify({ mode: 'live', brief: o.brief, imageIds: o.images.map(x => x.id), ...o.choice, direction: o.direction, instruction: o.instruction, current: o.current, research: o.research }));
  compressed.forEach((blob, i) => form.append('images', blob, `${o.images[i].id}.jpg`));
  if ((await new Response(form).blob()).size > MAX_REQUEST_BYTES) throw new Error('请求体积过大，原内容仍保留。');
  if (o.controller.signal.aborted) throw cancelled();
  
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), o.timeoutMs ?? (isCloudClient() ? 600_000 : 195_000));
  try {
    o.onProgress('AI 正在处理，请稍候…');
    const headers: Record<string, string> = { 'X-Client-Request-Id': crypto.randomUUID(), ...aiSourceHeader(source) };
    if (o.accessToken?.trim()) headers['x-access-token'] = o.accessToken?.trim();
    const response = await (o.request ?? (isCloudClient() ? cloudJobFetch : fetch))('/api/partial-rewrite', { method: 'POST', body: form, headers, signal: AbortSignal.any([o.controller.signal, timeout.signal]) });
    const payload = await response.json().catch(() => null);
    if (o.controller.signal.aborted) throw cancelled();
    if (timeout.signal.aborted) throw new Error('重写等待超时，原内容仍保留。');
    if (!response.ok) throw new Error(typeof payload?.error?.message === 'string' && payload.error.message.length <= 500 ? payload.error.message : response.status === 502 ? 'AI 服务返回异常（HTTP 502），原内容仍保留。' : '重写失败，原内容仍保留。');
    if (!generationMetaSchema.safeParse(payload?.meta).success || !validatePartial(payload?.result, o.choice, o.current, o.images.map(x => x.id))) throw new Error('重写结果不合格，原内容仍保留。请调整要求后重试。');
    return payload.result;
  } catch (e) {
    if (o.controller.signal.aborted) throw cancelled();
    if (timeout.signal.aborted) throw new Error('重写等待超时，原内容仍保留。');
    if (e instanceof TypeError) throw new Error('网络连接失败，原内容仍保留。');
    throw e;
  } finally { clearTimeout(timer); }
}

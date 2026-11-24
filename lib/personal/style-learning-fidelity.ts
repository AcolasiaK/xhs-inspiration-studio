import type { RuleContent, RuleSection } from './style-rules';
import type { StyleAnalysis, StyleReference } from './style-learning';

const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');

/** Keep original punctuation and line rhythm around a selected piece of evidence. */
export function referenceExcerpt(source: string, quote: string, limit = 700) {
  if (!source.trim()) return '';
  const offsets: number[] = [];
  let searchable = '', offset = 0;
  for (const character of source) {
    const normalized = normalize(character);
    searchable += normalized;
    for (let n = 0; n < normalized.length; n++) offsets.push(offset);
    offset += character.length;
  }
  const found = searchable.indexOf(normalize(quote));
  if (found < 0) return ''; // Never replace unavailable evidence with unrelated opening text.
  const center = offsets[found] ?? 0;
  const quoteEnd = (offsets[found + normalize(quote).length - 1] ?? center) + 1;
  // A few adjacent paragraphs retain rhythm without making the whole source note
  // the generation template. Fall back to a bounded window for unbroken prose.
  const breaks = [...source.matchAll(/\r?\n[\t ]*\r?\n/g)];
  const starts = [0, ...breaks.map(match => match.index! + match[0].length)];
  const ends = [...breaks.map(match => match.index!), source.length];
  const first = starts.findLastIndex(start => start <= center);
  const last = starts.findLastIndex(start => start <= quoteEnd);
  let from = first, to = last;
  if (from > 0 && ends[to] - starts[from - 1] <= limit) from--;
  if (to + 1 < starts.length && ends[to + 1] - starts[from] <= limit) to++;
  if (ends[to] - starts[from] <= limit) return source.slice(starts[from], ends[to]).trim();
  const start = Math.max(0, center - Math.floor(limit / 3));
  const end = Math.min(source.length, start + limit);
  const lineStart = source.indexOf('\n', start);
  const lineEnd = source.lastIndexOf('\n', end);
  return source.slice(start > 0 && lineStart < center && lineStart >= 0 ? lineStart + 1 : start, end < source.length && lineEnd > center + quote.length ? lineEnd : end).trim();
}

function portraitFor(analysis: StyleAnalysis, scope: RuleSection) {
  const p = analysis.portrait;
  switch (scope) {
    case 'overall': return `整体气质：${p.temperament}\n换素材时：${p.transfer}`;
    case 'title': return p.titles.available ? `表达方式：${p.titles.expression}\n语言节奏：${p.titles.language}\n吸引力：${p.titles.appeal}\n与正文关系：${p.titles.relation}` : '';
    case 'body': return `整体语气：${p.temperament}\n正文表达：${p.body}`;
    case 'captions': return `整体语气：${p.temperament}\n配文表达：${p.captions}\n图文关系：${p.imageText}`;
    default: return '';
  }
}

/** Attach only selected columns; excerpts are reviewable examples, never current facts. */
export function retainLearnedVoice(content: RuleContent, analysis: StyleAnalysis, indices: number[], references?: StyleReference[]) {
  const traits = indices.map(index => analysis.traits[index]);
  const scopes = new Set(traits.map(trait => trait.scope));
  for (const scope of scopes) {
    // A broad portrait may also summarize a deliberately unchecked trait. Only
    // carry it when the user kept that column's complete set of proposed traits.
    const wholeColumn = analysis.traits.every((trait, index) => trait.scope !== scope || indices.includes(index));
    const portrait = wholeColumn ? portraitFor(analysis, scope) : '';
    const mechanisms = traits.filter(trait => trait.scope === scope).map(trait => `${trait.label}：${trait.observation}`).join('\n');
    const context = [portrait, mechanisms].filter(Boolean).join('\n');
    if (!context || content.sections[scope].includes(context)) continue;
    content.sections[scope] += `\n\n【所选写法的表达画像】\n${context}\n以上画像用于落实所选写法的声音与节奏；不把参考的具体观点、经历或未选写法变成本篇要求。`;
  }
  if (!references) return;
  const candidates: RuleContent['examples'] = [];
  // Round-robin by source then scope keeps title/body/caption evidence represented.
  for (const reference of references) for (const scope of ['title', 'body', 'captions', 'overall'] as const) {
    if (!scopes.has(scope)) continue;
    if (scope === 'overall' && (scopes.has('body') || scopes.has('captions'))) continue;
    const relevant = traits.filter(t => t.scope === scope && t.evidence.some(e => e.referenceId === reference.id));
    if (!relevant.length) continue;
    const evidence = relevant.flatMap(t => t.evidence).filter(e => e.referenceId === reference.id);
    let source = '', quote = evidence[0].quote, position = '';
    if (scope === 'title') source = reference.title;
    else if (scope === 'captions') {
      for (const item of evidence) {
        const image = analysis.imageAnalyses.find(image => image.referenceId === reference.id && item.imageIds.includes(image.imageId) && normalize(image.visibleText).includes(normalize(item.quote)));
        const supplied = reference.images.find(image => item.imageIds.includes(image.id) && normalize(image.caption).includes(normalize(item.quote)));
        if (image || supplied) { source = image ? image.visibleText : supplied!.caption; quote = item.quote; position = ` · 图 ${reference.images.findIndex(i => i.id === (image?.imageId ?? supplied!.id)) + 1}${image ? '' : '（用户补充文字）'}`; break; }
      }
    } else {
      const textEvidence = evidence.find(e => !e.imageIds.length && normalize(reference.text).includes(normalize(e.quote)));
      if (textEvidence) { source = reference.text; quote = textEvidence.quote; }
    }
    const output = referenceExcerpt(source, quote);
    if (!output || content.examples.some(e => e.scope === scope && e.output === output)) continue;
    candidates.push({ id: crypto.randomUUID(), scope, background: `参考 ${references.indexOf(reference) + 1}${position}。仅作语言与节奏样本，其中人物、经历、观点、品牌和引文都不是本次笔记事实，不照搬或补造出处。`, output,
      reason: relevant.map(t => `${t.label}：${t.observation}`).join('\n').slice(0, 1500), disliked: '', changes: '' });
  }
  const byScope = ['title', 'body', 'captions', 'overall'] as const;
  const ordered = byScope.flatMap(scope => candidates.filter(e => e.scope === scope).slice(0, 1));
  ordered.push(...candidates.filter(e => !ordered.includes(e)));
  for (const example of ordered) {
    if (content.examples.length >= 8) break;
    if (!content.examples.some(e => e.scope === example.scope && e.output === example.output)) content.examples.push(example);
  }
}

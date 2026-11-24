import { anyTerm, requiresDestination, type XhsRules, type XhsRule } from './xhs-hotspot-rules';
import type { XhsNote, XhsTopicLabel } from './xhs-hotspots';

const clean = (value: string) => value.toLowerCase().replace(/[\s#·・，,。.!！?？:：/\-_]/g, '');
const synonyms: Record<string, { name: string; terms: string[] }> = {
  赏秋: { name: '秋季赏景旅行', terms: ['赏秋', '秋日', '秋色', '秋景', '红叶', '银杏', '枫叶'] },
  冬日赏雪: { name: '冬季看雪旅行', terms: ['赏雪', '看雪', '雪景', '初雪', '雾凇', '雪原', '冰雪'] },
};
export function normalizeTopic(value: string) {
  let result = clean(value);
  for (const [key, entry] of Object.entries(synonyms)) {
    if ([key, entry.name, ...(key === '冬日赏雪' ? ['冬季赏雪', '冬季赏雪旅行', '赏雪旅行', '看雪旅行'] : ['秋季赏秋', '赏秋旅行'])].map(clean).includes(result)) result = clean(entry.name);
  }
  return result;
}
export function topicIdentity(label: Pick<XhsTopicLabel, 'kind' | 'focus' | 'place'>) {
  return `${label.kind}:${normalizeTopic(label.place || '')}:${normalizeTopic(label.focus)}`;
}
const occurrences = (text: string, term: string) => term && !term.includes('*') ? clean(text).split(clean(term)).length - 1 : 0;
function evidenceFor(note: XhsNote, terms: string[]) {
  if (anyTerm(note.title, terms)) return note.title.slice(0, 200);
  const sentences = note.body.slice(0, 4000).split(/[\n。！？]/).map(s => s.trim()).filter(Boolean);
  return sentences.find(s => anyTerm(s, terms))?.slice(0, 200) || note.tags.find(t => anyTerm(t, terms))?.slice(0, 200) || '';
}
/** A hashtag alone or a passing mention cannot establish a second main subject. */
function salient(note: XhsNote, rule: XhsRule) {
  if (anyTerm(note.title, rule.terms)) return true;
  const body = note.body.slice(0, 4000).replace(/#[^\s#]+/g, '').split(/[\n。！？]/).filter(s => s.trim().length >= 4);
  const matched = body.filter(s => anyTerm(s, rule.terms));
  return (matched.length >= 2 && matched.length / body.length >= 0.2) || (matched.length >= 1 && anyTerm(note.tags.join(' '), rule.terms));
}
function destination(note: XhsNote, rules: XhsRules): string | null {
  const title = note.title.replace(/^.{1,12}出发(?:周末游)?(?:之)?/, '');
  const locationLines = note.body.split('\n').filter(s => /📍|目的地[：:]|地点[：:]/u.test(s));
  const inferred = new Set<string>();
  // Visible place lines and repeated named-place hashtags cover places absent from the dictionary.
  for (const tag of note.tags) {
    const name = tag.replace(/^#/, '').trim();
    if (/^[\p{Script=Han}]{2,12}(?:谷|村|沟|山|岛|寺|古镇|公园|景区)$/u.test(name) && !/爬山|登山|雪山|火山|海岛|小岛|乡村|农村/.test(name) &&
      (title.includes(name) || locationLines.some(line => line.includes(name)) || occurrences(note.body, name) >= 2)) inferred.add(name);
  }
  for (const line of locationLines) {
    const name = line.replace(/^.*(?:📍|目的地[：:]|地点[：:])/u, '').split(/[·・|]/).at(-1)?.trim().replace(/[（(].*$/, '').trim();
    if (name && /^[\p{Script=Han}]{2,14}(?:谷|村|沟|山|岛|寺|古镇|公园|景区)$/u.test(name) && (title.includes(name) || occurrences(note.body, name) >= 2)) inferred.add(name);
  }
  const candidates = [...inferred].map(name => ({ name, terms: [name], inferred: true }));
  candidates.push(...rules.destinations.map(row => ({ ...row, inferred: false })));
  const scored = candidates.map(place => {
    const inTitle = anyTerm(title, place.terms), located = locationLines.some(line => anyTerm(line, place.terms));
    const exactTag = note.tags.some(tag => place.terms.some(term => clean(tag) === clean(term)));
    const bodyMentions = Math.max(0, ...place.terms.map(term => occurrences(note.body, term)));
    // “杭州周边游” or “北京出发” is never treated as destination evidence on its own.
    return { ...place, score: (inTitle ? 100 : 0) + (located ? 80 : 0) + (exactTag ? 20 : 0) + Math.min(bodyMentions, 10) + (place.inferred ? 5 : 0), valid: inTitle || located || exactTag || bodyMentions >= 2 };
  }).filter(p => p.valid).sort((a, b) => b.score - a.score || b.name.length - a.name.length);
  return scored[0]?.name || null;
}

/** Deterministic fallback; AI can infer additional subjects only when explicitly enabled. */
export function ruleTopicLabels(note: XhsNote, rules: XhsRules): XhsTopicLabel[] {
  const c = rules.categories[note.category], broad = new Set([...rules.broadTopics, ...rules.genericTags].map(clean));
  const facets = c.topics.filter(row => !broad.has(clean(row.name))).map(row => ({ ...row, terms: [...row.terms, ...(synonyms[row.name]?.terms || [])] })).filter(row => salient(note, row));
  const place = requiresDestination(rules, note.category) ? destination(note, rules) : null;
  const result: XhsTopicLabel[] = [];
  // A named local event is a specific topic even when the posts take different angles.
  if (place) for (const event of ['秋社', '灯会', '花灯节', '音乐节', '泼水节', '庙会', '冰雪节']) {
    if (salient(note, { name: event, terms: [event] }) || occurrences(note.body, event) >= 2) result.push({ name: `${place}${event}`, kind: 'specific', focus: event, place, evidence: evidenceFor(note, [event]) });
  }
  const localEvent = result.length > 0;
  for (const facet of facets.slice(0, 3)) {
    const focus = synonyms[facet.name]?.name || facet.name, evidence = evidenceFor(note, facet.terms);
    // An event already anchors the local topic; its season need not occupy another slot.
    if (place && !(localEvent && synonyms[facet.name])) result.push({ name: `${place} · ${focus}`, kind: 'specific', focus, place, evidence });
    if (!/^(旅行|旅游|游玩|出游)攻略$/.test(focus)) result.push({ name: focus, kind: 'direction', focus, place: null, evidence });
  }
  return [...new Map(result.map(label => [topicIdentity(label), label])).values()].slice(0, 6);
}

/** Reject unsupported labels; retain author/count/time exclusively from the collected note. */
export function supportedTopicLabels(note: XhsNote, labels: XhsTopicLabel[], rules: XhsRules) {
  const text = clean(`${note.title}\n${note.tags.join('\n')}\n${note.body.slice(0, 4000)}`);
  const broad = new Set([...rules.broadTopics, ...rules.genericTags, rules.categories[note.category]?.name || note.category].map(clean));
  return labels.filter(label => !broad.has(clean(label.name)) && !broad.has(clean(label.focus)) && text.includes(clean(label.evidence)) &&
    (label.kind === 'direction' ? label.place === null : !label.place || text.includes(clean(label.place)))).map(label => {
      // Configured names are stable identities, including mixed AI/rule batches.
      // Keep kind/place: similarly named local topics must not pool unrelated places.
      const configured = rules.categories[note.category]?.topics.find(topic =>
        normalizeTopic(label.name) === normalizeTopic(topic.name) ||
        (label.place && normalizeTopic(label.name) === normalizeTopic(`${label.place} · ${topic.name}`)) ||
        normalizeTopic(label.focus) === normalizeTopic(topic.name));
      return configured ? { ...label, focus: synonyms[configured.name]?.name || configured.name } : label;
    });
}

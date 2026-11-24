import { DEFAULT_XHS_RULES, XHS_MIN_THEME_TARGET, anyTerm, effectiveRules, requiresDestination, themeInteractionFloor, type XhsRules } from './xhs-hotspot-rules';
import { createHash } from 'node:crypto';
import { beijingDate, type XhsCandidateTheme, type XhsCategory, type XhsNote, type XhsTheme, type XhsTopicLabel } from './xhs-hotspots';

import { normalizeTopic, topicIdentity, ruleTopicLabels, supportedTopicLabels } from './xhs-topic-labels';

const DAY = 86_400_000;
/** Visible edited dates never establish the original publication time. */
export function parseXhsPublishedAt(label: string, now: string): string | null {
  if (/编辑|更新|修改/.test(label)) return null;
  const text = label.trim(), current = new Date(now);
  const relative = text.match(/^(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) {
    const unit: Record<string, number> = { 秒: 1000, 分钟: 60000, 小时: 3600000, 天: DAY };
    return new Date(current.getTime() - Number(relative[1]) * unit[relative[2]]).toISOString();
  }
  if (/^刚刚/.test(text)) return current.toISOString();
  const today = beijingDate(current), year = Number(today.slice(0, 4));
  const localTime = text.match(/^(今天|昨天|前天)(?:\s+(\d{1,2}):(\d{2}))?/);
  if (localTime) {
    const days = { 今天: 0, 昨天: 1, 前天: 2 }[localTime[1]]!;
    const date = beijingDate(new Date(current.getTime() - days * DAY));
    return new Date(`${date}T${(localTime[2] || '00').padStart(2, '0')}:${localTime[3] || '00'}:00+08:00`).toISOString();
  }
  const full = text.match(/^(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
  const short = text.match(/^(\d{1,2})[-月/.](\d{1,2})(?:日|\s|$)/);
  if (!full && !short) return null;
  let y = full ? Number(full[1]) : year;
  const m = Number(full ? full[2] : short![1]), d = Number(full ? full[3] : short![2]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const make = () => new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+08:00`);
  let parsed = make();
  if (!full && parsed.getTime() > current.getTime()) { y--; parsed = make(); }
  if (!Number.isFinite(parsed.getTime()) || beijingDate(parsed) !== `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`) return null;
  return parsed.toISOString();
}
export function withinSevenDays(publishedAt: string | null, now: string): boolean {
  if (!publishedAt) return false;
  const age = Date.parse(now) - Date.parse(publishedAt);
  return Number.isFinite(age) && age >= 0 && age <= 7 * DAY;
}
export function parseXhsCount(text: string | null | undefined): number | null {
  if (text == null) return null;
  const s = text.trim().replace(/,/g, '');
  if (/^(赞|点赞|收藏|评论)$/.test(s)) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([万亿wWkK]?)\+?$/);
  if (!m) return null;
  const factor = ({ 万: 10000, 亿: 100000000, w: 10000, W: 10000, k: 1000, K: 1000 } as Record<string, number>)[m[2]] || 1;
  const value = Math.round(Number(m[1]) * factor);
  return value <= 1_000_000_000 ? value : null;
}
export function matchesCategory(note: Pick<XhsNote, 'title' | 'body' | 'tags'> & Partial<Pick<XhsNote, 'scopeMatch' | 'topicRuleKey'>>, category: XhsCategory, rules: XhsRules = DEFAULT_XHS_RULES): boolean {
 rules = effectiveRules(rules, category);
 if (rules.categories[category]?.semantic?.enabled && note.topicRuleKey === semanticRulesKey(rules, category) && note.scopeMatch === false) return false;
 const text = `${note.title} ${note.tags.join(' ')} ${note.body.slice(0, 4000)}`;
 if (anyTerm(text, rules.excludeTerms)) return false;
 return Boolean(rules.categories[category] && anyTerm(text, rules.categories[category].includeTerms));
}
export function withinWindow(publishedAt: string | null, now: string, days: number) {
 const age = publishedAt ? Date.parse(now) - Date.parse(publishedAt) : NaN;
 return Number.isFinite(age) && age >= 0 && age <= days * DAY;
}
export function heatScore(note: Pick<XhsNote, 'likes' | 'collects' | 'comments'>, rules: XhsRules = DEFAULT_XHS_RULES) {
 return note.likes * rules.weights.likes + note.collects * rules.weights.collects + note.comments * rules.weights.comments;
}
export function themeLabel(note: XhsNote, config: XhsRules = DEFAULT_XHS_RULES): string {
 config = effectiveRules(config, note.category);
 const text = `${note.title} ${note.tags.join(' ')}`, rules = config.categories[note.category]?.topics || [];
 const facet = rules.find(r => anyTerm(note.title, r.terms))?.name || rules.find(r => anyTerm(text, r.terms))?.name;
 if (requiresDestination(config, note.category)) {
  const title = note.title.replace(/^.{1,12}出发(?:周末游)?(?:之)?/, '');
  const destination = config.destinations.find(r => anyTerm(title, r.terms))?.name || config.destinations.find(r => anyTerm(note.tags.join(' '), r.terms))?.name;
  if (destination) return `${destination} · ${facet || '旅行见闻'}`;
 }
 if (facet) return facet;
 const tag = note.tags.map(t => t.replace(/^#/, '').trim()).find(t => t.length >= 3 && t.length <= 16 && !config.genericTags.some(g => g.toLowerCase().replace(/\s+/g, '') === t.toLowerCase().replace(/\s+/g, '')));
 return tag || note.title.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '').trim().slice(0, 50) || note.title.slice(0, 50);
}
export function rankXhsThemes(notes: XhsNote[], category: XhsCategory, now: string, rules: XhsRules = DEFAULT_XHS_RULES): XhsTheme[] {
  rules = effectiveRules(rules, category);
  const seen = new Set<string>(), groups = new Map<string, XhsNote[]>();
  for (const note of notes) {
    if (seen.has(note.id) || note.category !== category || !withinWindow(note.publishedAt, now, rules.windowDays) || !matchesCategory(note, category, rules)) continue;
    seen.add(note.id);
    const label = themeLabel(note, rules), group = groups.get(label) || [];
    group.push(note); groups.set(label, group);
  }
  return [...groups].map(([title, members]) => {
    members.sort((a, b) => heatScore(b, rules) - heatScore(a, rules) || a.id.localeCompare(b.id));
    const total = (key: 'likes' | 'collects' | 'comments') => members.reduce((sum, note) => sum + note[key], 0);
    return { id: createHash('sha256').update(`${category}:${title}`).digest('hex').slice(0, 20), category, title, rank: 1, heat: members.reduce((sum, note) => sum + heatScore(note, rules), 0), likes: total('likes'), collects: total('collects'), comments: total('comments'), noteCount: members.length, noteIds: members.map(n => n.id), representatives: members.slice(0, rules.representatives).map(n => n.id) };
  }).sort((a, b) => b.heat - a.heat || b.noteCount - a.noteCount || a.id.localeCompare(b.id)).slice(0, rules.topicLimit).map((theme, i) => ({ ...theme, rank: i + 1 }));
}

/** A broad label or a lone destination is insufficient to establish a shared topic. */
export function semanticRulesKey(rules: XhsRules, category: string) {
 const r = effectiveRules(rules, category), c = r.categories[category];
 return createHash('sha256').update(JSON.stringify(['multi-topic-v3', c?.demand, c?.queries, c?.includeTerms, c?.topics, requiresDestination(r, category), r.excludeTerms, r.broadTopics, r.destinations])).digest('hex');
}
export function specificThemeLabels(note: XhsNote, rules: XhsRules): XhsTopicLabel[] {
  rules = effectiveRules(rules, note.category);
  if (rules.categories[note.category]?.semantic?.enabled && note.topicRuleKey === semanticRulesKey(rules, note.category) && note.topicLabels !== undefined) {
    return supportedTopicLabels(note, note.topicLabels, rules);
  }
  return ruleTopicLabels(note, rules);
}
export function specificThemeLabel(note: XhsNote, rules: XhsRules): string | null {
  return specificThemeLabels(note, rules)[0]?.name || null;
}

/** V3: group first, qualify the whole subject, then suppress redundant chart positions. */
export function rankQualifiedXhsThemes(notes: XhsNote[], category: XhsCategory, now: string, rules: XhsRules = DEFAULT_XHS_RULES) {
  rules = effectiveRules(rules, category);
  const gate = rules.categories[category], seen = new Set<string>(), eligible: XhsNote[] = [];
  const groups = new Map<string, { label: XhsTopicLabel; members: Map<string, XhsNote> }>();
  const diagnostics = { eligibleNotes: 0, lowInteraction: 0, unknownAuthors: 0, noSpecificTopic: 0, authorDuplicates: 0, mergedThemes: 0, rejectedThemes: [] as { title: string; reason: string; notes: number; authors: number }[] };
  const raw = (note: XhsNote) => note.likes + note.collects + note.comments;
  for (const note of notes) {
    if (seen.has(note.id) || note.category !== category || !withinWindow(note.publishedAt, now, rules.windowDays) || !matchesCategory(note, category, rules)) continue;
    seen.add(note.id);
    if (raw(note) < gate.minInteractions) diagnostics.lowInteraction++;
    // Zero-interaction posts cannot pad the evidence count. Moderate posts remain eligible.
    if (!raw(note)) continue;
    eligible.push(note); diagnostics.eligibleNotes++;
    if (!note.authorId) diagnostics.unknownAuthors++;
    const labels = specificThemeLabels(note, rules);
    if (!labels.length) diagnostics.noSpecificTopic++;
    if (!note.authorId) continue;
    for (const label of labels) {
      const key = topicIdentity(label), group = groups.get(key) || { label, members: new Map<string, XhsNote>() };
      group.members.set(note.id, note); groups.set(key, group);
    }
  }
  const themes: XhsTheme[] = [], candidates: XhsCandidateTheme[] = [], acceptedIds = new Set<string>();
  for (const [key, group] of groups) {
    const members = [...group.members.values()].sort((a, b) => heatScore(b, rules) - heatScore(a, rules) || a.id.localeCompare(b.id));
    const authors = new Map<string, XhsNote>(), authorRaw = new Map<string, number>();
    for (const note of members) {
      if (!authors.has(note.authorId!)) authors.set(note.authorId!, note);
      authorRaw.set(note.authorId!, Math.max(authorRaw.get(note.authorId!) || 0, raw(note)));
    }
    // A weight change cannot bypass the raw theme floor; each author counts only once.
    const rawInteractions = [...authorRaw.values()].reduce((sum, value) => sum + value, 0);
    const verificationReasons = [members.length < gate.minNotes ? `相关笔记不足 ${gate.minNotes} 篇` : '', authors.size < gate.minAuthors ? `可核实作者不足 ${gate.minAuthors} 位` : '', rawInteractions < themeInteractionFloor(gate) ? `主题总互动不足 ${themeInteractionFloor(gate)}` : ''].filter(Boolean);
    const counted = [...authors.values()];
    const sum = (field: 'likes' | 'collects' | 'comments') => counted.reduce((s, n) => s + n[field], 0);
    const theme: XhsTheme = { id: createHash('sha256').update(`${category}:${key}`).digest('hex').slice(0, 20), category, title: group.label.name, kind: group.label.kind, focus: group.label.focus, place: group.label.place,
      rank: 1, heat: counted.reduce((s, n) => s + heatScore(n, rules), 0), rawInteractions, likes: sum('likes'), collects: sum('collects'), comments: sum('comments'),
      authorCount: authors.size, noteCount: members.length, noteIds: members.map(n => n.id), countedNoteIds: counted.map(n => n.id), representatives: counted.slice(0, rules.representatives).map(n => n.id), relatedTopics: [] };
    if (verificationReasons.length) {
      diagnostics.rejectedThemes.push({ title: group.label.name, reason: verificationReasons[0], notes: members.length, authors: authors.size });
      candidates.push({ ...theme, verificationReasons }); continue;
    }
    diagnostics.authorDuplicates += members.length - counted.length;
    members.forEach(n => acceptedIds.add(n.id));
    themes.push({ ...theme, qualifiedNoteCount: members.length });
  }
  const scoreOrder = (a: XhsTheme, b: XhsTheme) => b.heat - a.heat || (b.authorCount || 0) - (a.authorCount || 0) || b.noteCount - a.noteCount || a.id.localeCompare(b.id);
  const retained: XhsTheme[] = [], byId = new Map(eligible.map(n => [n.id, n]));
  // Prefer the more precise subject when an umbrella adds no independent evidence.
  for (const theme of themes.sort((a, b) => Number(a.kind === 'direction') - Number(b.kind === 'direction') || scoreOrder(a, b))) {
    const parent = retained.find(other => {
      if (normalizeTopic(other.focus || other.title) !== normalizeTopic(theme.focus || theme.title)) return false;
      if (other.kind === theme.kind && normalizeTopic(other.place || '') !== normalizeTopic(theme.place || '')) return false;
      const ids = new Set(other.noteIds), intersection = theme.noteIds.filter(id => ids.has(id)).length;
      const union = new Set([...other.noteIds, ...theme.noteIds]).size;
      const newAuthors = new Set(theme.noteIds.filter(id => !ids.has(id)).map(id => byId.get(id)?.authorId).filter(Boolean));
      const existingAuthors = new Set(other.noteIds.map(id => byId.get(id)?.authorId));
      const independentAuthors = [...newAuthors].filter(id => !existingAuthors.has(id)).length;
      return intersection / union * 100 >= (gate.overlapPercent ?? 80) && independentAuthors < gate.minAuthors;
    });
    if (parent) {
      parent.relatedTopics!.push({ title: theme.title, kind: theme.kind!, reason: '支撑笔记高度重叠，新增作者证据不足，保留关联且不重复占榜。', noteIds: theme.noteIds });
      diagnostics.mergedThemes++;
    } else retained.push(theme);
  }
  const ranked = retained.sort(scoreOrder).slice(0, rules.topicLimit).map((theme, i) => ({ ...theme, rank: i + 1 }));
  const candidateThemes: XhsCandidateTheme[] = [];
  for (const candidate of candidates.sort((a, b) => (b.authorCount || 0) - (a.authorCount || 0) || scoreOrder(a, b))) {
    if (ranked.length + candidateThemes.length >= XHS_MIN_THEME_TARGET) break;
    // Distinct names alone cannot turn the same evidence into several filler slots.
    const duplicate = [...ranked, ...candidateThemes].some(other =>
      normalizeTopic(other.title) === normalizeTopic(candidate.title)
      || other.noteIds.length === candidate.noteIds.length && candidate.noteIds.every(id => other.noteIds.includes(id))
      || normalizeTopic(other.focus || other.title) === normalizeTopic(candidate.focus || candidate.title) && normalizeTopic(other.place || '') === normalizeTopic(candidate.place || ''));
    if (!duplicate) candidateThemes.push({ ...candidate, rank: ranked.length + candidateThemes.length + 1 });
  }
  const singleAuthors = new Set<string>();
  const singleNoteIds = eligible.filter(n => raw(n) >= gate.minInteractions && !acceptedIds.has(n.id)).sort((a, b) => heatScore(b, rules) - heatScore(a, rules) || a.id.localeCompare(b.id)).filter(n => {
    const key = n.authorId || n.id; if (singleAuthors.has(key)) return false; singleAuthors.add(key); return true;
  }).slice(0, rules.topicLimit).map(n => n.id);
  return { themes: ranked, candidateThemes, singleNoteIds, diagnostics };
}

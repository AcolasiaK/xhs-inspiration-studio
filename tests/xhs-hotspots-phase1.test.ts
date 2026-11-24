import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_XHS_RULES, xhsRulesSchema, categoryRulesSignature } from '../lib/xhs-hotspot-rules';
import { rankQualifiedXhsThemes } from '../lib/xhs-hotspot-ranking';
import { blankCategory, type XhsNote, type XhsCategory } from '../lib/xhs-hotspots';
import { defaultRulesVersion, XhsRulesStore } from '../lib/server/xhs-hotspot-rules-store';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { AppError } from '../lib/errors';
import { xhsPublicationFilter } from '../lib/server/xhs-hotspots-browser';
const now = '2026-11-12T12:00:00.000Z';
const hex = (n: number) => n.toString(16).padStart(24, '0');
const note = (n: number, patch: Partial<XhsNote> = {}): XhsNote => ({ id: hex(n), authorId: hex(100 + n), author: '可重复的昵称', title: '新疆冬季自驾旅行', category: 'travel', query: '新疆旅行', url: `https://www.xiaohongshu.com/explore/${hex(n)}`, body: '新疆冬季自驾旅行路线', tags: ['新疆旅行'], likes: 700, collects: 300, comments: 0, publishedAt: '2026-11-10T00:00:00.000Z', dateLabel: '2天前', collectedAt: now, coverFile: null, coverUrl: null, fingerprint: hex(n), ...patch });
const rules = () => structuredClone(DEFAULT_XHS_RULES);

test('eligibility uses raw metrics, requires real distinct authors and never fills a short list', () => {
  const r = rules(); r.weights = { likes: 10, collects: 10, comments: 10 };
  const low = note(1, { likes: 9, collects: 11, comments: 10 });
  const only = note(2), single = rankQualifiedXhsThemes([low, only], 'travel', now, r);
  assert.equal(single.themes.length, 0); assert.deepEqual(single.singleNoteIds, [only.id]); assert.equal(single.diagnostics.lowInteraction, 1);
  const sameAuthor = note(3, { authorId: only.authorId });
  assert.equal(rankQualifiedXhsThemes([only, sameAuthor], 'travel', now, r).themes.length, 0);
  assert.equal(rankQualifiedXhsThemes([only, note(4, { authorId: null })], 'travel', now, r).themes.length, 0);
  const valid = rankQualifiedXhsThemes([only, note(5)], 'travel', now, r);
  assert.equal(valid.themes.length, 1); assert.equal(valid.themes[0].authorCount, 2); assert.equal(valid.themes[0].heat, 20000);
  assert.deepEqual(valid.singleNoteIds, []);
});
test('theme scores include moderate notes, count one maximum per author and deduplicate source IDs', () => {
  const a = note(1), b = note(2), duplicateAuthor = note(3, { authorId: a.authorId, likes: 2000 }), low = note(4, { likes: 1, collects: 1 });
  const ranked = rankQualifiedXhsThemes([a, b, duplicateAuthor, low, b], 'travel', now);
  assert.equal(ranked.themes[0].heat, 3302); assert.equal(ranked.themes[0].qualifiedNoteCount, 4); assert.equal(ranked.themes[0].noteCount, 4);
  assert.deepEqual(ranked.themes[0].representatives, [duplicateAuthor.id, b.id, low.id]); assert.equal(ranked.themes[0].authorCount, 3);
});
test('recent high interactions alone cannot form a generic or stale theme', () => {
  const generic = [note(1, { category: 'daily', title: '独居生活', tags: ['独居生活'], body: '独居生活' }), note(2, { category: 'daily', title: '独居生活', tags: [], body: '独居生活' })];
  const ranked = rankQualifiedXhsThemes(generic, 'daily', now);
  assert.equal(ranked.themes.length, 0); assert.equal(ranked.singleNoteIds.length, 2); assert.equal(ranked.diagnostics.noSpecificTopic, 2);
  assert.equal(rankQualifiedXhsThemes([note(1), note(2, { publishedAt: '2026-10-01T00:00:00.000Z' })], 'travel', now).themes.length, 0);
  const r = rules(); r.categories.daily.topics = [{ name: '独居生活', terms: ['独居'] }, { name: '整理收纳', terms: ['收纳'] }];
  const specific = [1, 2].map(n => note(n, { category: 'daily', title: '独居生活里的整理收纳', tags: [] }));
  assert.equal(rankQualifiedXhsThemes(specific, 'daily', now, r).themes[0].title, '整理收纳');
});
test('category rules are independent and old settings gain eligibility defaults without losing keywords', async () => {
  const r = rules(), before = categoryRulesSignature(r, 'wedding'); r.categories.travel.queries = ['新疆旅行']; r.categories.travel.minInteractions = 2000;
  assert.equal(categoryRulesSignature(r, 'wedding'), before); assert.notEqual(categoryRulesSignature(r, 'travel'), categoryRulesSignature(rules(), 'travel'));
  const old = JSON.parse(JSON.stringify(r)); delete old.searchSorts; delete old.candidateBudget; delete old.detailBudget; delete old.broadTopics;
  for (const c of Object.values(old.categories) as Record<string, unknown>[]) { delete c.minInteractions; delete c.minAuthors; delete c.minNotes; }
  const folder = await mkdtemp(join(tmpdir(), 'xhs-old-config-')), file = join(folder, 'rules.json');
  await writeFile(file, JSON.stringify({ revision: 'existing-user-revision', updatedAt: now, rules: old })); const bytes = await readFile(file, 'utf8');
  const value = await new XhsRulesStore(file).read(); assert.deepEqual(value.rules.categories.travel.queries, ['新疆旅行']); assert.equal(value.rules.categories.travel.minInteractions, 1000);
  assert.deepEqual(value.rules.searchSorts, ['likes', 'collects']); assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(xhsRulesSchema.safeParse({ ...r, detailBudget: r.candidateBudget + 1 }).success, false);
  assert.equal(xhsPublicationFilter(1), '一天内'); assert.equal(xhsPublicationFilter(7), '一周内'); assert.equal(xhsPublicationFilter(14), '半年内');
});
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-phase1-')), file = join(folder, 'data.json'); let date = new Date(now); const runs: XhsCategory[][] = [];
  const deps = { file, now: () => date, readRules: async () => defaultRulesVersion(), analyze: async () => { throw new Error('AI must not be called'); }, collect: async (time: string, _p: unknown, save: (c: XhsCategory, result: ReturnType<typeof blankCategory>) => Promise<void>, categories: XhsCategory[] = []) => { runs.push(categories); for (const c of categories) await save(c, { ...blankCategory(), collectedAt: time, attemptedAt: time }); } };
  return { file, deps, runs, setDate: (time: string) => { date = new Date(time); }, store: new XhsHotspotsStore(deps) };
}
test('manual category refresh preserves every other category; scheduler fills only missing categories', async () => {
  const f = await fixture(); await f.store.update(true, ['travel']); await f.store.waitForUpdate();
  let state = await f.store.state(); const travel = structuredClone(state.categories.travel);
  assert.equal(state.categories.wedding.collectedAt, null); assert.equal(state.categories.wedding.attemptedAt, null);
  await f.store.update(false); await f.store.waitForUpdate(); state = await f.store.state();
  assert.deepEqual(f.runs, [['travel'], ['wedding', 'daily']]); assert.deepEqual(state.categories.travel, travel);
  const before = JSON.parse(await readFile(f.file, 'utf8'));
  f.setDate('2026-11-12T13:00:00.000Z'); await f.store.update(true, ['travel']); await f.store.waitForUpdate();
  const after = JSON.parse(await readFile(f.file, 'utf8')); assert.deepEqual(after.categories.wedding, before.categories.wedding); assert.deepEqual(after.categories.daily, before.categories.daily);
});
test('category failures and retry timestamps do not invalidate unrelated successful results', async () => {
  const f = await fixture(); await f.store.update(true); await f.store.waitForUpdate();
  const before = await f.store.state();
  const failed = new XhsHotspotsStore({ ...f.deps, collect: async () => { throw new AppError('XHS_FILTER', '筛选失败', 502); } });
  f.setDate('2026-11-12T13:00:00.000Z'); await failed.update(true, ['travel']); await failed.waitForUpdate();
  const after = await failed.state(); assert.deepEqual(after.categories.wedding, before.categories.wedding); assert.deepEqual(after.categories.daily, before.categories.daily); assert.equal(after.categories.travel.collectedAt, before.categories.travel.collectedAt); assert.equal(after.categories.travel.error, '筛选失败');
  f.setDate('2026-11-12T13:31:00.000Z'); const retry = new XhsHotspotsStore(f.deps); await retry.update(false); await retry.waitForUpdate(); assert.deepEqual(f.runs.at(-1), ['travel']);
});
test('same-category duplicate updates reuse the run; a different scope is explicitly rejected', async () => {
  const f = await fixture(); let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  const store = new XhsHotspotsStore({ ...f.deps, collect: async (time, progress, save, categories) => { await barrier; await f.deps.collect(time, progress, save, categories); } });
  const repeated = await Promise.all([store.update(true, ['travel']), store.update(true, ['travel'])]);
  assert.ok(repeated.every(s => s.updating)); assert.deepEqual((await store.state()).updatingCategories, ['travel']);
  assert.equal((await store.update(true, ['travel'])).updating, true); await assert.rejects(store.update(true, ['wedding']), /另一个分类/);
  finish(); await store.waitForUpdate(); assert.deepEqual((await store.state()).updatingCategories, []);
  await assert.rejects(store.update(true, []), /有效的热点分类/);
});
test('old category rule snapshots stay byte-for-byte equivalent when updating another category', async () => {
  const f = await fixture(); await f.store.update(true); await f.store.waitForUpdate();
  const cache = JSON.parse(await readFile(f.file, 'utf8'));
  for (const c of ['wedding', 'daily']) {
    const r = cache.categories[c].ruleSnapshot.rules; delete r.searchSorts; delete r.candidateBudget; delete r.detailBudget; delete r.broadTopics;
    for (const category of Object.values(r.categories) as Record<string, unknown>[]) { delete category.minInteractions; delete category.minNotes; delete category.minAuthors; }
  }
  await writeFile(f.file, JSON.stringify(cache)); const prior = JSON.stringify(cache.categories.wedding);
  await f.store.update(true, ['travel']); await f.store.waitForUpdate(); assert.equal(JSON.stringify(JSON.parse(await readFile(f.file, 'utf8')).categories.wedding), prior);
});

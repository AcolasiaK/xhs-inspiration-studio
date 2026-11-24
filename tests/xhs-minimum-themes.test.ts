import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_XHS_RULES } from '../lib/xhs-hotspot-rules';
import { rankQualifiedXhsThemes, semanticRulesKey } from '../lib/xhs-hotspot-ranking';
import { categoryResultSchema, type XhsNote } from '../lib/xhs-hotspots';
import { collectCategory, type SearchTask, type XhsCandidate } from '../lib/server/xhs-collection-engine';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { xhsFixtureAnalysis } from './xhs-fixture';
import { AppError } from '../lib/errors';

const now = '2026-11-14T14:00:00.000Z';
const hex = (n: number) => n.toString(16).padStart(24, '0');
const names = ['感恩日记', '独处感悟', '接纳自己', '情绪复盘', '建立边界'];
function rules() {
 const r = structuredClone(DEFAULT_XHS_RULES);
 r.categories.check = { name: '情绪', queries: ['日常感悟'], includeTerms: ['日常'], requireDestination: false,
  topics: names.map(name => ({ name, terms: [name] })), minInteractions: 100, minThemeInteractions: 500, minNotes: 2, minAuthors: 2,
  settings: { windowDays: 30, topicLimit: 1, searchSorts: ['likes', 'collects'], candidateBudget: 200, detailBudget: 100, maxMinutes: 30, noNewRounds: 2 } };
 return r;
}
const card = (id: number): XhsCandidate => ({ id: hex(id), title: '合成测试', authorId: hex(id + 1000), date: '今天', likes: '500', own: false, top: id });
const note = (id: number, topic = names[Math.floor((id - 1) / 2) % 5]): XhsNote => ({
 id: hex(id), authorId: hex(id + 1000), author: '合成作者', title: `日常${topic}`, body: `日常${topic}的真实体验`, tags: [], category: 'check', query: '日常感悟',
 likes: 500, collects: 10, comments: 0, publishedAt: now, dateLabel: '今天', collectedAt: now, url: `https://www.xiaohongshu.com/explore/${hex(id)}`, coverFile: null, coverUrl: null, fingerprint: hex(id),
});

test('continues through noisy rounds to five distinct supported themes despite a legacy display limit of one', async () => {
 const config = rules(), original = JSON.stringify(config), tasks: SearchTask[] = [];
 const got = await collectCategory('check', config, now, {
  async *search(task) { tasks.push(task); yield Array.from({ length: 28 }, (_, i) => card(i + 1)).filter(c => !task.processedIds?.includes(c.id)); },
  async inspect(c) { const id = parseInt(c.id, 16); return id <= 18 ? { reason: 'outsideWindow' } : { note: note(id, names[Math.floor((id - 19) / 2)]) }; },
 }, () => {});
 assert.equal(got.themes.length, 5);
 assert.ok(got.themes.every(t => t.authorCount === 2 && t.noteCount === 2));
 assert.ok(tasks.some(t => t.sort === 'latest'), 'must inspect recent content as well as accumulated likes');
 assert.equal(JSON.stringify(config), original, 'run policy must not rewrite saved settings');
 const persisted = categoryResultSchema.parse(got);
 assert.deepEqual(persisted.run?.themeTarget, { minimum: 5, found: 5, status: 'met' });
});

test('supplements before exhausting a noisy original source and preserves the configured time window', async () => {
 const config = rules(), tasks: SearchTask[] = [];
 const got = await collectCategory('check', config, now, {
  async *search(task) {
   tasks.push(task);
   const ids = task.supplemental ? Array.from({ length: 10 }, (_, i) => i + 1) : Array.from({ length: 100 }, (_, i) => i + 100);
   yield ids.map(card).filter(c => !task.processedIds?.includes(c.id));
  },
  async inspect(c) { const id = parseInt(c.id, 16); return id < 100 ? { note: note(id) } : { reason: 'outsideWindow' }; },
 }, () => {});
 assert.equal(got.themes.length, 5);
 assert.ok(tasks.findIndex(t => t.supplemental) < 8, 'targeted search must happen before burning the original pool');
 assert.equal(tasks[0].windowDays, 7, 'recent hot results get the first slice');
 assert.ok(tasks.some(t => t.sort === 'latest' && t.windowDays === 30));
 assert.ok(tasks.every(t => t.windowDays! <= 30));
});

test('exhausted evidence returns explicit shortfall without fake themes or weakened author gates', async () => {
 const got = await collectCategory('check', rules(), now, {
  async *search() { yield [card(1)]; }, async inspect() { return { note: note(1) }; },
 }, () => {});
 assert.equal(got.themes.length, 0); assert.equal(got.notes.length, 1);
 assert.deepEqual(categoryResultSchema.parse(got).run?.themeTarget, { minimum: 5, found: 1, status: 'shortfall' });
 assert.match(got.run!.stopReason, /不足.*5/);
 assert.deepEqual(got.singleNoteIds, [hex(1)]);
});

test('real candidate topics supplement five selections without passing the hotspot evidence gate', async () => {
 const source = names.flatMap((name, index) => index === 0 ? [note(1, name), note(2, name)] : [note(index + 2, name)]);
 const got = await collectCategory('check', rules(), now, {
  async *search() { yield source.map(n => card(parseInt(n.id, 16))); },
  async inspect(c) { return { note: source.find(n => n.id === c.id)! }; },
 }, () => {});
 const parsed = categoryResultSchema.parse(got);
 assert.equal(parsed.themes.length, 1);
 assert.equal(parsed.candidateThemes?.length, 4);
 assert.equal(parsed.run?.themeTarget?.found, 5);
 assert.equal(parsed.run?.themeTarget?.status, 'met');
 for (const candidate of parsed.candidateThemes!) {
  assert.ok(candidate.noteIds.every(id => source.some(n => n.id === id)));
  assert.ok(candidate.verificationReasons.some(reason => /笔记不足|作者不足/.test(reason)));
 }
});

test('candidate supplements never admit irrelevant or expired sources or clone one note into five topics', () => {
 const config = rules();
 const source = [note(1), { ...note(2, names[1]), publishedAt: '2025-01-01T00:00:00.000Z' }, { ...note(3, names[2]), title: '其他范围', body: '其他范围' }];
 const got = rankQualifiedXhsThemes(source, 'check', now, config);
 assert.equal(got.candidateThemes.length, 1);
 assert.deepEqual(got.candidateThemes[0].noteIds, [hex(1)]);
 const one = { ...note(1), title: `日常${names.join('、')}`, body: `日常${names.join('、')}` };
 assert.equal(rankQualifiedXhsThemes([one], 'check', now, config).candidateThemes.length, 1);
});

test('hard budgets remain bounded while the five-theme target is unmet', async () => {
 const config = rules(); config.categories.check.settings!.detailBudget = 10;
 let inspected = 0, id = 0;
 const got = await collectCategory('check', config, now, {
  async *search() { yield Array.from({ length: 40 }, () => card(++id)); },
  async inspect() { inspected++; return { reason: 'unknownDate' }; },
 }, () => {});
 assert.equal(inspected, 10); assert.equal(got.themes.length, 0);
 assert.equal(got.run?.themeTarget?.status, 'shortfall');
 assert.match(got.run!.stopReason, /详情核验预算/);
});

test('configured theme identity unifies AI wording with rule labels without mixing places', () => {
 const config = rules(); config.categories.check.settings!.topicLimit = 10;
 config.categories.check.semantic = { enabled: true, profileId: 'synthetic', maxCalls: 0 };
 const key = semanticRulesKey(config, 'check');
 const a = { ...note(1), topicRuleKey: key, topicLabels: [{ name: '感恩日记', kind: 'direction' as const, focus: '记录生活中的幸福', place: null, evidence: '日常感恩日记' }] };
 const b = { ...note(2), topicRuleKey: key, topicLabels: [{ ...a.topicLabels[0], focus: '发现日常生活的幸福' }] };
 assert.equal(rankQualifiedXhsThemes([a, b], 'check', now, config).themes.length, 1);
 assert.equal(rankQualifiedXhsThemes([a, note(2)], 'check', now, config).themes.length, 1);
 const local = [a, b].map((n, i) => ({ ...n, body: n.body + (i ? '上海' : '北京'), topicLabels: [{ ...n.topicLabels[0], kind: 'specific' as const, place: i ? '上海' : '北京' }] }));
 assert.equal(rankQualifiedXhsThemes(local, 'check', now, config).themes.length, 0, 'unrelated destinations must not manufacture cross-author evidence');
});

test('an under-target collection is retained but does not advance the all-category success timestamp', async () => {
 const config = rules(); config.categories = { check: config.categories.check };
 let result = await collectCategory('check', config, now, {
  async *search() { yield [card(1)]; }, async inspect() { return { note: note(1) }; },
 }, () => {});
 const store = new XhsHotspotsStore({ file: join(await mkdtemp(join(tmpdir(), 'five-result-')), 'data.json'), now: () => new Date(now),
  readRules: async () => ({ rules: config, revision: 'test', updatedAt: null }),
  collect: async (_now, _progress, save) => { await save('check', result); }, analyze: async () => xhsFixtureAnalysis });
 await store.update(true, ['check']); await store.waitForUpdate();
 const state = await store.state();
 assert.equal(state.categories.check.notes.length, 1);
 assert.equal(state.lastSuccessAt, null);
 result = await collectCategory('check', config, now, { async *search() { yield Array.from({ length: 10 }, (_, i) => card(i + 1)); }, async inspect(c) { return { note: note(parseInt(c.id, 16)) }; } }, () => {});
 await store.update(true, ['check']); await store.waitForUpdate();
 assert.equal((await store.state()).categories.check.run?.themeTarget?.found, 5);
 config.categories.check.topics = [];
 await store.regroup(['check']);
 assert.deepEqual((await store.state()).categories.check.run?.themeTarget, { minimum: 5, found: 0, status: 'shortfall' });
});

test('once five themes exist the no-new stop still prevents needless budget exhaustion', async () => {
 const config = rules();
 const got = await collectCategory('check', config, now, {
  async *search(task) { yield Array.from({ length: 200 }, (_, i) => card(i + 1)).filter(c => !task.processedIds?.includes(c.id)); },
  async inspect(c) { const n = parseInt(c.id, 16); return n <= 10 ? { note: note(n) } : { reason: 'irrelevant' }; },
 }, () => {});
 assert.equal(got.themes.length, 5);
 assert.match(got.run!.stopReason, /连续整轮/);
 assert.ok(got.collectionStats!.detailsAttempted < 100);
});

test('provisional five themes cannot stop searching while pending AI may revoke their evidence', async () => {
 const config = rules(); config.categories.check.semantic = { enabled: true, profileId: 'synthetic', maxCalls: 0 };
 const key = semanticRulesKey(config, 'check');
 let finish: (() => void) | undefined;
 const got = await collectCategory('check', config, now, {
  async *search(task) { yield Array.from({ length: 200 }, (_, i) => card(i + 1)).filter(c => !task.processedIds?.includes(c.id)); },
  async inspect(c) { const id = parseInt(c.id, 16); return id <= 10 || id >= 40 ? { note: note(id) } : { reason: 'irrelevant' }; },
 }, () => {}, {
  enrich: notes => new Promise(resolve => { finish = () => resolve({ notes: notes.map(n => ({ ...n, scopeMatch: false, topicRuleKey: key })), calls: 1, warnings: [] }); }),
  preview: (_id, result) => { if (result.run?.coverage?.phase === 'grouping') finish?.(); },
 });
 assert.equal(got.themes.length, 5);
 assert.ok(got.collectionStats!.detailsAttempted >= 40, 'continue to independent evidence while first batch is still tentative');
 assert.equal(got.run?.themeTarget?.status, 'met');
});

test('different keywords supplement different missing themes before repeating the same direction', async () => {
 const config = rules(); config.categories.check.queries = ['日常感悟', '日常思考', '日常记录'];
 config.categories.check.settings!.detailBudget = 45;
 const firstSupplements = new Map<string, string>(); let id = 0;
 await collectCategory('check', config, now, {
  async *search(task) {
   const owner = config.categories.check.queries.find(q => task.query.startsWith(q))!;
   if (task.supplemental && !firstSupplements.has(owner)) firstSupplements.set(owner, task.query.slice(owner.length).trim());
   yield Array.from({ length: 10 }, () => card(++id));
  },
  async inspect() { return { reason: 'outsideWindow' }; },
 }, () => {});
 assert.equal(firstSupplements.size, 3);
 assert.equal(new Set(firstSupplements.values()).size, 3, 'five-theme discovery must not send all keywords after the same missing theme');
});

test('a transient browser connection failure resumes bounded searches and can still reach five themes', async () => {
 let searches = 0;
 const got = await collectCategory('check', rules(), now, {
  async *search() { if (++searches === 2) throw new AppError('XHS_BROWSER', 'Synthetic connection failure', 503); yield Array.from({ length: 10 }, (_, i) => card(i + 1)); },
  async inspect(c) { return { note: note(parseInt(c.id, 16)) }; },
 }, () => {});
 assert.equal(got.run?.themeTarget?.status, 'met');
 assert.equal(got.themes.length, 5);
 assert.ok(got.run?.warnings.some(w => /连接.*重试/.test(w)));
});

test('a persistent browser connection failure stops after two recoveries', async () => {
 let searches = 0;
 await assert.rejects(collectCategory('check', rules(), now, {
  async *search() { searches++; throw new AppError('XHS_BROWSER', 'Synthetic persistent failure', 503); yield []; },
  async inspect() { throw new Error('must not inspect'); },
 }, () => {}), { code: 'XHS_BROWSER' });
 assert.equal(searches, 3);
});

test('a transient detail connection failure does not permanently discard that source note', async () => {
 let attempts = 0;
 const got = await collectCategory('check', rules(), now, {
  async *search(task) { yield Array.from({ length: 10 }, (_, i) => card(i + 1)).filter(c => !task.processedIds?.includes(c.id)); },
  async inspect(c) { if (++attempts === 1) throw new AppError('XHS_BROWSER', 'Synthetic detail connection failure', 503); return { note: note(parseInt(c.id, 16)) }; },
 }, () => {});
 assert.equal(got.themes.length, 5);
 assert.equal(got.notes.length, 10);
 assert.equal(got.collectionStats?.detailsAttempted, 11, 'failed attempts must still consume the detail budget');
});

test('failed previews retain their evidence and have a finished shortfall state', async () => {
 const config = rules(); config.categories = { check: config.categories.check };
 const partial = await collectCategory('check', config, now, { async *search() { yield [card(1)]; }, async inspect() { return { note: note(1) }; } }, () => {});
 partial.run!.finishedAt = null; partial.run!.themeTarget!.status = 'searching';
 const file = join(await mkdtemp(join(tmpdir(), 'five-failure-')), 'data.json');
 const store = new XhsHotspotsStore({ file, now: () => new Date(now),
  readRules: async () => ({ rules: config, revision: 'test', updatedAt: null }), analyze: async () => xhsFixtureAnalysis,
  collect: async (_now, _progress, _save, _categories, _rules, context) => { context?.preview?.('check', partial); throw new AppError('XHS_BROWSER', '连接失败，请重试', 503); } });
 await store.update(true, ['check']); await store.waitForUpdate();
 const state = await store.state(), preview = state.previews!.check;
 assert.equal(state.updating, false);
 assert.equal(preview.notes.length, 1);
 assert.equal(state.categories.check.notes.length, 0, 'failed preview must not replace the saved result');
 assert.equal(preview.run?.themeTarget?.status, 'shortfall');
 assert.ok(preview.run?.finishedAt);
 assert.match(preview.run!.stopReason, /连接失败/);
 assert.match(preview.error!, /连接失败/);
 const restarted = new XhsHotspotsStore({ file, now: () => new Date(now), readRules: async () => ({ rules: config, revision: 'test', updatedAt: null }), analyze: async () => xhsFixtureAnalysis, collect: async () => { throw new Error('must not collect on read'); } });
 assert.deepEqual((await restarted.state()).previews?.check, preview, 'verified partial evidence must survive a service restart without replacing the saved list');
});

test('saving an analysis during collection does not persist a still-searching preview', async () => {
 const config = rules(); config.categories = { check: config.categories.check };
 const partial = await collectCategory('check', config, now, { async *search() { yield [card(1)]; }, async inspect() { return { note: note(1) }; } }, () => {});
 partial.run!.finishedAt = null; partial.run!.themeTarget!.status = 'searching';
 const file = join(await mkdtemp(join(tmpdir(), 'five-live-preview-')), 'data.json');
 let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
 const store = new XhsHotspotsStore({ file, now: () => new Date(now), readRules: async () => ({ rules: config, revision: 'test', updatedAt: null }),
  analyze: async n => ({ ...xhsFixtureAnalysis, noteId: n.id, fingerprint: n.fingerprint }),
  collect: async (_now, _progress, _save, _categories, _rules, context) => { context?.preview?.('check', partial); await pending; throw new AppError('XHS_BROWSER', '连接失败', 503); } });
 try {
  await store.update(true, ['check']); await store.analyze(note(1).id, 'fixture');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).previews?.check, undefined);
 } finally { finish(); await store.waitForUpdate(); }
 assert.ok(JSON.parse(await readFile(file, 'utf8')).previews.check.run.finishedAt);
});

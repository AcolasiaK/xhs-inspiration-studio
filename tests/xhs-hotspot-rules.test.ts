import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_XHS_RULES, termMatches, xhsRulesSchema } from '../lib/xhs-hotspot-rules';
import { rankXhsThemes, matchesCategory, themeLabel } from '../lib/xhs-hotspot-ranking';
import { XhsRulesStore, defaultRulesVersion } from '../lib/server/xhs-hotspot-rules-store';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { blankCategory, type XhsNote } from '../lib/xhs-hotspots';
const now = '2026-11-12T06:00:00.000Z';
const note = (id: number, extra: Partial<XhsNote> = {}): XhsNote => ({ id: id.toString(16).padStart(24, '0'), title: '大理旅行攻略', author: '参考作者', category: 'travel', query: '旅行', url: `https://www.xiaohongshu.com/explore/${id.toString(16).padStart(24, '0')}`, body: '旅行路线与开销', tags: ['大理'], likes: 100, collects: 0, comments: 0, publishedAt: '2026-11-10T00:00:00.000Z', dateLabel: '2天前', collectedAt: now, coverFile: null, coverUrl: null, fingerprint: String(id), ...extra });
const rules = () => structuredClone(DEFAULT_XHS_RULES);

test('rules schema validates defaults, useful weights and bounded collection budgets', () => {
  assert.equal(xhsRulesSchema.safeParse(rules()).success, true);
  assert.equal(xhsRulesSchema.safeParse({ ...rules(), weights: { likes: 0, collects: 0, comments: 0 } }).success, false);
  assert.equal(xhsRulesSchema.safeParse({ ...rules(), detailBudget: 600 }).success, false);
  const r = rules(); r.categories.travel.queries.push('旅行');
  assert.equal(xhsRulesSchema.safeParse(r).success, false);
  r.categories.travel.queries = ['新关键词']; r.categories.travel.topics.push(r.categories.travel.topics[0]);
  assert.equal(xhsRulesSchema.safeParse(r).success, false);
  assert.equal(xhsRulesSchema.safeParse({ ...rules(), windowDays: 31 }).success, false);
});
test('keyword matching accepts ordered wildcards and treats regex characters literally', () => {
  assert.equal(termMatches('CITY WALK 周末旅行', 'citywalk'), true);
  assert.equal(termMatches('预算总计五万元', '预算*万'), true);
  assert.equal(termMatches('万元的预算', '预算*万'), false);
  assert.equal(termMatches('aaaaaaaaaaaaaaaaaaaaaaaaaaaa', '(a+)+$'), false);
  assert.equal(termMatches('这是 A+B 路线', 'a+b'), true);
});
test('custom window, weights, theme cap and representatives affect actual ranking', () => {
  const a = note(1), b = note(2, { title: '北京旅行', tags: ['北京'], likes: 20, collects: 30 });
  assert.equal(rankXhsThemes([a, b], 'travel', now)[0].representatives[0], a.id);
  const r = rules(); r.weights = { likes: 0, collects: 10, comments: 0 }; r.topicLimit = 1; r.representatives = 1;
  const results = rankXhsThemes([a, b, note(3, { title: b.title, tags: b.tags, collects: 1 })], 'travel', now, r);
  assert.equal(results.length, 1); assert.equal(results[0].heat, 310); assert.deepEqual(results[0].representatives, [b.id]);
  const old = note(4, { publishedAt: '2026-10-25T00:00:00.000Z' });
  assert.equal(rankXhsThemes([old], 'travel', now, r).length, 0);
  r.windowDays = 30; assert.equal(rankXhsThemes([old], 'travel', now, r).length, 1);
  r.windowDays = 1; assert.equal(rankXhsThemes([a], 'travel', now, r).length, 0);
});
test('editable category, exclusion, topic priority and destination aliases are honored', () => {
  const r = rules(), n = note(1, { title: '鹅城慢游', body: '', tags: [] });
  assert.equal(matchesCategory(n, 'travel', r), false);
  r.categories.travel.includeTerms = ['慢游']; r.categories.travel.topics = [{ name: '慢旅行', terms: ['慢游'] }, { name: '轻旅行', terms: ['慢游'] }]; r.destinations = [{ name: '惠州', terms: ['鹅城'] }];
  assert.equal(matchesCategory(n, 'travel', r), true); assert.equal(themeLabel(n, r), '惠州 · 慢旅行');
  r.categories.travel.topics.reverse(); assert.equal(themeLabel(n, r), '惠州 · 轻旅行');
  r.excludeTerms.push('鹅城'); assert.equal(matchesCategory(n, 'travel', r), false);
});
test('rules survive restart, reject stale saves and preserve a corrupt file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-rules-')), file = join(folder, 'rules.json'), store = new XhsRulesStore(file);
  const initial = await store.read(); initial.rules.windowDays = 1;
  assert.equal((await store.read()).rules.windowDays, 7);
  const r = rules(); r.weights.comments = 5;
  const saved = await store.save(r, initial.revision); assert.ok(saved.updatedAt);
  assert.deepEqual(await new XhsRulesStore(file).read(), saved);
  assert.deepEqual(await store.save(r, saved.revision), saved, 'Saving unchanged rules keeps the applied version');
  await assert.rejects(store.save(rules(), initial.revision), /另一窗口修改/);
  assert.deepEqual(await store.read(), saved);
  const writes = await Promise.allSettled([store.save(rules(), saved.revision), store.save({ ...r, windowDays: 14 }, saved.revision)]);
  assert.equal(writes.filter(v => v.status === 'fulfilled').length, 1);
  await writeFile(file, '{broken'); await assert.rejects(store.read(), /原文件保留/);
  await assert.rejects(store.save(rules(), saved.revision), /原文件保留/); assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('a collection captures its rules, changes wait until next run, and auto-off permits manual updates', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-rules-snapshot-'));
  let version = defaultRulesVersion(), calls = 0, finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const store = new XhsHotspotsStore({ file: join(folder, 'hotspots.json'), now: () => new Date(now), readRules: async () => structuredClone(version), analyze: async () => { throw new Error('Must not use AI'); }, collect: async (_now, _progress, save, categories, config) => {
    calls++; if (calls === 1) await barrier;
    assert.equal(config?.windowDays, calls === 1 ? 7 : 14);
    for (const category of categories || []) await save(category, { ...blankCategory(), collectedAt: now, attemptedAt: now });
  } });
  await store.update(true);
  version = { revision: 'new-rules', updatedAt: now, rules: { ...rules(), windowDays: 14, autoUpdate: false } };
  finish(); await store.waitForUpdate();
  let state = await store.state(); assert.equal(state.categories.travel.ruleSnapshot?.rules.windowDays, 7); assert.equal(state.configuredRules?.rules.windowDays, 14);
  await store.update(); assert.equal(calls, 1);
  version.rules.autoUpdate = true; await store.update(); assert.equal(calls, 1, 'Saving does not repeat an already successful same-day automatic run');
  version.rules.autoUpdate = false; await store.update(true); await store.waitForUpdate(); state = await store.state();
  assert.equal(calls, 2); assert.equal(state.categories.travel.ruleSnapshot?.revision, 'new-rules');
});

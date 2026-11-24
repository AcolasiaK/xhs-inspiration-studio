import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_XHS_RULES, themeInteractionFloor, xhsRulesSchema } from '../lib/xhs-hotspot-rules';
import { rankQualifiedXhsThemes, semanticRulesKey, specificThemeLabels } from '../lib/xhs-hotspot-ranking';
import { blankCategory, categoryResultSchema, type XhsNote, type XhsTopicLabel } from '../lib/xhs-hotspots';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { defaultRulesVersion } from '../lib/server/xhs-hotspot-rules-store';
import { xhsFixtureAnalysis, xhsFixtureNote } from './xhs-fixture';

const now = '2026-11-13T10:00:00.000Z';
const hex = (n: number) => n.toString(16).padStart(24, '0');
const note = (n: number, patch: Partial<XhsNote> = {}): XhsNote => ({ ...xhsFixtureNote, id: hex(n), authorId: hex(n + 100), title: '阿勒泰冬季看雪旅行', body: '阿勒泰的雪景与雾凇。冬日赏雪的路线。', tags: ['阿勒泰', '赏雪'], likes: 700, collects: 50, comments: 0, ...patch });
const rules = () => structuredClone(DEFAULT_XHS_RULES);
const label = (place: string | null, focus = '冬季看雪旅行'): XhsTopicLabel => ({ name: place ? `${place} · ${focus}` : focus, kind: place ? 'specific' : 'direction', focus, place, evidence: '看雪旅行' });

test('three moderate notes form a hot theme without any individually hot note', () => {
  const r = rules(), notes = [note(1), note(2), note(3)];
  const got = rankQualifiedXhsThemes(notes, 'travel', now, r);
  assert.equal(themeInteractionFloor(r.categories.travel), 2000);
  assert.equal(got.themes.length, 1); assert.equal(got.themes[0].heat, 2250);
  assert.equal(got.themes[0].authorCount, 3); assert.equal(got.diagnostics.lowInteraction, 3);
  assert.equal(got.themes[0].relatedTopics?.[0].title, '冬季看雪旅行');
  assert.equal(got.diagnostics.mergedThemes, 1); assert.deepEqual(got.singleNoteIds, []);
});

test('weights, same-author duplicates and unknown authors cannot manufacture hot theme evidence', () => {
  const r = rules(); r.weights = { likes: 10, collects: 10, comments: 10 };
  assert.equal(rankQualifiedXhsThemes([note(1), note(2)], 'travel', now, r).themes.length, 0);
  assert.equal(rankQualifiedXhsThemes([note(1, { likes: 5000 }), note(2, { authorId: hex(101) })], 'travel', now, r).themes.length, 0);
  assert.equal(rankQualifiedXhsThemes([note(1, { likes: 5000 }), note(2, { authorId: null })], 'travel', now, r).themes.length, 0);
  const got = rankQualifiedXhsThemes([note(1, { likes: 5000 }), note(2), note(3, { authorId: hex(101) }), note(2)], 'travel', now, r);
  assert.equal(got.themes[0].rawInteractions, 5800); assert.equal(got.themes[0].heat, 58000);
  assert.equal(got.themes[0].noteCount, 3); assert.equal(got.themes[0].authorCount, 2);
});

test('specific and cross-destination themes coexist when the direction adds independent authors', () => {
  const r = rules(); r.categories.travel.minThemeInteractions = 1000;
  const notes = [note(1), note(2), note(3, { title: '哈尔滨看雪旅行', body: '哈尔滨看雪旅行攻略', tags: ['哈尔滨'] }), note(4, { title: '长白山看雪旅行', body: '长白山看雪旅行攻略', tags: ['长白山'] })];
  const got = rankQualifiedXhsThemes(notes, 'travel', now, r);
  const specific = got.themes.find(t => t.place === '阿勒泰')!, direction = got.themes.find(t => t.kind === 'direction')!;
  assert.ok(specific); assert.ok(direction); assert.equal(direction.noteCount, 4);
  assert.ok(direction.noteIds.includes(specific.noteIds[0]));
});

test('same-place event is discovered outside the dictionary and an origin tag never becomes destination', () => {
  const r = rules(); r.categories.travel.minThemeInteractions = 1000;
  const a = note(1, { title: '秋日的望仙谷', body: '正巧遇上秋社盛会。秋社有夜游和演艺，旅行两天一晚。', tags: ['望仙谷'] });
  const b = note(2, { title: '秋社启，带娃走进仙侠世界', body: '📍江西上饶·望仙谷\n望仙谷秋社演艺很丰富。亲子旅行看秋社表演。', tags: ['望仙谷', '杭州周边游'] });
  const got = rankQualifiedXhsThemes([a, b], 'travel', now, r);
  assert.ok(got.themes.some(t => t.title === '望仙谷秋社' && t.authorCount === 2));
  assert.ok(specificThemeLabels(b, r).every(t => t.place !== '杭州'));
});

test('passing mentions and generic travel guides do not create unrelated common directions', () => {
  const r = rules();
  const a = note(1, { title: '我的日常', body: '今天记录了一天的普通旅行。买了面包，和朋友聊天。路上听到有人说看雪旅行。回家整理照片。', tags: [] });
  assert.ok(!specificThemeLabels(a, r).some(t => t.focus === '冬季看雪旅行'));
  assert.ok(!specificThemeLabels(note(2, { title: '旅行攻略与路线' }), r).some(t => t.kind === 'direction' && t.name === '旅行攻略'));
});

test('multi-label semantic subjects are validated, normalized, scoped and counted once', () => {
  const r = rules(); r.categories.travel.semantic = { enabled: true, profileId: 'fixture', maxCalls: 1 }; r.categories.travel.minThemeInteractions = 1000;
  const key = semanticRulesKey(r, 'travel');
  const a = note(1, { topicRuleKey: key, topicLabels: [label('阿勒泰'), label(null), label(null)] });
  const b = note(2, { topicRuleKey: key, topicLabels: [{ ...label('阿勒泰'), name: '阿勒泰冬季赏雪', focus: '冬季赏雪' }, label(null)] });
  const got = rankQualifiedXhsThemes([a, b], 'travel', now, r);
  assert.equal(got.themes.length, 1); assert.equal(got.themes[0].heat, 1500); assert.equal(got.themes[0].noteCount, 2);
  assert.equal(specificThemeLabels({ ...a, topicLabels: [{ ...label('不存在的地点'), evidence: '编造的证据' }] }, r).length, 0);
  r.categories.travel.demand = '新范围';
  assert.notEqual(semanticRulesKey(r, 'travel'), key);
  assert.ok(specificThemeLabels(a, r).every(t => t.evidence !== '看雪旅行'), 'stale AI cache must fall back');
});

test('independent content angles survive overlap and the configurable overlap cutoff takes effect', () => {
  const r = rules(); r.categories.travel.semantic = { enabled: true, profileId: 'fixture', maxCalls: 1 }; r.categories.travel.minThemeInteractions = 1000;
  const key = semanticRulesKey(r, 'travel');
  const notes = [1, 2].map(i => note(i, { body: '看雪旅行与保暖穿搭都是主要内容', topicRuleKey: key, topicLabels: [label(null), { ...label(null, '保暖穿搭'), evidence: '保暖穿搭' }] }));
  assert.equal(rankQualifiedXhsThemes(notes, 'travel', now, r).themes.length, 2);
  const many = [1, 2, 3, 4].map(i => note(i)); many.push(note(5, { title: '哈尔滨看雪旅行', body: '哈尔滨雪景旅行', tags: ['哈尔滨'] }));
  r.categories.travel.semantic.enabled = false;
  assert.equal(rankQualifiedXhsThemes(many, 'travel', now, r).themes.length, 1);
  r.categories.travel.overlapPercent = 100;
  assert.equal(rankQualifiedXhsThemes(many, 'travel', now, r).themes.length, 2);
});

test('regroup saves new ranking, preserves source data and analyses, and never collects or calls AI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xhs-regroup-')), file = join(dir, 'cache.json');
  const r = rules(), version = { ...defaultRulesVersion(), rules: r };
  const travel = { ...blankCategory(), notes: [note(1), note(2), note(3)], collectedAt: now, attemptedAt: now, ruleSnapshot: version };
  const wedding = { ...blankCategory(), collectedAt: now };
  const saved = { version: 2, categories: { travel, wedding }, analyses: { [note(1).id]: xhsFixtureAnalysis }, lastAttemptAt: now, lastSuccessAt: now, error: null };
  await writeFile(file, JSON.stringify(saved)); const bytes = await readFile(file, 'utf8');
  const store = new XhsHotspotsStore({ file, now: () => new Date(now), readRules: async () => version, collect: async () => { throw new Error('must not collect'); }, analyze: async () => { throw new Error('must not call AI'); } });
  const state = await store.regroup(['travel']);
  assert.equal(state.categories.travel.rankingVersion, 3); assert.equal(state.categories.travel.themes.length, 1);
  assert.deepEqual(state.categories.travel.notes, travel.notes); assert.deepEqual(state.categories.wedding, wedding);
  assert.deepEqual(state.analyses, saved.analyses); assert.equal(state.categories.travel.collectedAt, now);
  assert.deepEqual(state.categories.travel.collectionRuleSnapshot, version); assert.equal(await readFile(file + '.before-topics-v3', 'utf8'), bytes);
  assert.equal(categoryResultSchema.parse(state.categories.travel).rankingVersion, 3);
  await assert.rejects(store.regroup(['missing']), /有效的热点分类/);
  await writeFile(file + '.lock', JSON.stringify({ pid: process.pid, token: 'foreign', kind: 'analyze' }));
  await assert.rejects(store.regroup(['travel']), /任务正在运行/);
});

test('old rules and ranking schemas remain readable without rewriting the user configuration', () => {
  const original = JSON.stringify(DEFAULT_XHS_RULES), parsed = xhsRulesSchema.parse(JSON.parse(original));
  assert.equal(parsed.categories.travel.minThemeInteractions, undefined);
  assert.equal(parsed.categories.travel.overlapPercent, undefined);
  assert.equal(JSON.stringify(DEFAULT_XHS_RULES), original);
  assert.equal(categoryResultSchema.parse({ ...blankCategory(), rankingVersion: 2 }).rankingVersion, 2);
  assert.equal(xhsRulesSchema.safeParse({ ...parsed, categories: { ...parsed.categories, travel: { ...parsed.categories.travel, overlapPercent: 101 } } }).success, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '../lib/errors';
import { parseXhsCount, parseXhsPublishedAt, rankXhsThemes, themeLabel, withinSevenDays } from '../lib/xhs-hotspot-ranking';
import { blankCategory, type XhsAnalysis, type XhsCategory, type XhsNote } from '../lib/xhs-hotspots';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import type { XhsCollector } from '../lib/server/xhs-hotspots-browser';
import { collectCategory } from '../lib/server/xhs-collection-engine';

const now = '2026-11-12T06:00:00.000Z';
const note = (id = '000000000000000000000001', extra: Partial<XhsNote> = {}): XhsNote => ({ id, title: '大理旅行攻略', author: '参考作者', category: 'travel', query: '旅行', url: `https://www.xiaohongshu.com/explore/${id}`, body: '旅行路线和实际开销', tags: ['大理', '旅行攻略'], likes: 100, collects: 50, comments: 10, publishedAt: '2026-11-10T00:00:00.000Z', dateLabel: '2天前 浙江', collectedAt: now, coverFile: null, coverUrl: null, fingerprint: id, ...extra });
const analysis = (n: XhsNote): XhsAnalysis => ({ noteId: n.id, fingerprint: n.fingerprint, model: 'test-model', generatedAt: now, coverObserved: false, content: { summary: '内容概要', titleAndHook: '标题与开头观察', structure: ['正文结构'], cover: '未读取封面', engagement: '只依据累计互动', takeaways: ['借鉴写法而非经历'], cautions: ['不保证传播效果'] } });
const collect = (notes: XhsNote[]): XhsCollector => async (_now, _progress, save) => { for (const category of ['travel', 'wedding', 'daily'] as XhsCategory[]) { const selected = notes.filter(note => note.category === category); await save(category, { ...blankCategory(), notes: selected, themes: rankXhsThemes(selected, category, now), collectedAt: now, attemptedAt: now, candidateCount: selected.length }); } };
async function fixture(customCollect: XhsCollector = collect([note()])) {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-hotspots-test-')), file = join(folder, 'hotspots.json');
  const deps = { file, now: () => new Date(now), collect: customCollect, analyze: async (n: XhsNote) => analysis(n) };
  return { file, deps, store: new XhsHotspotsStore(deps) };
}
test('publication dates reject edited labels and validate the seven-day window and calendar', () => {
  assert.equal(parseXhsPublishedAt('编辑于 2天前 浙江', now), null);
  assert.equal(parseXhsPublishedAt('更新于 11-11', now), null);
  assert.equal(parseXhsPublishedAt('2026-02-30 浙江', now), null);
  assert.equal(parseXhsPublishedAt('昨天 18:30广东', now), '2026-11-11T10:30:00.000Z');
  assert.equal(parseXhsPublishedAt('12-31', '2027-01-02T06:00:00.000Z'), '2026-12-30T16:00:00.000Z');
  assert.equal(withinSevenDays(parseXhsPublishedAt('6天前 北京', now), now), true);
  assert.equal(withinSevenDays(parseXhsPublishedAt('8天前', now), now), false);
  assert.equal(withinSevenDays('2026-11-13T00:00:00.000Z', now), false);
  assert.equal(parseXhsCount('1.2万'), 12000); assert.equal(parseXhsCount('2,345'), 2345);
  assert.equal(parseXhsCount('收藏'), 0); assert.equal(parseXhsCount(null), null);
});
test('rank sums verified interactions, deduplicates posts and groups representatives', () => {
  const a = note(), b = note('000000000000000000000002', { likes: 200 }), stale = note('000000000000000000000003', { publishedAt: '2025-11-10T00:00:00.000Z', likes: 99999 });
  const themes = rankXhsThemes([a, a, b, stale], 'travel', now);
  assert.equal(themes.length, 1); assert.equal(themes[0].heat, 420); assert.equal(themes[0].noteCount, 2);
  assert.deepEqual(themes[0].representatives, [b.id, a.id]);
  assert.equal(rankXhsThemes([a], 'wedding', now).length, 0);
});
test('each category caps at ten distinct themes without inventing filler', () => {
  const notes = Array.from({ length: 13 }, (_, i) => note(i.toString(16).padStart(24, '0'), { title: `目的地${i}旅行`, tags: [`主题${i}独特标签`], likes: i }));
  const ranked = rankXhsThemes(notes, 'travel', now);
  assert.equal(ranked.length, 10); assert.equal(ranked[0].representatives[0], notes[12].id);
  assert.equal(rankXhsThemes([], 'daily', now).length, 0);
});
test('travel topics prioritize the destination in the title over departure city and broad tags', () => {
  assert.equal(themeLabel(note(undefined, { title: '重庆出发周末游之天水篇', tags: ['重庆旅游'] })), '天水 · 旅行见闻');
  assert.equal(themeLabel(note(undefined, { title: '济南一日旅行', tags: ['北京周末游'] })), '济南 · 旅行见闻');
  assert.equal(themeLabel(note(undefined, { title: '景德镇旅游攻略', tags: ['旅行攻略'] })), '景德镇 · 旅行攻略');
});
test('wedding topics use the title before generic preparation tags', () => {
  assert.equal(themeLabel(note(undefined, { category: 'wedding', title: '农村婚礼的仪式感', tags: ['备婚', '婚礼现场'] })), '农村婚礼');
  assert.equal(themeLabel(note(undefined, { category: 'wedding', title: '成都婚礼｜水晶与光影的婚礼现场', tags: ['备婚', '婚礼场地'] })), '婚礼布置');
});
test('background refresh has single-flight progress; same-day auto refresh never collects twice', async () => {
  let finish!: () => void, count = 0;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async (n, p, save) => { count++; p({ category: 'travel', current: 0, total: 5, message: 'test progress' }); await barrier; await collect([note()])(n, p, save); });
  assert.equal((await f.store.update()).updating, true);
  assert.equal((await f.store.update(true)).updating, true);
  assert.equal((await f.store.state()).progress?.message, 'test progress');
  await assert.rejects(new XhsHotspotsStore(f.deps).update(true), /正在运行/);
  finish(); await f.store.waitForUpdate();
  assert.equal((await f.store.state()).categories.travel.themes.length, 1);
  await f.store.update(); assert.equal(count, 1);
});
test('failed refresh preserves saved categories and previous success timestamp', async () => {
  const f = await fixture(); await f.store.update(true); await f.store.waitForUpdate();
  const failed = new XhsHotspotsStore({ ...f.deps, collect: async () => { throw new AppError('XHS_LOGIN', '需要登录', 409); } });
  await failed.update(true); await failed.waitForUpdate(); const state = await failed.state();
  assert.equal(state.lastSuccessAt, now); assert.equal(state.categories.travel.notes[0].id, note().id);
  assert.equal(state.error, '需要登录'); assert.equal(state.categories.travel.error, '需要登录');
});
test('when every keyword fails before a results page is verified, the previous ranking stays visible', async () => {
  const f = await fixture();
  await f.store.update(true); await f.store.waitForUpdate();
  const failed = new XhsHotspotsStore({ ...f.deps, collect: async (date, progress, save, _categories, rules, context) => {
    const result = await collectCategory('travel', rules!, date, {
      async *search() { throw new AppError('XHS_QUERY_TIMEOUT', '搜索页超时', 504); },
      async inspect() { throw new Error('no cards'); },
    }, progress, context);
    await save('travel', result);
  } });
  await failed.update(true, ['travel']); await failed.waitForUpdate();
  const state = await failed.state();
  assert.match(state.categories.travel.error || '', /搜索页/u);
  assert.equal(state.categories.travel.notes[0]?.id, note().id);
  assert.equal(state.previews?.travel, undefined);
});
test('retry resumes incomplete categories and keeps successful same-day results', async () => {
  const f = await fixture(async (_now, _progress, save) => { await save('travel', { ...blankCategory(), notes: [note()], themes: rankXhsThemes([note()], 'travel', now), collectedAt: now, attemptedAt: now }); throw new AppError('XHS_LAYOUT', '单次采集异常', 502); });
  await f.store.update(true); await f.store.waitForUpdate();
  let requested: XhsCategory[] | undefined;
  const retry = new XhsHotspotsStore({ ...f.deps, collect: async (_n, _p, save, categories) => { requested = categories; for (const category of categories || []) await save(category, { ...blankCategory(), collectedAt: now, attemptedAt: now }); } });
  await retry.update(true, ['wedding', 'daily']); await retry.waitForUpdate();
  assert.deepEqual(requested, ['wedding', 'daily']); assert.equal((await retry.state()).error, null);
  assert.equal((await retry.state()).categories.travel.notes.length, 1);
});
test('analyze is never automatic, caches by fingerprint, survives restart and preserves old result on error', async () => {
  let calls = 0;
  const f = await fixture(); const deps = { ...f.deps, analyze: async (n: XhsNote) => { calls++; return analysis(n); } };
  const store = new XhsHotspotsStore(deps);
  await store.update(true); await store.waitForUpdate(); assert.equal(calls, 0);
  await store.analyze(note().id, 'relay'); await store.analyze(note().id, 'relay'); assert.equal(calls, 1);
  const restart = new XhsHotspotsStore(deps); await restart.analyze(note().id, 'relay'); assert.equal(calls, 1);
  const failed = new XhsHotspotsStore({ ...deps, analyze: async () => { throw new Error('network'); } });
  await assert.rejects(failed.analyze(note().id, 'relay', true));
  assert.equal((await failed.state()).analyses[note().id].model, 'test-model');
  await assert.rejects(failed.analyze('000000000000000000000099', 'relay'), /不在当前候选/);
});
test('corrupt cache is never overwritten by refresh', async () => {
  const f = await fixture(); await writeFile(f.file, '{broken');
  await assert.rejects(f.store.update(true), /原文件保留/);
  assert.equal(await readFile(f.file, 'utf8'), '{broken');
});
test('login challenges pause automatic retries until a manual refresh', async () => {
  let calls = 0, date = new Date(now);
  const f = await fixture(async () => { calls++; throw new AppError('XHS_LOGIN', '小红书需要登录或安全验证。请在浏览器完成。', 409); });
  const store = new XhsHotspotsStore({ ...f.deps, now: () => date });
  await store.update(true); await store.waitForUpdate();
  date = new Date(Date.parse(now) + 86400000); await store.update(); assert.equal(calls, 1);
  await store.update(true); await store.waitForUpdate(); assert.equal(calls, 2);
});

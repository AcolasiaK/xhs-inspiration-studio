import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIngestAnalysis, savedAnalysisSchema, xhsIngestAnalysisSchema, blankCategory, type XhsAnalysis } from '../lib/xhs-hotspots';
import { xhsAnalysisFilename, xhsAnalysisMarkdown } from '../lib/xhs-analysis-markdown';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { xhsFixtureAnalysis as legacy, xhsFixtureIngestContent as content, xhsFixtureNote as note } from './xhs-fixture';
const modern = (): XhsAnalysis => ({ ...legacy, method: 'xiaohongshu-ingest', methodVersion: 1, content });

test('ingest requires all skill dimensions and exactly five topics; persisted legacy remains readable', () => {
  assert.deepEqual(savedAnalysisSchema.parse(legacy), legacy); assert.equal(isIngestAnalysis(legacy), false);
  const saved = savedAnalysisSchema.parse(modern()); assert.ok(isIngestAnalysis(saved)); assert.equal(saved.content.derivedTopics.length, 5);
  assert.equal(xhsIngestAnalysisSchema.safeParse({ ...content, derivedTopics: content.derivedTopics.slice(0, 4) }).success, false);
  assert.equal(savedAnalysisSchema.safeParse({ ...modern(), content: legacy.content }).success, false);
});
test('upgrading cached analysis is explicit, persists all fields across restart and preserves the old report on failure', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'xhs-ingest-')), file = join(folder, 'data.json'); let calls = 0, fail = false;
  const deps = { file, now: () => new Date(note.collectedAt), analyze: async () => { calls++; if (fail) throw Error('test failure'); return calls === 1 ? legacy : modern(); }, collect: async (now: string, _progress: unknown, save: (c: 'travel' | 'wedding' | 'daily', r: ReturnType<typeof blankCategory>) => Promise<void>) => { for (const c of ['travel', 'wedding', 'daily'] as const) await save(c, { ...blankCategory(), notes: c === 'travel' ? [note] : [], collectedAt: now, attemptedAt: now }); } };
  const store = new XhsHotspotsStore(deps); await store.update(true); await store.waitForUpdate(); await store.analyze(note.id, 'relay'); const old = await readFile(file, 'utf8');
  assert.equal(isIngestAnalysis(await store.analyze(note.id, 'relay')), false); assert.equal(calls, 1); assert.equal(await readFile(file, 'utf8'), old);
  const upgraded = await store.analyze(note.id, 'relay', true); assert.ok(isIngestAnalysis(upgraded)); assert.equal(calls, 2);
  const restart = new XhsHotspotsStore(deps); assert.deepEqual(await restart.analyze(note.id, 'relay'), upgraded); assert.equal(calls, 2);
  fail = true; await assert.rejects(restart.analyze(note.id, 'relay', true)); assert.deepEqual((await restart.state()).analyses[note.id], upgraded);
});
test('Markdown exports structured metadata, all five topics and source text without active third-party embeds', () => {
  const value = xhsAnalysisMarkdown({ ...note, title: '标题\n---', body: '![](https://example.com/track)\n<script>test</script>' }, modern());
  assert.ok(value.startsWith('---\ntitle: "笔记拆解 - 标题\\n---"')); assert.match(value, /method: "xiaohongshu-ingest\/1.0.0"/); assert.equal(value.match(/^- \[ \]/gm)?.length, 5); assert.match(value, /## 可复用模板/); assert.ok(!value.includes('![](')); assert.ok(!value.includes('<script>')); assert.match(value, /未采集完整图组或视频文字稿/); assert.equal(xhsAnalysisFilename('../标题/\u0000'), '..标题-拆解.md');
  assert.ok(!xhsAnalysisMarkdown(note, legacy).includes('## 衍生选题'));
  assert.match(xhsAnalysisMarkdown({ ...note, fingerprint: 'updated' }, modern()), /可能与分析时的材料不同/);
});

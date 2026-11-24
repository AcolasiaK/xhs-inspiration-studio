import test from 'node:test';
import assert from 'node:assert/strict';
import { blankCategory, categoryResultSchema, xhsNoteSchema, xhsSearchCoverageSchema, type XhsKeywordCoverage } from '../lib/xhs-hotspots';
import { xhsFixtureNote } from './xhs-fixture';

const keyword = (query: string, patch: Partial<XhsKeywordCoverage> = {}): XhsKeywordCoverage => ({
  query, status: 'pending', basicCovered: false, searches: 0, completedSearches: 0,
  candidates: 0, inspected: 0, newNotes: 0, newAuthors: 0, matchedNotes: 0,
  elapsedMs: 0, reason: null, sorts: [], ...patch,
});
const run = { startedAt: '2026-11-13T01:00:00.000Z', finishedAt: null, firstResultMs: null, elapsedMs: 1000, stopReason: '基础搜索中', searches: 1, cacheHits: 0, aiCalls: 0, warnings: [] };

test('historical category and note records stay unchanged without inventing coverage or provenance', () => {
  const original = { ...blankCategory(), collectedAt: '2026-11-12T01:00:00.000Z', notes: [xhsFixtureNote], queries: ['旅行'], run };
  const before = JSON.stringify(original), parsed = categoryResultSchema.parse(original);
  assert.deepEqual(parsed, original);
  assert.equal('coverage' in parsed.run!, false);
  assert.equal('matchedQueries' in parsed.notes[0], false);
  assert.equal(JSON.stringify(original), before);
});

test('partial coverage and all matched sources survive storage round-trip without changing first discovery', () => {
  const input = { ...blankCategory(), notes: [{ ...xhsFixtureNote, query: '川西', matchedQueries: ['川西', '川西 胶片'] }], run: { ...run, coverage: {
    version: 1, phase: 'basic', completed: 1, total: 3, keywords: [
      keyword('川西', { status: 'covered', basicCovered: true, searches: 1, completedSearches: 1, candidates: 8, inspected: 2, newNotes: 1, newAuthors: 1, matchedNotes: 1, elapsedMs: 1000, sorts: ['likes'] }),
      keyword('新疆', { status: 'searching', searches: 1, elapsedMs: 200, sorts: ['likes'] }),
      keyword('川西 胶片'),
    ],
  } } };
  const parsed = categoryResultSchema.parse(JSON.parse(JSON.stringify(input)));
  assert.equal(parsed.run?.coverage?.completed, 1);
  assert.equal(parsed.run?.coverage?.keywords[1].basicCovered, false);
  assert.equal(parsed.run?.coverage?.keywords[2].status, 'pending');
  assert.equal(parsed.notes[0].query, '川西');
  assert.deepEqual(parsed.notes[0].matchedQueries, ['川西', '川西 胶片']);
});

test('coverage cannot count attempted tasks as completed keywords or duplicate the denominator', () => {
  const coverage = { version: 1, phase: 'finished', total: 2, completed: 1, keywords: [
    keyword('川西', { status: 'empty', basicCovered: true, searches: 1, completedSearches: 1, reason: '已确认无搜索结果' }),
    keyword('新疆', { status: 'interrupted', searches: 2, reason: '已达到本词用时上限' }),
  ] };
  assert.equal(xhsSearchCoverageSchema.safeParse(coverage).success, true);
  assert.equal(xhsSearchCoverageSchema.safeParse({ ...coverage, completed: 2 }).success, false);
  assert.equal(xhsSearchCoverageSchema.safeParse({ ...coverage, total: 3 }).success, false);
  assert.equal(xhsSearchCoverageSchema.safeParse({ ...coverage, completed: 0, keywords: [keyword('川西'), keyword('川西')] }).success, false);
  assert.equal(xhsNoteSchema.safeParse({ ...xhsFixtureNote, matchedQueries: Array.from({ length: 41 }, (_, index) => `词${index}`) }).success, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createXhsSearchCursor } from '../lib/xhs-search-cursor';
const cards = (...ids: string[]) => ids.map(id => ({ id, title: `笔记 ${id}` }));
test('resumed search skips prior unique cards across overlapping and virtualized pages', () => {
  const cursor = createXhsSearchCursor(3);
  assert.deepEqual(cursor.take(cards('a','b')).cards, []);
  const next = cursor.take(cards('a','b','c','d'));
  assert.deepEqual(next.cards.map(c=>c.id), ['d']);assert.equal(cursor.remaining,0);
  assert.deepEqual(cursor.take(cards('c','d','e')).cards.map(c=>c.id), ['e']);
  assert.equal(cursor.take(cards('d','e')).discovered,0);
});
test('a new search emits unique cards in source order, including repeated IDs in one viewport', () => {
  const cursor=createXhsSearchCursor();
  assert.deepEqual(cursor.take(cards('a','a','b')).cards.map(c=>c.id),['a','b']);
  assert.deepEqual(cursor.take([]),{cards:[],discovered:0});
  assert.deepEqual(cursor.take(cards('b','c')).cards.map(c=>c.id),['c']);
});

test('resuming by processed IDs keeps new cards that move ahead of the old positional offset', () => {
  const cursor=createXhsSearchCursor(2,['a','b']);
  assert.deepEqual(cursor.take(cards('x','a','b','c')).cards.map(c=>c.id),['x','c']);
  assert.deepEqual(cursor.take(cards('a','c','d')).cards.map(c=>c.id),['d']);
  const removed=createXhsSearchCursor(3,['a','b','c']);
  assert.deepEqual(removed.take(cards('b','x')).cards.map(c=>c.id),['x']);
});

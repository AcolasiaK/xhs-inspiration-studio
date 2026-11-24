import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_XHS_RULES, type XhsRules } from '../lib/xhs-hotspot-rules';
import { categoryResultSchema, type XhsCategoryResult, type XhsNote } from '../lib/xhs-hotspots';
import { semanticRulesKey } from '../lib/xhs-hotspot-ranking';
import { AppError } from '../lib/errors';
import { collectCategory, type CollectionPort, type SearchTask, type XhsCandidate } from '../lib/server/xhs-collection-engine';

const now = '2026-11-13T04:00:00.000Z';
const hex = (id: number) => id.toString(16).padStart(24, '0');
const card = (id: number): XhsCandidate => ({ id: hex(id), authorId: hex(id + 100_000), title: '十分钟早餐做法', date: '昨天', likes: '600', own: false, top: id });
const note = (id: number, query: string, patch: Partial<XhsNote> = {}): XhsNote => ({
  id: hex(id), authorId: hex(id + 100_000), author: '合成测试作者', title: '十分钟早餐做法', body: '十分钟完成早餐，做法清楚。', tags: ['早餐'],
  category: 'food', query, likes: 600, collects: 50, comments: 10,
  publishedAt: '2026-11-12T00:00:00.000Z', dateLabel: '昨天', collectedAt: now,
  url: `https://www.xiaohongshu.com/explore/${hex(id)}`, coverFile: null, coverUrl: null, fingerprint: hex(id), ...patch,
});
function rules(queries = ['早餐A', '早餐B', '早餐C']): XhsRules {
  const value = structuredClone(DEFAULT_XHS_RULES);
  value.categories.food = {
    name: '美食', queries, includeTerms: ['早餐'], topics: [{ name: '十分钟早餐', terms: ['十分钟'] }],
    minInteractions: 500, minThemeInteractions: 1000, minAuthors: 2, minNotes: 2, requireDestination: false,
    settings: { autoUpdate: false, windowDays: 30, searchSorts: ['likes', 'collects'], candidateBudget: 120, detailBudget: 48, cardsPerQuery: 5, scrollsPerQuery: 8, maxMinutes: 20, noNewRounds: 2, cacheMinutes: 60, topicLimit: 1 },
  };
  return value;
}
function finitePort(data: (task: SearchTask) => number[], tasks: SearchTask[], inspections: string[] = []): CollectionPort {
  return {
    async *search(task) {
      tasks.push({ ...task });
      const ids = data(task), offset = task.offset ?? 0;
      if (!ids.length) yield [];
      for (let index = offset; index < ids.length; index += 5) yield ids.slice(index, index + 5).map(card);
    },
    async inspect(candidate, task) {
      inspections.push(candidate.id);
      return { note: note(parseInt(candidate.id, 16), task.query) };
    },
  };
}
function coverage(result: XhsCategoryResult) {
  assert.ok(result.run?.coverage, 'new runs must persist keyword coverage');
  assert.ok(categoryResultSchema.safeParse(result).success, 'coverage must survive the stored-result schema');
  return result.run.coverage;
}
function untilAborted(signal: AbortSignal): Promise<never> {
  // Keep a referenced timer alive because AbortSignal.timeout itself is unref'ed.
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Synthetic operation ignored cancellation')), 2000);
    const abort = () => { clearTimeout(keepAlive); reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

test('basic coverage rotates every keyword before a second sort and keeps searching after the theme display limit', async () => {
  const config = rules(), queries = config.categories.food.queries, tasks: SearchTask[] = [], inspections: string[] = [], snapshots: XhsCategoryResult[] = [];
  const port = finitePort(task => {
    const base = queries.findIndex(query => task.query.startsWith(query));
    return Array.from({ length: 35 }, (_, index) => (base + 1) * 1000 + (task.sort === 'collects' ? 100 : 0) + index + 1);
  }, tasks, inspections);
  const result = await collectCategory('food', config, now, port, () => {}, { preview: (_category, snapshot) => snapshots.push(structuredClone(snapshot)) });
  assert.deepEqual(tasks.slice(0, queries.length).map(task => [task.query, task.sort]), queries.map(query => [query, 'likes']));
  assert.ok(tasks.slice(queries.length).some(task => task.sort === 'collects'), 'later selected sorts still get a turn');
  assert.equal(result.themes.length, 1, 'the displayed theme limit remains respected');
  assert.ok(snapshots.some(snapshot => snapshot.themes.length === 1 && (snapshot.run?.coverage?.completed ?? 0) < queries.length), 'a full-looking early theme list is provisional');
  assert.equal(coverage(result).completed, queries.length);
  assert.ok(result.notes.length > queries.length, 'collection is not stopped by reaching one displayed theme');
  assert.equal(new Set(inspections).size, inspections.length);
});

test('same note found through several keywords is inspected once and retains first discovery plus every matching source', async () => {
  const config = rules(), tasks: SearchTask[] = [], inspections: string[] = [];
  const result = await collectCategory('food', config, now, finitePort(() => [1, 2], tasks, inspections), () => {});
  assert.equal(inspections.length, 2);
  assert.equal(result.notes.length, 2);
  for (const item of result.notes) {
    assert.equal(item.query, config.categories.food.queries[0]);
    for (const query of config.categories.food.queries) assert.ok(item.matchedQueries?.includes(query), `${query} must remain visible as a matching source`);
    assert.equal(new Set(item.matchedQueries).size, item.matchedQueries?.length);
  }
  const rows = coverage(result).keywords;
  assert.equal(rows.reduce((total, row) => total + row.newNotes, 0), 2, 'duplicate matches cannot inflate incremental contribution');
  assert.equal(rows.reduce((total, row) => total + row.inspected, 0), 2);
  assert.equal(rows[1].newNotes, 0);
  assert.equal(rows[1].matchedNotes, 2);
  assert.ok(rows.every(row => row.basicCovered));
});

test('resuming a small slice does not skip the uninspected tail of an earlier result batch', async () => {
  const config = rules(['早餐A']), tasks: SearchTask[] = [], inspections: string[] = [];
  config.categories.food.topics = [];
  Object.assign(config.categories.food.settings!, { searchSorts: ['likes'], candidateBudget: 30, detailBudget: 20 });
  const expected = Array.from({ length: 11 }, (_, index) => index + 1);
  const result = await collectCategory('food', config, now, finitePort(() => expected, tasks, inspections), () => {});
  assert.deepEqual(new Set(result.notes.map(item => item.id)), new Set(expected.map(hex)));
  assert.equal(inspections.length, expected.length);
  assert.ok(tasks.some(task => (task.offset ?? 0) > 0), 'later slices must resume, not restart the same first cards');
});

test('resuming by processed IDs still discovers newly inserted cards when search results reorder', async () => {
  const config = rules(['早餐A']), tasks: SearchTask[] = [];
  config.categories.food.topics = [];
  Object.assign(config.categories.food.settings!, { searchSorts: ['likes'], candidateBudget: 30, detailBudget: 20 });
  const inspected: string[] = [];
  const port: CollectionPort = {
    async *search(task) {
      tasks.push({ ...task });
      const ids = tasks.length === 1 ? [1, 2, 3, 4, 5] : [9, 1, 2, 3, 4, 5, 6];
      const alreadyProcessed = new Set(task.processedIds ?? []);
      const available = ids.filter(id => !alreadyProcessed.has(hex(id)));
      for (let index = 0; index < available.length; index += 5) yield available.slice(index, index + 5).map(card);
    },
    async inspect(candidate, task) { inspected.push(candidate.id); return { note: note(parseInt(candidate.id, 16), task.query) }; },
  };
  const result = await collectCategory('food', config, now, port, () => {});
  assert.deepEqual(new Set(result.notes.map(item => item.id)), new Set([1, 2, 3, 4, 5, 6, 9].map(hex)));
  assert.equal(inspected.length, new Set(inspected).size);
  assert.ok(tasks.slice(1).some(task => task.processedIds?.length));
});

test('a genuine empty query is covered without preventing other directions from producing notes', async () => {
  const config = rules(['空早餐', '有早餐']), tasks: SearchTask[] = [];
  const result = await collectCategory('food', config, now, finitePort(task => task.query.startsWith('空早餐') ? [] : [1, 2], tasks), () => {});
  const progress = coverage(result), empty = progress.keywords.find(row => row.query === '空早餐')!;
  assert.equal(empty.basicCovered, true);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.inspected, 0);
  assert.equal(progress.completed, 2);
  assert.equal(result.notes.length, 2);
});

test('cached notes keep their original metrics timestamp and original source while recording new matching keywords', async () => {
  const config = rules(), tasks: SearchTask[] = [], cachedAt = '2026-11-13T03:30:00.000Z';
  const cached = [note(1, '历史早餐', { collectedAt: cachedAt, matchedQueries: ['历史早餐'] })];
  const port = finitePort(() => [1], tasks);
  port.inspect = async () => { throw new Error('cached note must not be inspected again'); };
  const result = await collectCategory('food', config, now, port, () => {}, { cachedNotes: cached });
  assert.equal(result.run?.cacheHits, 1);
  assert.equal(result.notes[0].collectedAt, cachedAt);
  assert.equal(result.notes[0].query, '历史早餐');
  for (const query of ['历史早餐', ...config.categories.food.queries]) assert.ok(result.notes[0].matchedQueries?.includes(query));
  assert.equal(cached[0].matchedQueries?.length, 1, 'cached inputs remain unmodified');
});

test('one query returning no relevant notes does not end a whole expansion round prematurely', async () => {
  const config = rules(['无效早餐', '有效早餐']), tasks: SearchTask[] = [], inspections: string[] = [];
  const port = finitePort(task => task.query.startsWith('无效早餐') ? [1, 2] : [3, 4], tasks, inspections);
  port.inspect = async (candidate, task) => task.query.startsWith('无效早餐') ? { reason: 'irrelevant' } : { note: note(parseInt(candidate.id, 16), task.query) };
  const result = await collectCategory('food', config, now, port, () => {});
  assert.equal(coverage(result).completed, 2);
  assert.deepEqual(result.notes.map(item => item.id).sort(), [hex(3), hex(4)]);
  assert.ok(tasks.some(task => task.query === '有效早餐' && task.sort === 'collects'));
});

test('login, security and layout failures stop immediately without pretending uncovered keywords completed', async () => {
  for (const code of ['XHS_LOGIN', 'XHS_LAYOUT', 'XHS_FILTER']) {
    const config = rules(), tasks: string[] = [], snapshots: XhsCategoryResult[] = [];
    const port: CollectionPort = {
      async *search(task) { tasks.push(task.query); throw new AppError(code, 'Synthetic fatal browser state', 503); yield []; },
      async inspect() { throw new Error('should not inspect'); },
    };
    await assert.rejects(collectCategory('food', config, now, port, () => {}, { preview: (_category, snapshot) => snapshots.push(structuredClone(snapshot)) }), { code });
    assert.deepEqual(tasks, [config.categories.food.queries[0]]);
    assert.ok(snapshots.every(snapshot => (snapshot.run?.coverage?.completed ?? 0) === 0));
  }
});

test('a global browser failure takes precedence even if the keyword deadline expires at the same time', async () => {
  const config = rules(), tasks: string[] = [];
  const port: CollectionPort = {
    async *search(task, signal) {
      tasks.push(task.query);
      await untilAborted(signal).catch(() => undefined);
      throw new AppError('XHS_LOGIN', 'Synthetic security checkpoint discovered at timeout', 409);
      yield [];
    },
    async inspect() { throw new Error('must not inspect a login screen'); },
  };
  await assert.rejects(collectCategory('food', config, now, port, () => {}, { scheduler: { taskTimeoutMs: 10 } }), { code: 'XHS_LOGIN' });
  assert.deepEqual(tasks, [config.categories.food.queries[0]]);
});

test('a slow first keyword yields to later directions and remains explicitly uncovered after bounded retries', async () => {
  const config = rules(['慢早餐', '正常早餐']), tasks: string[] = [];
  const port: CollectionPort = {
    async *search(task, signal) {
      tasks.push(task.query);
      if (task.query.startsWith('慢早餐')) await untilAborted(signal);
      else yield [card(1), card(2)];
    },
    async inspect(candidate, task) { return { note: note(parseInt(candidate.id, 16), task.query) }; },
  };
  const result = await collectCategory('food', config, now, port, () => {}, { scheduler: { taskTimeoutMs: 15 } });
  assert.deepEqual(tasks.slice(0, 2), config.categories.food.queries);
  assert.ok(tasks.filter(query => query === '慢早餐').length <= 3, 'a broken direction has only finite retries');
  const progress = coverage(result), slow = progress.keywords.find(row => row.query === '慢早餐')!, normal = progress.keywords.find(row => row.query === '正常早餐')!;
  assert.equal(slow.basicCovered, false);
  assert.ok(slow.status === 'interrupted' || slow.status === 'partial');
  assert.ok(slow.reason);
  assert.equal(normal.basicCovered, true);
  assert.equal(progress.completed, 1);
  assert.equal(result.notes.length, 2);
});

test('a successfully checked slow first note yields before another detail and counts as basic coverage', async t => {
  const config = rules(), tasks: SearchTask[] = [], snapshots: XhsCategoryResult[] = [];
  let clock = Date.parse(now);
  t.mock.method(Date, 'now', () => clock);
  const port = finitePort(task => {
    const base = config.categories.food.queries.findIndex(query => task.query.startsWith(query));
    return Array.from({ length: 5 }, (_, index) => (base + 1) * 1000 + index + 1);
  }, tasks);
  port.inspect = async (candidate, task) => {
    // Simulate one successful detail consuming over half of this slice, without wall-clock sleeps.
    clock += 60;
    return { note: note(parseInt(candidate.id, 16), task.query) };
  };
  const result = await collectCategory('food', config, now, port, () => {}, {
    scheduler: { taskTimeoutMs: 100 },
    preview: (_category, snapshot) => snapshots.push(structuredClone(snapshot)),
  });
  const firstPass = snapshots.find(snapshot => snapshot.run?.coverage?.phase === 'basic' && snapshot.run.coverage.completed === config.categories.food.queries.length);
  assert.ok(firstPass, 'slow successful details must still finish the basic pass');
  assert.deepEqual(tasks.slice(0, 3).map(task => task.query), config.categories.food.queries);
  assert.ok(firstPass.run!.coverage!.keywords.every(row => row.inspected === 1 && row.basicCovered));
  assert.equal(firstPass.notes.length, 3, 'each direction yields after its first slow successful note');
  assert.equal(coverage(result).completed, config.categories.food.queries.length);
  assert.equal(result.notes.length, 15, 'unprocessed tails remain available for later slices');
});

test('query-local load failures can recover without restarting the successfully covered directions', async () => {
  const config = rules(['暂慢早餐', '正常早餐']), tasks: string[] = [];
  let failures = 0;
  const port: CollectionPort = {
    async *search(task) {
      tasks.push(task.query);
      if (task.query.startsWith('暂慢早餐') && failures++ === 0) throw new AppError('XHS_SEARCH_EMPTY_LOAD', 'Synthetic local load failure', 502);
      yield task.query.startsWith('暂慢早餐') ? [card(1)] : [card(2)];
    },
    async inspect(candidate, task) { return { note: note(parseInt(candidate.id, 16), task.query) }; },
  };
  const result = await collectCategory('food', config, now, port, () => {});
  assert.deepEqual(tasks.slice(0, 2), config.categories.food.queries);
  assert.equal(coverage(result).completed, 2);
  assert.equal(result.notes.length, 2);
});

test('below five themes no-new rounds do not stop before the hard budget', async () => {
  const config = rules(), tasks: string[] = [];
  config.categories.food.settings = { ...config.categories.food.settings, candidateBudget: 200, detailBudget: 200, searchSorts: ['likes'], noNewRounds: 2 };
  let id = 0;
  const port: CollectionPort = {
    async *search(task) {
      tasks.push(task.query);
      // A live feed can keep presenting new candidates that turn out irrelevant.
      for (let page = 0; page < 20; page++) yield Array.from({ length: 5 }, () => card(++id));
    },
    async inspect() { return { reason: 'irrelevant' }; },
  };
  const result = await collectCategory('food', config, now, port, () => {});
  const bases = tasks.map(query => config.categories.food.queries.find(base => query.startsWith(base))!);
  assert.ok(bases.length >= config.categories.food.queries.length * 3, 'basic coverage plus two whole expansion rounds');
  for (let index = config.categories.food.queries.length; index < bases.length; index += config.categories.food.queries.length) {
    if (index + config.categories.food.queries.length <= bases.length) assert.deepEqual(new Set(bases.slice(index, index + config.categories.food.queries.length)), new Set(config.categories.food.queries));
  }
  assert.equal(result.notes.length, 0);
  assert.match(result.run?.stopReason ?? '', /预算/);
  assert.equal(result.candidateCount, 200);
  assert.equal(result.run?.themeTarget?.status, 'shortfall');
});

test('candidate and detail caps remain hard limits across rotation, alternate sorts and supplements', async () => {
  for (const [candidateBudget, detailBudget] of [[20, 20], [80, 10]]) {
    const config = rules(), tasks: SearchTask[] = [], inspections: string[] = [];
    Object.assign(config.categories.food.settings!, { candidateBudget, detailBudget });
    const port = finitePort(task => {
      const base = config.categories.food.queries.findIndex(query => task.query.startsWith(query));
      return Array.from({ length: 100 }, (_, index) => (base + 1) * 1000 + (task.sort === 'collects' ? 200 : 0) + index + 1);
    }, tasks, inspections);
    const result = await collectCategory('food', config, now, port, () => {});
    assert.ok(result.candidateCount <= candidateBudget);
    assert.ok(inspections.length <= detailBudget);
    assert.equal(result.collectionStats?.detailsAttempted, inspections.length);
    assert.equal(new Set(inspections).size, inspections.length);
    assert.match(result.run?.stopReason ?? '', /预算/);
    coverage(result);
  }
});

test('hitting the total deadline preserves collected notes and explicitly leaves later keywords uncovered', async t => {
  const config = rules(), tasks: string[] = [];
  config.categories.food.settings!.maxMinutes = 1;
  let clock = Date.parse(now);
  t.mock.method(Date, 'now', () => clock);
  const port: CollectionPort = {
    async *search(task) { tasks.push(task.query); yield [card(1), card(2)]; },
    async inspect(candidate, task) { clock += 60_001; return { note: note(parseInt(candidate.id, 16), task.query) }; },
  };
  const result = await collectCategory('food', config, now, port, () => {});
  const progress = coverage(result);
  assert.deepEqual(tasks, [config.categories.food.queries[0]]);
  assert.ok(progress.completed < progress.total);
  assert.ok(progress.keywords.slice(1).every(row => !row.basicCovered));
  assert.match(result.run?.stopReason ?? '', /最长检索时间|总时限/);
});

test('caller cancellation remains a rejected run and does not move on to another keyword', async () => {
  const config = rules(), controller = new AbortController(), reason = new Error('Synthetic user stop'), tasks: string[] = [];
  const port: CollectionPort = {
    async *search(task) { tasks.push(task.query); yield [card(1), card(2)]; },
    async inspect(candidate, task) { controller.abort(reason); return { note: note(parseInt(candidate.id, 16), task.query) }; },
  };
  await assert.rejects(collectCategory('food', config, now, port, () => {}, { signal: controller.signal }), error => error === reason);
  assert.deepEqual(tasks, [config.categories.food.queries[0]]);
});

test('semantic grouping starts after basic coverage and mixes notes from different keywords in its first batch', async () => {
  const config = rules(), tasks: SearchTask[] = [], batches: string[][] = [];
  config.categories.food.semantic = { enabled: true, profileId: 'synthetic-only', maxCalls: 2 };
  const port = finitePort(task => {
    const base = config.categories.food.queries.findIndex(query => task.query.startsWith(query));
    return Array.from({ length: 12 }, (_, index) => (base + 1) * 1000 + index + 1);
  }, tasks);
  let calls = 0;
  const result = await collectCategory('food', config, now, port, () => {}, {
    enrich: async notes => {
      const covered = new Set(tasks.map(task => config.categories.food.queries.find(query => task.query.startsWith(query))));
      assert.equal(covered.size, config.categories.food.queries.length, 'AI must not hold up the first keyword pass');
      batches.push(notes.slice(0, 16).map(item => item.query));
      return { notes, calls: ++calls, warnings: [] };
    },
  });
  assert.ok(batches.length > 0);
  for (const query of config.categories.food.queries) assert.ok(batches[0].includes(query));
  assert.equal(coverage(result).completed, config.categories.food.queries.length);
});

test('a hanging semantic batch is bounded and later keyword sorts still execute', async () => {
  const config = rules(), tasks: SearchTask[] = [];
  config.categories.food.semantic = { enabled: true, profileId: 'synthetic-only', maxCalls: 2 };
  const port = finitePort(task => {
    const base = config.categories.food.queries.findIndex(query => task.query.startsWith(query));
    return Array.from({ length: 10 }, (_, index) => (base + 1) * 1000 + (task.sort === 'collects' ? 100 : 0) + index + 1);
  }, tasks);
  let attempts = 0;
  const result = await collectCategory('food', config, now, port, () => {}, {
    scheduler: { groupingTimeoutMs: 10, groupingBudgetMs: 20 },
    enrich: async (_notes, signal) => { attempts++; return untilAborted(signal); },
  });
  assert.ok(attempts > 0 && attempts <= 2);
  assert.ok(tasks.some(task => task.sort === 'collects'));
  assert.equal(coverage(result).completed, config.categories.food.queries.length);
  assert.ok(result.notes.length > config.categories.food.queries.length);
  assert.ok(result.run?.warnings.length, 'falling back after semantic timeout must be visible');
});

test('AI rejection is reflected in effective keyword contributions while original collected notes are preserved', async () => {
  const config = rules(['早餐A', '早餐B']), tasks: SearchTask[] = [];
  config.categories.food.semantic = { enabled: true, profileId: 'synthetic-only', maxCalls: 2 };
  const key = semanticRulesKey(config, 'food');
  const port = finitePort(task => task.query.startsWith('早餐A') ? [1, 2] : [3, 4], tasks);
  const result = await collectCategory('food', config, now, port, () => {}, {
    enrich: async notes => ({ notes: notes.map(item => ({ ...item, topicRuleKey: key, scopeMatch: item.query !== '早餐A' })), calls: 1, warnings: [] }),
  });
  const rows = coverage(result).keywords;
  assert.equal(result.notes.length, 4, 'keep the raw collected evidence');
  assert.equal(result.diagnostics?.eligibleNotes, 2, 'only notes matching the final scope enter the ranking');
  assert.equal(rows.find(row => row.query === '早餐A')?.newNotes, 0, 'a rejected note is not a new effective result');
  assert.equal(rows.find(row => row.query === '早餐A')?.matchedNotes, 0);
  assert.equal(rows.find(row => row.query === '早餐B')?.newNotes, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '../scripts/local-hotspot-storage.mjs';

async function migrate(project: string, root: string) {
  const copy = await storage.prepareLocalHotspotStorage(project, root);
  try { return await copy.activate(); } finally { await copy.discard(); }
}

test('managed hotspots retain rules, rankings and media when the Documents copy becomes unavailable', async () => {
  const base = await mkdtemp(join(tmpdir(), 'managed-hotspots-'));
  const project = join(base, 'project'), legacy = join(project, '.local-data'), root = join(base, 'managed');
  try {
    await mkdir(join(legacy, 'xhs-covers'), { recursive: true });
    await mkdir(join(legacy, 'xhs-topic-cache'));
    const records = new Map([
      ['xhs-hotspots-v2.json', '{"version":2}'], ['xhs-hotspots-rules.json', '{"revision":"mine"}'],
      ['xhs-covers/test.jpg', 'cover bytes'], ['xhs-topic-cache/test.json', '{"labels":[]}'],
    ]);
    for (const [name, value] of records) await writeFile(join(legacy, name), value);
    await writeFile(join(legacy, 'xhs-hotspots-v2.json.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(() => migrate(project, root), /运行|写入/);
    await rm(join(legacy, 'xhs-hotspots-v2.json.lock'));
    const target = await migrate(project, root);
    assert.equal(target, join(root, 'data', 'hotspots'));
    for (const [name, value] of records) {
      assert.equal(await readFile(join(target, name), 'utf8'), value);
      assert.equal(await readFile(join(legacy, name), 'utf8'), value);
    }
    assert.equal(await realpath(join(legacy, 'xhs-hotspots')), await realpath(target));
    await writeFile(join(target, 'xhs-hotspots-rules.json'), '{"revision":"updated"}');
    await rm(join(legacy, 'xhs-hotspots-rules.json'));
    assert.equal(await migrate(project, root), target);
    assert.equal(await readFile(join(legacy, 'xhs-hotspots/xhs-hotspots-rules.json'), 'utf8'), '{"revision":"updated"}');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a legacy write during the online copy never activates a stale snapshot', async () => {
  const base = await mkdtemp(join(tmpdir(), 'managed-hotspot-change-'));
  const project = join(base, 'project'), source = join(project, '.local-data'), root = join(base, 'managed');
  try {
    await mkdir(source, { recursive: true });
    const rules = join(source, 'xhs-hotspots-rules.json');
    await writeFile(rules, '{"revision":"first"}');
    const copy = await storage.prepareLocalHotspotStorage(project, root);
    try {
      await writeFile(rules, '{"revision":"latest"}');
      await assert.rejects(copy.activate, /变动|修改/);
      assert.equal(await readFile(rules, 'utf8'), '{"revision":"latest"}');
      await assert.rejects(realpath(join(root, 'data/hotspots')), { code: 'ENOENT' });
    } finally { await copy.discard(); }
  } finally { await rm(base, { recursive: true, force: true }); }
});

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelJob, enqueue, jobState, runOne, type JobInput } from "../lib/cloud/server/jobs";
import { getRepository } from "../lib/cloud/server/repository";
import { videoInput } from "./video-fixture";

const originalEnvironment = { ...process.env };
let directory = "";
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "xhs-job-watch-"));
  process.env = { ...process.env, APP_MODE: "cloud", CLOUD_LOCAL_TEST: "1", CLOUD_BACKEND: "sqlite", APP_ORIGIN: "http://127.0.0.1:3002", CLOUD_SQLITE_PATH: join(directory, "test.db"), CLOUD_BLOB_PATH: join(directory, "blobs") };
});
after(async () => { process.env = originalEnvironment; await rm(directory, { recursive: true, force: true }); });
const payload = (): JobInput => ({ kind: "video", input: { action: "generate", input: videoInput(), current: null, targetId: "", instruction: "合成测试" } });

test("任务状态读取暂时失败不会误取消，恢复后可完成且不输出数据库原始错误", { timeout: 8_000 }, async () => {
  const owner = randomUUID(), id = randomUUID(), db = await getRepository();
  await enqueue(owner, id, payload());
  let executing = false, checks = 0, calls = 0, release!: () => void, entered!: () => void, checkedAgain!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const continued = new Promise<void>(resolve => { release = resolve; });
  const checked = new Promise<void>(resolve => { checkedAgain = resolve; });
  const originalGet = db.get.bind(db);
  const injected = mock.method(db, "get", async <T>(bucket: string, key: string): Promise<T | null> => {
    if (executing && bucket === "jobs" && key === `${owner}:${id}`) {
      checks++;
      if (checks === 1) throw new Error("PRIVATE_DATABASE_ERROR_SHOULD_NOT_APPEAR");
      checkedAgain();
    }
    return originalGet<T>(bucket, key);
  });
  const output: string[] = [];
  const errorLog = mock.method(console, "error", (...args: unknown[]) => { output.push(args.join(" ")); });
  const warnLog = mock.method(console, "warn", (...args: unknown[]) => { output.push(args.join(" ")); });
  const worker = runOne(async (_input, signal) => {
    calls++; executing = true; entered(); await continued;
    assert.equal(signal.aborted, false);
    return { ok: true };
  });
  try {
    await started;
    await Promise.race([checked, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("状态检查没有恢复")), 5_500))]);
    executing = false; release(); await worker;
    assert.equal(calls, 1);
    assert.equal((await jobState(owner, id)).state, "succeeded");
    assert.doesNotMatch(output.join("\n"), /PRIVATE_DATABASE_ERROR_SHOULD_NOT_APPEAR/);
  } finally { executing = false; release(); await worker; injected.mock.restore(); errorLog.mock.restore(); warnLog.mock.restore(); }
});

test("明确取消后后台仍会中止且迟到结果不能写入", { timeout: 6_000 }, async () => {
  const owner = randomUUID(), id = randomUUID(); await enqueue(owner, id, payload());
  let entered!: () => void, receivedAbort = false, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const worker = runOne(async (_input, signal) => {
    calls++; entered();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { receivedAbort = true; resolve(); }, { once: true }));
    return { late: true };
  });
  await started; await cancelJob(owner, id); await worker;
  const state = await jobState(owner, id);
  assert.equal(receivedAbort, true); assert.equal(calls, 1); assert.equal(state.state, "cancelled"); assert.equal("result" in state, false);
});

test("持续读取故障由总时限结束，不会误报取消或重复派发", { timeout: 6_000 }, async () => {
  const owner = randomUUID(), id = randomUUID(), db = await getRepository(); await enqueue(owner, id, payload());
  const originalGet = db.get.bind(db), originalTimeout = AbortSignal.timeout;
  let executing = false, failedReads = 0, calls = 0;
  const injected = mock.method(db, "get", async <T>(bucket: string, key: string): Promise<T | null> => {
    if (executing && bucket === "jobs" && key === `${owner}:${id}`) { failedReads++; throw new Error("PRIVATE_FAULT"); }
    return originalGet<T>(bucket, key);
  });
  const timeout = mock.method(AbortSignal, "timeout", () => originalTimeout(2_300));
  const keepAlive = setTimeout(() => {}, 3_000);
  try {
    await runOne(async () => { calls++; executing = true; return new Promise(() => {}); });
    executing = false;
    const state = await jobState(owner, id);
    assert.ok(failedReads >= 1); assert.equal(calls, 1); assert.equal(state.state, "failed"); assert.equal(state.error?.code, "TIMEOUT");
    await runOne(async () => { calls++; return {}; }); assert.equal(calls, 1);
  } finally { executing = false; clearTimeout(keepAlive); timeout.mock.restore(); injected.mock.restore(); }
});

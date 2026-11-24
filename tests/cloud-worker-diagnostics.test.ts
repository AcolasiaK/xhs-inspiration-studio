import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../lib/errors";
import { cloudConfig } from "../lib/cloud/server/config";
import { createCloudWorker, startCloudWorker, type Worker } from "../lib/cloud/server/jobs";
import { atWorkerStage, classifyWorkerError, workerLogLine } from "../lib/cloud/server/worker-diagnostics";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("实际启动入口在未确认私有权限时不初始化资源，重复启动不会重复输出", async () => {
  const old = { ...process.env };
  const state = globalThis as typeof globalThis & { __xhsWorker?: Worker; __xhsCloudRepo?: unknown };
  const currentWorker = () => state.__xhsWorker;
  const previousWorker = state.__xhsWorker, previousRepo = state.__xhsCloudRepo;
  delete state.__xhsWorker;
  process.env.APP_ORIGIN = "https://synthetic.example";
  process.env.CLOUD_BACKEND = "cloudbase";
  process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED = "0";
  const warn = mock.method(console, "warn", () => {});
  try {
    startCloudWorker(); startCloudWorker(); currentWorker()?.wake(); await pause(0);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(state.__xhsCloudRepo, previousRepo);
    assert.match(String(warn.mock.calls[0].arguments[0]), /event=paused stage=configuration category=configuration/);
  } finally {
    currentWorker()?.stop();
    if (previousWorker) state.__xhsWorker = previousWorker; else delete state.__xhsWorker;
    warn.mock.restore(); process.env = old;
  }
});

test("配置未确认时只记录一次暂停，定时和手动唤醒都不访问数据库或 AI", async () => {
  const old = { ...process.env };
  process.env.APP_ORIGIN = "https://synthetic.example";
  process.env.CLOUD_BACKEND = "cloudbase";
  process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED = "0";
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  let calls = 0;
  const worker = createCloudWorker(async () => { calls++; return false; }, 5, () => { cloudConfig(); });
  try {
    worker.wake();
    await pause(30);
    assert.equal(calls, 0);
    assert.equal(warn.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 0);
    assert.match(String(warn.mock.calls[0].arguments[0]), /event=paused stage=configuration category=configuration code=CONFIG_INCOMPLETE/);
  } finally { worker.stop(); warn.mock.restore(); error.mock.restore(); process.env = old; }
});

test("配置阻塞需要重启 worker，新实例配置就绪后可处理任务", async () => {
  const warn = mock.method(console, "warn", () => {});
  let ready = false, calls = 0;
  const check = () => { if (!ready) throw new AppError("CLOUD_CONFIG", "synthetic private message", 503); };
  const old = createCloudWorker(async () => { calls++; return false; }, 5, check);
  try {
    ready = true; old.wake(); await pause(15); assert.equal(calls, 0);
    const fresh = createCloudWorker(async () => { calls++; return false; }, 30_000, check);
    try { await pause(0); assert.equal(calls, 1); } finally { fresh.stop(); }
  } finally { old.stop(); warn.mock.restore(); }
});

test("缺少云环境配置被归为配置暂停，非凭据无效", () => {
  const diagnostic = classifyWorkerError(new AppError("CLOUD_ENV_MISSING", "private", 503), "configuration");
  assert.equal(diagnostic.category, "configuration");
  assert.equal(diagnostic.code, "ENVIRONMENT_MISSING");
});

test("SDK 凭据缺失、凭据拒绝与权限拒绝明确区分", () => {
  assert.equal(classifyWorkerError(Object.assign(new Error("missing secretId or secretKey of tencent cloud; PRIVATE"), { code: "INVALID_PARAM" })).code, "CREDENTIALS_UNAVAILABLE");
  assert.equal(classifyWorkerError({ code: "AuthFailure.SignatureFailure", message: "PRIVATE" }).category, "credentials");
  assert.equal(classifyWorkerError({ code: "AccessDenied", statusCode: 403, message: "PRIVATE" }).category, "permission");
  assert.equal(classifyWorkerError({ status: 401 }).category, "credentials");
  assert.equal(classifyWorkerError({ response: { status: 403, data: "PRIVATE" } }).category, "permission");
});

test("网络断开、超时、限流与服务端错误分类，不把所有失败当作授权失败", () => {
  assert.equal(classifyWorkerError({ code: "ENOTFOUND" }).code, "CONNECTION_FAILED");
  assert.equal(classifyWorkerError({ cause: { code: "ECONNRESET" } }).category, "network");
  assert.equal(classifyWorkerError({ code: "ETIMEDOUT" }).code, "CONNECTION_TIMEOUT");
  assert.equal(classifyWorkerError({ status: 429 }).category, "rate_limit");
  assert.equal(classifyWorkerError({ statusCode: 502 }).category, "service");
  assert.equal(classifyWorkerError({ code: "SYNTHETIC_UNKNOWN", message: "private" }).category, "unknown");
});

test("错误阶段在脱敏后仍保留，日志只有允许的分类、状态与耗时", async () => {
  let failure: unknown;
  try { await atWorkerStage("queue_read", async () => { throw { statusCode: 403, code: "AccessDenied", message: "PRIVATE_REQUIREMENTS", body: "PRIVATE_COPY", headers: { authorization: "PRIVATE_KEY" }, url: "https://private.example/photo" }; }); } catch (error) { failure = error; }
  const diagnostic = classifyWorkerError(failure);
  assert.deepEqual(diagnostic, { stage: "queue_read", category: "permission", code: "ACCESS_DENIED", httpStatus: 403 });
  const line = workerLogLine(diagnostic, 42.4);
  assert.match(line, /event=failed stage=queue_read category=permission code=ACCESS_DENIED httpStatus=403 elapsedMs=42$/);
  assert.doesNotMatch(line, /PRIVATE|private\.example|authorization|body|headers|url/);
});

test("未知错误和循环 cause 不输出任意 code、正文、访问口令或签名链接", () => {
  const secret = "SYNTHETIC_SECRET_NEVER_LOG";
  const error: { code: string; message: string; status: string; cause?: unknown } = { code: secret, message: `${secret} image=data:synthetic`, status: secret };
  error.cause = error;
  const line = workerLogLine(classifyWorkerError(error), Infinity);
  assert.match(line, /category=unknown code=UNCLASSIFIED httpStatus=none elapsedMs=0$/);
  assert.ok(!line.includes(secret));
  const withGetter = Object.defineProperty({}, "message", { get() { throw new Error(secret); } });
  assert.equal(classifyWorkerError(withGetter).category, "unknown");
});

test("暂时的网络故障记录分类后仍能轮询恢复，配置暂停不会被误用", async () => {
  const log = mock.method(console, "error", () => {});
  let calls = 0, complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const worker = createCloudWorker(async () => {
    calls++;
    if (calls === 1) return atWorkerStage("queue_read", async () => { throw { code: "ECONNRESET", message: "SYNTHETIC_PRIVATE" }; });
    complete(); return false;
  }, 5);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("worker did not recover")), 500); })]);
    assert.equal(calls, 2);
    assert.equal(log.mock.callCount(), 1);
    const line = String(log.mock.calls[0].arguments[0]);
    assert.match(line, /event=failed stage=queue_read category=network code=CONNECTION_FAILED/);
    assert.doesNotMatch(line, /SYNTHETIC_PRIVATE/);
  } finally { worker.stop(); if (timeout) clearTimeout(timeout); log.mock.restore(); }
});

test("运行期间遇到配置错误也只暂停一次，避免重复失败轮询", async () => {
  const warn = mock.method(console, "warn", () => {});
  let calls = 0;
  const worker = createCloudWorker(async () => { calls++; throw new AppError("CLOUD_CONFIG", "private", 503); }, 5);
  try { await pause(30); worker.wake(); await pause(10); assert.equal(calls, 1); assert.equal(warn.mock.callCount(), 1); }
  finally { worker.stop(); warn.mock.restore(); }
});

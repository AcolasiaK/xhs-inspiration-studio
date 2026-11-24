import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cloudApp } from "../lib/cloud/server/repository";
import { classifyWorkerError } from "../lib/cloud/server/worker-diagnostics";
import { getPublicConfig } from "../lib/server/config";

// Exercise the installed SDK's real credential preparation without sending a
// request. All values are synthetic; this file never loads a local env file.
const require = createRequire(import.meta.url);
const fromSdk = createRequire(require.resolve("@cloudbase/node-sdk"));
const { prepareCredentials } = fromSdk("./utils/tcbapirequester.js") as {
  prepareCredentials: (this: { config: Record<string, unknown>; opts: object }) => Promise<void>;
};
// The installed SDK has this internal field at runtime but omits it from its
// public type declarations. Inspect it only here, using synthetic credentials.
const sdkConfig = (app: unknown) => (app as { config: Record<string, unknown> }).config;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env };
  process.env.CLOUDBASE_ENV_ID = "synthetic-credential-test";
  for (const key of ["CLOUDBASE_SECRET_ID", "CLOUDBASE_SECRET_KEY", "CLOUDBASE_APIKEY", "TENCENTCLOUD_SECRETID", "TENCENTCLOUD_SECRETKEY", "TENCENTCLOUD_SESSIONTOKEN", "TCB_CONTEXT_KEYS", "WX_CONTEXT_KEYS"]) delete process.env[key];
});
afterEach(() => { process.env = previous; });

test("平台注入的 API Key 显式传入真实 SDK，无 context 注入时仍能准备凭据", async () => {
  process.env.CLOUDBASE_APIKEY = "synthetic-api-key-not-a-real-secret";
  const app = await cloudApp();
  assert.equal(sdkConfig(app).accessKey, process.env.CLOUDBASE_APIKEY);
  const request = { config: sdkConfig(app), opts: {} };
  await prepareCredentials.call(request);
  assert.equal(request.config.accessKey, process.env.CLOUDBASE_APIKEY);
  assert.equal(request.config.secretId, undefined);
  assert.equal(typeof app.database().runTransaction, "function");
  assert.equal(typeof app.downloadFile, "function");
  assert.ok(!JSON.stringify(getPublicConfig()).includes(process.env.CLOUDBASE_APIKEY));
});

test("保留已有显式 SecretId/SecretKey 配对的优先级", async () => {
  process.env.CLOUDBASE_APIKEY = "synthetic-injected-key";
  process.env.CLOUDBASE_SECRET_ID = "synthetic-explicit-id";
  process.env.CLOUDBASE_SECRET_KEY = "synthetic-explicit-secret";
  const app = await cloudApp();
  const request = { config: sdkConfig(app), opts: {} };
  await prepareCredentials.call(request);
  assert.equal(request.config.accessKey, undefined);
  assert.equal(request.config.secretId, process.env.CLOUDBASE_SECRET_ID);
  assert.equal(request.config.secretKey, process.env.CLOUDBASE_SECRET_KEY);
});

test("无 API Key 时保留 SDK 读取平台临时凭据的原有方式", async () => {
  process.env.TENCENTCLOUD_SECRETID = "synthetic-platform-id";
  process.env.TENCENTCLOUD_SECRETKEY = "synthetic-platform-secret";
  process.env.TENCENTCLOUD_SESSIONTOKEN = "synthetic-session-token";
  const app = await cloudApp();
  const request = { config: sdkConfig(app), opts: {} };
  await prepareCredentials.call(request);
  assert.equal(request.config.accessKey, undefined);
  assert.equal(request.config.secretId, process.env.TENCENTCLOUD_SECRETID);
  assert.equal(request.config.secretKey, process.env.TENCENTCLOUD_SECRETKEY);
  assert.equal(request.config.sessionToken, process.env.TENCENTCLOUD_SESSIONTOKEN);
});

test("无任何凭据时仍拒绝认证，不补造凭据或改用其他账户", async () => {
  const app = await cloudApp();
  await assert.rejects(prepareCredentials.call({ config: sdkConfig(app), opts: {} }), error => {
    assert.equal(classifyWorkerError(error).code, "CREDENTIALS_UNAVAILABLE");
    return true;
  });
});

test("新初始化读取更新后的注入值，不沿用旧 API Key", async () => {
  process.env.CLOUDBASE_APIKEY = "synthetic-first-key";
  const first = await cloudApp();
  process.env.CLOUDBASE_APIKEY = "synthetic-second-key";
  const next = await cloudApp();
  assert.equal(sdkConfig(first).accessKey, "synthetic-first-key");
  assert.equal(sdkConfig(next).accessKey, "synthetic-second-key");
});

test("缺少环境 ID 时保持明确拒绝，不选择其他环境", async () => {
  delete process.env.CLOUDBASE_ENV_ID;
  await assert.rejects(cloudApp(), /CLOUD_ENV_MISSING/);
});

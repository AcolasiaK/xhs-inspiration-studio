import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/ai/profiles/route";
import { POST as videoPost } from "../app/api/video/route";
import { hashSecret } from "../lib/cloud/server/auth";
import { getRepository } from "../lib/cloud/server/repository";
import { aiTransport } from "../lib/server/ai/provider";
import { selectProfile } from "../lib/server/ai/selection";
import type { ProfileList, PublicProfile } from "../lib/ai-config";
import { videoInput } from "./video-fixture";

const original = { ...process.env };
const origin = "http://127.0.0.1:3291";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const alice = { id: randomUUID(), token: randomBytes(32).toString("base64url"), name: "alice" };
const bob = { id: randomUUID(), token: randomBytes(32).toString("base64url"), name: "bob" };
const gate = randomBytes(32).toString("base64url");
const secret = "synthetic-alice-api-secret-account-isolation";
let directory = "";
let profile: PublicProfile;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "xhs-ai-accounts-"));
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    APP_MODE: "cloud",
    APP_ORIGIN: origin,
    CLOUD_LOCAL_TEST: "1",
    CLOUD_BACKEND: "sqlite",
    CLOUD_SQLITE_PATH: join(directory, "test.sqlite"),
    CLOUD_BLOB_PATH: join(directory, "blobs"),
    AI_CONFIG_DIR: join(directory, "ai-config"),
    AI_CONFIG_SECRET: "synthetic-master-key-for-account-tests-at-least-32-characters",
    // A server-wide legacy credential must never be imported into a cloud account.
    OPENAI_API_KEY: "synthetic-legacy-key-must-not-be-shared",
    OPENAI_MODEL: "synthetic-legacy-model",
  };
  delete process.env.VERCEL;
  process.env.SITE_ACCESS_HASH = await hashSecret("synthetic-gate-password");
  const repo = await getRepository();
  await repo.put("system", "admin_bootstrapped", { done: true });
  await repo.put("gate_sessions", hash(gate), {
    expiresAt: Date.now() + 60_000,
    version: hash(process.env.SITE_ACCESS_HASH),
  });
  for (const user of [alice, bob]) {
    await repo.put("users", user.id, {
      id: user.id, username: user.name, normalized: user.name, role: "user",
      mustChange: false, passwordHash: process.env.SITE_ACCESS_HASH,
      version: 1, createdAt: new Date().toISOString(),
    }, user.id);
    await repo.put("user_sessions", hash(user.token), {
      expiresAt: Date.now() + 60_000, userId: user.id, version: 1,
    }, user.id);
  }
});
after(async () => {
  process.env = original;
  await rm(directory, { recursive: true, force: true });
});

function request(user: typeof alice, body?: unknown, path = "/api/ai/profiles", identity = user.id) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin, "content-type": "application/json", "x-workspace-user": identity,
      cookie: `xhs-dev-gate=${gate}; xhs-dev-user=${user.token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const fields = (name: string, apiKey = secret) => ({
  name, provider: "openai", protocol: "responses", baseUrl: "https://api.openai.com/v1",
  apiKey, model: "synthetic-manual-model",
});
async function list(user: typeof alice): Promise<ProfileList> {
  const response = await GET(request(user));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json();
  assert.doesNotMatch(JSON.stringify(value), /synthetic-alice-api-secret|synthetic-legacy-key/);
  return value;
}

test("登录账号分别保存同类型多套配置，列表和密文均不泄露密钥", async () => {
  assert.deepEqual((await list(alice)).profiles, []);
  assert.deepEqual((await list(bob)).profiles, []);
  for (const name of ["Alice 主配置", "Alice 备用配置"]) {
    const response = await POST(request(alice, { action: "save", profile: fields(name) }));
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.doesNotMatch(JSON.stringify(value), /synthetic-alice-api-secret/);
    assert.equal("apiKey" in value.profile, false);
    assert.equal(value.profile.hasApiKey, true);
    assert.equal(value.profile.maskedApiKey, "••••••••tion");
    profile ??= value.profile;
  }
  const mine = await list(alice);
  assert.equal(mine.profiles.length, 2);
  assert.equal(mine.profiles[0].provider, mine.profiles[1].provider);
  assert.equal(mine.defaultId, null);
  assert.deepEqual((await list(bob)).profiles, []);
  const stored = await (await getRepository()).scan("ai_profiles");
  assert.equal(stored.length, 1, "只读取空列表的账号不应产生加密配置行");
  assert.doesNotMatch(JSON.stringify(stored), /synthetic-alice-api-secret|synthetic-manual-model|Alice 主配置/);
});

test("另一账号不能读取调用修改删除配置，也不能伪造工作区身份", async () => {
  let requests = 0;
  const transport = mock.method(aiTransport, "fetch", async () => {
    requests++;
    throw new Error("NO_NETWORK_EXPECTED");
  });
  try {
    assert.equal((await GET(request(bob, undefined, "/api/ai/profiles", alice.id))).status, 409);
    for (const body of [
      { action: "save", id: profile.id, revision: profile.revision, profile: fields("非法修改") },
      { action: "delete", id: profile.id },
      { action: "default", id: profile.id },
      { action: "models", id: profile.id },
      { action: "test", id: profile.id, kind: "text" },
      { action: "test", id: profile.id, kind: "image" },
    ]) {
      const response = await POST(request(bob, body));
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /synthetic-alice-api-secret/);
    }
    const video = request(bob, {
      action: "generate", input: videoInput(), current: null, targetId: "", instruction: "合成测试",
    }, "/api/video");
    video.headers.set("X-AI-Profile", profile.id);
    video.headers.set("X-Client-Request-Id", randomUUID());
    assert.equal((await videoPost(video)).status, 404);
    assert.equal(requests, 0);
    assert.equal((await list(alice)).profiles.length, 2);
    assert.deepEqual((await list(bob)).profiles, []);
  } finally { transport.mock.restore(); }
});

test("本人编辑空密钥保留，模型列表失败不阻止手填，删除默认不自动回退", async () => {
  const logs: string[] = [];
  const consoleError = mock.method(console, "error", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  let requests = 0;
  const transport = mock.method(aiTransport, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    return Response.json({ error: { message: `upstream-private-detail ${secret}` } }, { status: 404 });
  });
  try {
    const models = await POST(request(alice, { action: "models", id: profile.id }));
    assert.equal(models.status, 502);
    assert.doesNotMatch(await models.text(), /synthetic-alice-api-secret|upstream-private-detail/);
    assert.equal(requests, 1);
    const edited = await POST(request(alice, {
      action: "save", id: profile.id, revision: profile.revision,
      profile: { ...fields("Alice 手填模型", ""), model: "synthetic-new-manual-model" },
    }));
    assert.equal(edited.status, 200);
    profile = (await edited.json()).profile;
    assert.equal(profile.hasApiKey, true);
    assert.equal(profile.maskedApiKey, "••••••••tion");
    assert.equal(profile.textTest.status, "unverified");
    assert.equal(profile.imageTest.status, "unverified");
    assert.equal((await POST(request(alice, { action: "default", id: profile.id }))).status, 200);
    assert.equal((await list(alice)).defaultId, profile.id);
    assert.equal((await list(bob)).defaultId, null);
    assert.equal((await POST(request(alice, { action: "delete", id: profile.id }))).status, 200);
    const afterDelete = await list(alice);
    assert.equal(afterDelete.profiles.length, 1);
    assert.equal(afterDelete.defaultId, null);
    assert.equal((await selectProfile(alice.id)).profile, null);
    await assert.rejects(selectProfile(alice.id, profile.id), /已删除或不属于/);
    assert.equal(requests, 1);
    assert.doesNotMatch(logs.join("\n"), /synthetic-alice-api-secret|upstream-private-detail/);
  } finally { transport.mock.restore(); consoleError.mock.restore(); }
});

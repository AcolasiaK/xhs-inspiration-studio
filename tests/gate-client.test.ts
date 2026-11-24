import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGate } from "../lib/cloud/gate-client";

const response = (body: unknown, status = 200) => Response.json(body, { status });

test("口令原样提交并确认会话，不能自动移除空格或改变大小写", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    if (url === "/api/cloud/auth/gate") {
      assert.equal(JSON.parse(String(init?.body)).secret, " Test value ");
      return response({ ok: true });
    }
    assert.equal(url, "/api/cloud/auth/status");
    return response({ gateVerified: true });
  };
  await verifyGate(" Test value ", request);
  assert.equal(calls, 2);
});

test("空口令不发请求；错误、配置异常、限流和来源错误各自提示", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error("not expected"); };
  await assert.rejects(verifyGate(" \t", request), /请输入统一访问口令/);
  assert.equal(calls, 0);
  const examples: Array<[string, number, RegExp]> = [
    ["GATE_INVALID", 401, /口令验证失败/],
    ["CLOUD_CONFIG", 503, /服务端访问配置/],
    ["RATE_LIMIT", 429, /过于频繁/],
    ["INVALID_ORIGIN", 403, /网址/],
    ["CLOUD_ERROR", 503, /服务暂时不可用/],
  ];
  for (const [code, status, message] of examples) {
    await assert.rejects(verifyGate("synthetic", async () => response({ error: { code } }, status)), message);
  }
});

test("网络失败、超时和 Cookie 未保存均不能误报口令错误", async () => {
  await assert.rejects(verifyGate("synthetic", async () => { throw new TypeError("network"); }), /网络连接失败/);
  const timeout: typeof fetch = async (_url, init) => new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(verifyGate("synthetic", timeout, 5), /请求超时/);
  const request: typeof fetch = async url => url === "/api/cloud/auth/gate" ? response({ ok: true }) : response({ gateVerified: false });
  await assert.rejects(verifyGate("synthetic", request), /Cookie/);
});

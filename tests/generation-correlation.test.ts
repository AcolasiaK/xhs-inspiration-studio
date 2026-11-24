// 端到端协议测试：浏览器编排 → 本地路由 → 已拦截的供应商，不访问真实网络或凭证。
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { POST } from "../app/api/generate/route";
import { createDemoResult } from "../lib/demo";
import { emptyBrief } from "../lib/schema";
import { GenerationRequestError, generationErrorMessage, submitGeneration } from "../lib/generation-request";
import type { StudioImage } from "../lib/types";

for (const failingStage of ["initial_request", "tag_repair_request"] as const) {
  test(`客户端到服务端的关联在 ${failingStage} 模拟 502 时贯通且不泄露内容`, async () => {
    const originalEnv = { ...process.env };
    process.env = { ...originalEnv, NODE_ENV: "test", OPENAI_BASE_URL: "https://rightapi.ai/v1", OPENAI_MODEL: "test-model", OPENAI_API_KEY: "test-private-api-key", APP_ACCESS_TOKEN: "test-private-access-token" };
    const logs: string[] = [];
    const info = mock.method(console, "info", (...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
    const error = mock.method(console, "error", (...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
    let providerCalls = 0, localCalls = 0;
    let ids: string[] = [];
    const provider = mock.method(globalThis, "fetch", async () => {
      providerCalls++;
      if (failingStage === "tag_repair_request" && providerCalls === 1) {
        const incomplete = createDemoResult(ids); incomplete.hashtags = ["#不足"];
        return Response.json({ id: "mock-response", object: "response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(incomplete), annotations: [] }] }] });
      }
      return Response.json({ error: { code: "provider_failed", type: "server_error", message: "SECRET_PROVIDER_RESPONSE" } }, { status: 502 });
    });
    try {
      const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#32a154" } }).jpeg().toBuffer();
      const images: StudioImage[] = Array.from({ length: 2 }, (_, index) => ({
        id: crypto.randomUUID(), file: new File([new Uint8Array(bytes)], `test${index}.jpg`, { type: "image/jpeg" }),
        preview: `blob:test${index}`, width: 12, height: 12,
      }));
      ids = images.map((image) => image.id);
      const requestId = crypto.randomUUID();
      await assert.rejects(submitGeneration({ brief: { ...emptyBrief, topic: "SECRET_USER_TOPIC" }, mode: "live", images,
        accessToken: "test-private-access-token", controller: new AbortController(), requestId,
        onProgress: () => undefined, onRequestStarted: () => undefined,
        compress: async (items) => items.map((image) => image.file),
        request: async (_url, init) => {
          localCalls++;
          const headers = new Headers(init?.headers); headers.set("host", "localhost"); headers.set("origin", "http://localhost");
          return POST(new Request("http://localhost/api/generate", { method: "POST", body: init?.body, headers, signal: init?.signal }));
        },
      }), (reason: unknown) => {
        assert(reason instanceof GenerationRequestError); assert.equal(reason.requestId, requestId); assert.equal(reason.stage, failingStage);
        assert.equal(reason.code, "PROVIDER_UNAVAILABLE"); assert.equal(reason.httpStatus, 502);
        assert(generationErrorMessage(reason).includes(requestId)); assert(!generationErrorMessage(reason).includes("SECRET_PROVIDER_RESPONSE")); return true;
      });
      assert.equal(localCalls, 1); assert.equal(providerCalls, failingStage === "initial_request" ? 1 : 2);
      assert(logs.some((line) => line.includes(`requestId=${requestId}`) && line.includes(`stage=${failingStage}`) && line.includes("providerStatus=502")));
      assert(logs.some((line) => line.includes(`requestId=${requestId}`) && line.includes("phase=api_request") && line.includes("httpStatus=502")));
      const combined = logs.join("\n");
      for (const sensitive of ["test-private-api-key", "test-private-access-token", "SECRET_USER_TOPIC", "SECRET_PROVIDER_RESPONSE", "base64"]) assert(!combined.includes(sensitive));
    } finally { provider.mock.restore(); info.mock.restore(); error.mock.restore(); process.env = originalEnv; }
  });
}

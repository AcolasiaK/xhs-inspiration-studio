import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { emptyBrief } from "../lib/schema";
import { MAX_REQUEST_BYTES } from "../lib/constants";

async function main() {
  const base = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const picture = await sharp({ create: { width: 160, height: 100, channels: 3, background: "#d8a58b" } }).png().toBuffer();
  const ids = [randomUUID(), randomUUID()];
  function make(mode = "demo", topic = "测试", bytes = picture, type = "image/png") {
    const form = new FormData();
    form.set("payload", JSON.stringify({ brief: { ...emptyBrief, topic }, mode, imageIds: ids }));
    ids.forEach(() => form.append("images", new Blob([new Uint8Array(bytes)], { type }), "test.png"));
    return form;
  }
  let response = await fetch(`${base}/api/generate`, { method: "POST", body: make() });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mode, "demo"); assert.equal(data.result.titles.length, 5);
  assert.deepEqual(data.result.imageCaptions.map((x: { imageId: string }) => x.imageId), ids);
  console.log("PASS 演示接口：5 个标题、多图 ID 对应、完整结果");
  response = await fetch(`${base}/api/generate`, { method: "POST", body: make("demo", " ") });
  assert.equal(response.status, 400); console.log("PASS 空主题被拒绝");
  response = await fetch(`${base}/api/generate`, { method: "POST", body: make("demo", "测试", Buffer.from("fake")) });
  assert.equal(response.status, 400); console.log("PASS 伪装图片被拒绝");
  response = await fetch(`${base}/api/generate`, { method: "POST", body: make("demo", "测试", picture, "text/plain") });
  assert.equal(response.status, 400); console.log("PASS 非图片文件被拒绝");
  response = await fetch(`${base}/api/generate`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body: Buffer.alloc(MAX_REQUEST_BYTES + 1) });
  assert.equal(response.status, 413); console.log("PASS 超大请求被拒绝");
  response = await fetch(`${base}/api/generate`, { method: "POST", headers: { origin: "https://unrelated.example" }, body: make() });
  assert.equal(response.status, 403); console.log("PASS 跨站提交被拒绝");
  response = await fetch(`${base}/api/generate`, { method: "POST", body: make("invalid") });
  assert.equal(response.status, 400); console.log("PASS 未知模式被拒绝");
  // 不主动发起 live 请求，避免测试在用户后来配置密钥后意外产生费用。
  console.log("API 冒烟测试全部通过；未调用付费模型。");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { parseUpload, readBoundedFormData } from "../lib/server/uploads";
import { emptyBrief } from "../lib/schema";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from "../lib/constants";

function form(files: { bytes: Uint8Array; type: string }[], overrides = {}) {
  const data = new FormData();
  data.set("payload", JSON.stringify({ brief: { ...emptyBrief, topic: "测试" }, mode: "demo", imageIds: files.map(() => randomUUID()), ...overrides }));
  for (const file of files) data.append("images", new Blob([Buffer.from(file.bytes)], { type: file.type }), "test-image");
  return data;
}
const png = () => sharp({ create: { width: 160, height: 100, channels: 3, background: "#ee7567" } }).png().toBuffer();

test("完整解码有效图片并转换为可供模型使用的 data URL", async () => {
  const result = await parseUpload(form([{ bytes: await png(), type: "image/png" }]));
  assert.match(result.images[0].dataUrl, /^data:image\/jpeg;base64,/);
  const meta = await sharp(Buffer.from(result.images[0].dataUrl.split(",")[1], "base64")).metadata();
  assert.equal(meta.width, 160); assert.equal(meta.format, "jpeg");
});
test("不接受 MIME 伪装和损坏图片", async () => {
  await assert.rejects(parseUpload(form([{ bytes: await png(), type: "image/jpeg" }])), /无法读取/);
  await assert.rejects(parseUpload(form([{ bytes: Buffer.from("not a picture"), type: "image/png" }])), /无法读取/);
});
test("拒绝不支持的格式和超大文件", async () => {
  await assert.rejects(parseUpload(form([{ bytes: Buffer.from("svg"), type: "image/svg+xml" }])), /仅支持/);
  await assert.rejects(parseUpload(form([{ bytes: Buffer.alloc(MAX_FILE_BYTES + 1), type: "image/png" }])), /5MB/);
  await assert.rejects(parseUpload(form([{ bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1), type: "image/png" }])), /3MiB/);
});
test("缺图与空主题在服务端被拒绝", async () => {
  await assert.rejects(parseUpload(form([], { imageIds: [randomUUID()] })), /不一致/);
  await assert.rejects(parseUpload(form([{ bytes: await png(), type: "image/png" }], { brief: emptyBrief })), /填写主题/);
});
test("multipart 读取正常，未知请求类型被拒绝", async () => {
  const body = form([{ bytes: await png(), type: "image/png" }]);
  const data = await readBoundedFormData(new Request("http://localhost/api/generate", { method: "POST", body }));
  assert.equal(data.getAll("images").length, 1);
  await assert.rejects(readBoundedFormData(new Request("http://localhost", { method: "POST", body: "text" })), /上传表单/);
});
test("即使没有 Content-Length，读取流也会在请求上限处停止", async () => {
  const request = new Request("http://localhost", {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" },
    body: new Uint8Array(MAX_REQUEST_BYTES + 1),
  });
  await assert.rejects(readBoundedFormData(request), /过大/);
});

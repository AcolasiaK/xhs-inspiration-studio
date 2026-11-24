// No .env.local access or real outbound API calls: fetch is replaced with a synthetic response.
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { POST } from "../app/api/partial-rewrite/route";
import { emptyBrief } from "../lib/schema";
import { partialRewriteRequestSchema, type PartialTarget } from "../lib/partial-rewrite-schema";
import { validatePartialResult } from "../lib/server/partial-rewrite";

const savedEnv = { ...process.env };
let outbound: ReturnType<typeof mock.method<typeof globalThis, "fetch">>;
let clock = Date.now();
beforeEach(() => {
  clock += 60_001; mock.method(Date, "now", () => clock);
  process.env.OPENAI_API_KEY = "test-only-placeholder";
  process.env.OPENAI_MODEL = "test-vision-model";
  process.env.APP_ACCESS_TOKEN = "";
  delete process.env.OPENAI_BASE_URL;
  process.env = { ...process.env, NODE_ENV: "test" };
  outbound = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network call"); });
});
afterEach(() => { mock.restoreAll(); process.env = { ...savedEnv }; });

const ids = [randomUUID(), randomUUID()];
const tags = Array.from({ length: 10 }, (_, index) => `#话题${index}`);
const sample = {
  titles: ["原标题一", "原标题二", "原标题三", "原标题四", "原标题五"],
  coverCopy: { headline: "封面", subline: "副标题" },
  imageCaptions: ids.map((imageId, index) => ({ imageId, headline: `原图${index}`, description: `原图说明${index}` })),
  body: "编辑后的正文", hashtags: [tags.join(" ")], warnings: [],
};
const createInput = (target: PartialTarget, overrides: Record<string, unknown> = {}) => partialRewriteRequestSchema.parse({
  brief: { ...emptyBrief, topic: "合成图片测试", emoji: false }, mode: "live", imageIds: ids, target,
  targetIndex: 0, targetImageId: ids[0], direction: "natural", instruction: "", current: sample, ...overrides,
});
const output = (fields: Partial<{ titles: string[]; imageCaptions: {imageId:string;headline:string;description:string}[]; hashtags: string[] }> = {}) => ({ titles: [], imageCaptions: [], hashtags: [], ...fields });
function answer(value: ReturnType<typeof output>) {
  return { id: "response-test", object: "response", status: "completed", output: [{ id: "message-test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] };
}
async function upload(target: PartialTarget) {
  const form = new FormData(); form.set("payload", JSON.stringify(createInput(target)));
  const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#dd9977" } }).png().toBuffer();
  ids.forEach(() => form.append("images", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "fixture.png"));
  return new Request("http://localhost/api/partial-rewrite", { method: "POST", headers: { host: "localhost", origin: "http://localhost" }, body: form });
}

test("单标题三个候选、全部标题五个且不能重复", () => {
  const single = createInput("title_one");
  assert.deepEqual(validatePartialResult(single, output({ titles: ["新标题一", "新标题二", "新标题三"] })).titles, ["新标题一", "新标题二", "新标题三"]);
  assert.throws(() => validatePartialResult(single, output({ titles: ["新标题一", "新标题一", "新标题三"] })));
  assert.throws(() => validatePartialResult(single, output({ titles: ["原标题一", "新标题二", "新标题三"] })));
  assert.throws(() => validatePartialResult(createInput("titles_all"), output({ titles: ["新标题一"] })));
  assert.throws(() => validatePartialResult(createInput("titles_all"), output({ titles: ["原标题一", "新标题二", "新标题三", "新标题四", "新标题五"] })));
  assert.equal(validatePartialResult(createInput("titles_all"), output({ titles: ["新标题一", "新标题二", "新标题三", "新标题四", "新标题五"] })).titles.length, 5);
});

test("配文严格校验图片 ID，所有配文按原图顺序重新排序", () => {
  const reversed = ids.slice().reverse().map((imageId) => ({ imageId, headline: "新标题", description: "新说明\n第二行" }));
  assert.deepEqual(validatePartialResult(createInput("captions_all"), output({ imageCaptions: reversed })).imageCaptions.map((x) => x.imageId), ids);
  assert.throws(() => validatePartialResult(createInput("captions_all"), output({ imageCaptions: [reversed[0], reversed[0]] })));
  assert.throws(() => validatePartialResult(createInput("caption_one"), output({ imageCaptions: [reversed[0]] })));
  assert.equal(validatePartialResult(createInput("caption_one"), output({ imageCaptions: [reversed[1]] })).imageCaptions[0].imageId, ids[0]);
  assert.throws(() => validatePartialResult(createInput("caption_one"), output({ imageCaptions: [{...reversed[1], description:"只有一行"}] })));
  assert.throws(() => validatePartialResult(createInput("caption_one"), output({ imageCaptions: [sample.imageCaptions[0]] })));
  assert.throws(() => validatePartialResult(createInput("captions_all"), output({ imageCaptions: [sample.imageCaptions[0], reversed[0]] })));
});

test("单话题三个候选和十话题规范化、严格去重和保留话题隔离", () => {
  const input = createInput("tag_one");
  assert.deepEqual(validatePartialResult(input, output({ hashtags: ["##新话题甲", "＃新话题乙", "新话题丙"] })).hashtags, ["#新话题甲", "#新话题乙", "#新话题丙"]);
  assert.throws(() => validatePartialResult(input, output({ hashtags: ["#话题1", "#新话题乙", "#新话题丙"] })));
  assert.throws(() => validatePartialResult(input, output({ hashtags: ["#a", "#Ａ", "#b"] })));
  assert.throws(() => validatePartialResult(input, output({ hashtags: ["#a #b", "#c", "#d"] })));
  assert.equal(validatePartialResult(createInput("tags_all"), output({ hashtags: [...tags.slice(0, 9), "#新话题"] })).hashtags.length, 10);
  assert.throws(() => validatePartialResult(createInput("tags_all"), output({ hashtags: [...tags].reverse() })));
  assert.throws(() => validatePartialResult(createInput("tags_all"), output({ hashtags: [...tags.slice(0, 9), tags[0]] })));
  assert.throws(() => validatePartialResult(createInput("tags_all"), output({ hashtags: tags.slice(0, 9) })));
  assert.equal(partialRewriteRequestSchema.safeParse({ ...input, current: { ...sample, hashtags: [tags.join(" ") + " #话题0"] } }).success, false);
});

test("快照图片顺序、单图目标及单个话题索引无效时拒绝", () => {
  const input = createInput("caption_one");
  assert.equal(partialRewriteRequestSchema.safeParse({ ...input, imageIds: [...ids].reverse() }).success, false);
  assert.equal(partialRewriteRequestSchema.safeParse({ ...input, targetImageId: randomUUID() }).success, false);
  assert.equal(partialRewriteRequestSchema.safeParse({ ...createInput("tag_one"), targetIndex: 10 }).success, false);
});

test("模型按原图和当前内容调用一次，返回结果结构与标题候选", async () => {
  outbound.mock.mockImplementation(async () => Response.json(answer(output({ titles: ["新标题一", "新标题二", "新标题三"] }))));
  const response = await POST(await upload("title_one"));
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.result.titles.length, 3); assert.deepEqual(data.result.imageCaptions, []);
  const sent = JSON.parse(String(outbound.mock.calls[0].arguments[1]?.body));
  assert.equal(sent.text.format.type, "json_schema"); assert.equal(sent.text.format.strict, true); assert.equal(sent.store, false);
  assert.equal(sent.input[1].content.filter((item: {type:string}) => item.type === "input_image").length, 2);
  assert.ok(sent.input[1].content[0].text.includes("编辑后的正文")); assert.equal(outbound.mock.callCount(), 1);
});

test("502、超时和不合格结果不泄漏响应内容，也不自动重试", async () => {
  outbound.mock.mockImplementation(async () => Response.json({ error: { message: "PRIVATE_PROVIDER_DETAIL" } }, { status: 502 }));
  let response = await POST(await upload("titles_all")); let data = await response.json();
  assert.equal(response.status, 502); assert.equal(data.error.code, "PROVIDER_UNAVAILABLE"); assert.ok(!JSON.stringify(data).includes("PRIVATE_PROVIDER_DETAIL")); assert.equal(outbound.mock.callCount(), 1);
  outbound.mock.mockImplementation(async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); });
  response = await POST(await upload("titles_all")); data = await response.json(); assert.equal(data.error.code, "TIMEOUT"); assert.equal(outbound.mock.callCount(), 2);
  outbound.mock.mockImplementation(async () => Response.json(answer(output({ titles: ["唯一"] }))));
  response = await POST(await upload("titles_all")); data = await response.json(); assert.equal(data.error.code, "INVALID_RESULT"); assert.equal(outbound.mock.callCount(), 3);
});

test("禁用词、非允许 Emoji 被拒绝", () => {
  const input = createInput("title_one", { brief: { ...emptyBrief, topic: "合成图片测试", emoji: false, forbidden: "禁词" } });
  assert.throws(() => validatePartialResult(input, output({ titles: ["禁词一", "新二", "新三"] })));
  assert.throws(() => validatePartialResult(input, output({ titles: ["新一😊", "新二", "新三"] })));
});

test("取消模型请求不会重试，返回取消并保留原内容", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  outbound.mock.mockImplementation(async (_url, init) => {
    entered();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    });
  });
  const source = await upload("caption_one");
  const controller = new AbortController();
  const request = new Request(source, { signal: controller.signal });
  const pending = POST(request); await started; controller.abort();
  const response = await pending; assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, "CANCELLED"); assert.equal(outbound.mock.callCount(), 1);
});

test("旧草稿标签不足或重复时仍能重新生成全部，但不允许单标签重写", () => {
  const current = { ...sample, hashtags: ["##家居 #家居 #收纳"] };
  assert.equal(partialRewriteRequestSchema.safeParse({ ...createInput("tags_all"), current }).success, true);
  assert.equal(partialRewriteRequestSchema.safeParse({ ...createInput("tag_one"), current }).success, false);
});

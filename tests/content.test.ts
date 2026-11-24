import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { createDemoResult } from "../lib/demo";
import { analyzeHashtags, formatAll, formatGeneratedParagraphs, formatHashtags, formatNote } from "../lib/format";
import { AppError } from "../lib/errors";
import { validateResult } from "../lib/validate-result";
import { briefSchema, emptyBrief, modelResultSchema, requestSchema } from "../lib/schema";
import { checkRateLimit, verifyAccessToken } from "../lib/server/guard";

const ids = [randomUUID(), randomUUID(), randomUUID()];
test("固定样例具有五个不同标题和完整的逐图配文", () => {
  const result = validateResult(createDemoResult(ids), ids);
  assert.equal(result.titles.length, 5);
  assert.deepEqual(result.imageCaptions.map((item) => item.imageId), ids);
  assert.match(result.warnings.join(""), /未分析/);
});
test("服务端按稳定 ID 排序，不把配文串给别的图片", () => {
  const draft = createDemoResult(ids);
  const firstText = draft.imageCaptions[0].headline;
  draft.imageCaptions.reverse();
  assert.equal(validateResult(draft, ids).imageCaptions[0].headline, firstText);
});
test("拒绝遗漏、重复、未知图片 ID", () => {
  for (const invalid of [[ids[0]], [ids[0], ids[0], ids[2]], [ids[0], ids[1], randomUUID()]]) {
    assert.throws(() => validateResult(createDemoResult(invalid), ids), /对应/);
  }
});
test("拒绝标题数不对和重复标题", () => {
  const draft = createDemoResult(ids);
  assert.throws(() => validateResult({ ...draft, titles: draft.titles.slice(0, 3) }, ids), /不完整/);
  assert.throws(() => validateResult({ ...draft, titles: Array(5).fill("重复") }, ids), /不完整/);
});
test("话题复制去掉重复 #、全角符号和重复话题", () => {
  assert.equal(formatHashtags("##咖啡 ＃周末，#咖啡、生活"), "#咖啡 #周末 #生活");
});
test("话题统一去掉序号、引号、空项、重复符号及重复项", () => {
  const value = '1. ##咖啡 2. ＃周末, #咖啡 、 "生活" ##';
  const info = analyzeHashtags(value);
  assert.deepEqual(info.tags, ["#咖啡", "#周末", "#生活"]);
  assert.equal(info.count, 3); assert.equal(info.duplicateCount, 1); assert.equal(info.invalidCount, 0);
  assert.equal(info.valid, false);
  assert.equal(formatHashtags("1.咖啡 二、#周末 三）生活"), "#咖啡 #周末 #生活");
});
test("不足、超出、重复及内部非法字符不可作为 10 个合格话题", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `#话题${i + 1}`);
  assert.equal(analyzeHashtags(ten).valid, true);
  assert.equal(analyzeHashtags(ten.slice(0, 9)).valid, false);
  assert.equal(analyzeHashtags([...ten, "额外话题"]).valid, false);
  assert.equal(analyzeHashtags([...ten.slice(0, 9), ten[0]]).valid, false);
  const bad = analyzeHashtags([...ten.slice(0, 9), "#错误/格式"]);
  assert.equal(bad.invalidCount, 1); assert.equal(bad.count, 9); assert.equal(bad.valid, false);
  for (const tags of [ten.slice(0, 9), [...ten, "额外话题"], [...ten.slice(0, 9), ten[0]], []]) {
    const draft = { ...createDemoResult(ids), hashtags: tags };
    assert.throws(() => validateResult(draft, ids), (error: unknown) => error instanceof AppError && error.code === "HASHTAG_COUNT");
  }
});
test("表情和纯符号不会被静默忽略，编号标记不会变成数字话题", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `#话题${i + 1}`);
  const mixed = analyzeHashtags([...ten, "#💊"]);
  assert.equal(mixed.count, 10); assert.equal(mixed.invalidCount, 1); assert.equal(mixed.valid, false);
  assert.equal(analyzeHashtags("#💊").invalidCount, 1);
  assert.equal(analyzeHashtags("#健康💊").invalidCount, 1);
  assert.equal(analyzeHashtags("#@健康").invalidCount, 1);
  assert.equal(analyzeHashtags("/ * 💊").invalidCount, 3);
  assert.equal(analyzeHashtags("## ，， #").invalidCount, 0);
  assert.deepEqual(analyzeHashtags("1. 一、 二） 3, 4.").tags, []);
  assert.equal(analyzeHashtags("1. 一、 二） 3, 4.").invalidCount, 0);
  assert.equal(formatHashtags("一、#咖啡 二）#周末 3, #生活"), "#咖啡 #周末 #生活");
  assert.equal(formatHashtags('"#咖啡" 「#周末」'), "#咖啡 #周末");
  assert.deepEqual(analyzeHashtags("#1. #咖啡 #1").tags, ["#咖啡", "#1"]);
  assert.equal(analyzeHashtags("#1.周年").invalidCount, 1);
});
test("完整笔记只含选择的最新标题、正文和规范话题", () => {
  const result = createDemoResult(ids);
  result.titles[1] = "第二个标题已编辑"; result.body = "第一段\n\n第二段";
  result.hashtags = ["##咖啡 ＃周末，#咖啡"];
  const text = formatNote(result, 1);
  assert.equal(text, "第二个标题已编辑\n\n第一段\n\n第二段\n\n#咖啡 #周末");
  assert(!text.includes("封面文案")); assert(!text.includes(result.titles[0]));
});
test("复制全部包含最新编辑，保留正文段落和封面", () => {
  const result = createDemoResult(ids);
  result.titles[0] = "修改后的标题";
  result.body = "修改后的正文\n\n第二段";
  result.imageCaptions[0].headline = "修改后的图片配文";
  const text = formatAll(result);
  assert.match(text, /修改后的标题/); assert.match(text, /修改后的正文\n\n第二段/);
  assert.match(text, /修改后的图片配文/); assert.match(text, /今天，慢一点/);
});
test("空白主题和重复请求 ID 不被接受", () => {
  assert.equal(briefSchema.safeParse({ ...emptyBrief, topic: "   " }).success, false);
  assert.equal(requestSchema.safeParse({ brief: { ...emptyBrief, topic: "测试" }, mode: "demo", imageIds: [ids[0], ids[0]] }).success, false);
});
test("禁用词和关闭 Emoji 会进行生成后校验", () => {
  const result = createDemoResult(ids);
  assert.throws(() => validateResult(result, ids, { ...emptyBrief, topic: "测试", forbidden: "咖啡" }), /禁用词/);
  assert.throws(() => validateResult(result, ids, { ...emptyBrief, topic: "测试", emoji: false }), /Emoji/);
});
test("遗漏必提内容时返回明确提示", () => {
  const result = validateResult(createDemoResult(ids), ids, { ...emptyBrief, topic: "测试", mustInclude: "自行车" });
  assert.ok(result.warnings.some((item) => item.includes("自行车")));
});
test("满额提示和长必提内容补充后，结果仍能通过前端校验", () => {
  const draft = createDemoResult(ids);
  draft.warnings = Array.from({ length: 20 }, (_, i) => `待确认事项 ${i + 1}`);
  draft.body = "很短的正文";
  const result = validateResult(draft, ids, { ...emptyBrief, topic: "测试", mustInclude: "需".repeat(500) });
  assert.equal(result.warnings.length, 22);
  assert.doesNotThrow(() => validateResult(result, ids));
  assert.ok(result.warnings.some((item) => item.includes("偏离所选")));
});
test("关闭 Emoji 时也能识别数字键帽", () => {
  const draft = createDemoResult(ids);
  draft.body = "选项 1️⃣";
  draft.titles = ["角度一", "角度二", "角度三", "角度四", "角度五"];
  assert.throws(() => validateResult(draft, ids, { ...emptyBrief, topic: "测试", emoji: false }), /Emoji/);
});
test("官方 SDK 可以将输出 schema 转换为严格 JSON Schema", () => {
  const format = zodTextFormat(modelResultSchema, "xhs_content");
  assert.equal(format.type, "json_schema"); assert.equal(format.strict, true);
});
test("单段生成正文仅在已有句末补空行，原有段落和原文信息保留", () => {
  const original = "画面里有红色杯子。蓝色书本放在右侧。柠檬是黄色的。";
  const formatted = formatGeneratedParagraphs(original);
  assert.match(formatted, /\n\n/);
  assert.equal(formatted.replace(/\n\n/g, ""), original);
  assert.equal(formatGeneratedParagraphs("第一段。\n\n第二段。"), "第一段。\n\n第二段。");
  assert.equal(formatGeneratedParagraphs("只有一句没有句末分隔"), "只有一句没有句末分隔");
});
test("访问口令正确才通过，空口令不通过", () => {
  assert.equal(verifyAccessToken("private-test-token", "private-test-token"), true);
  assert.equal(verifyAccessToken("wrong", "private-test-token"), false);
  assert.equal(verifyAccessToken("", ""), false);
});
test("限流到期恢复", () => {
  const key = randomUUID();
  checkRateLimit(key, 2, 100); checkRateLimit(key, 2, 200);
  assert.throws(() => checkRateLimit(key, 2, 300), /频繁/);
  assert.doesNotThrow(() => checkRateLimit(key, 2, 60_101));
});

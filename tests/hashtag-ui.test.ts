import { test } from "node:test";
import assert from "node:assert/strict";
import { editableHashtags } from "../components/hashtag-text";
import { analyzeHashtags } from "../lib/format";

test("编辑器失焦整理序号与列表符，不把序号算作话题", () => {
  for (const text of ["1. #咖啡 2. #生活", "1.#咖啡 2.#生活", "#1. #咖啡 #2. #生活", "（1）咖啡，2. 生活", "- #咖啡 • #生活"]) {
    const formatted = editableHashtags(text);
    assert.equal(formatted, "#咖啡 #生活");
    assert.equal(analyzeHashtags(formatted).count, 2);
  }
});

test("整理可编辑文本保留重复项、无法发布的文字和数字话题", () => {
  assert.equal(editableHashtags("##咖啡 #咖啡 #生活-分享 #☕"), "#咖啡 #咖啡 #生活-分享 #☕");
  assert.equal(editableHashtags("#1 #第2名 #1.周年 #1.23"), "#1 #第2名 #1.周年 #1.23");
  assert.equal(editableHashtags(["＃咖啡", "#生活"]), "#咖啡 #生活");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isTitleWithinLimit, titleLength } from "../lib/xhs-title";
import { validateResult } from "../lib/validate-result";
import { validatePersonalResult } from "../lib/server/personal";
import { emptyPersonalInput } from "../lib/personal/schema";
import { validateVideoPlan } from "../lib/video/schema";
import { createDemoResult } from "../lib/demo";
import { videoInput, videoPlan } from "./video-fixture";

test("小红书发布标题按 Unicode 字符计数，20 字可用、21 字拒绝", () => {
  const limit = "🌅" + "晚".repeat(17) + " 好";
  assert.equal(titleLength(limit), 20);
  assert.equal(isTitleWithinLimit(limit), true);
  assert.equal(isTitleWithinLimit(limit + "！"), false);
  const id = randomUUID();
  const note = createDemoResult([id]);
  const video = videoPlan();
  const generate = (title: string) => {
    const titles = [title, ...note.titles.slice(1)];
    return [
      () => validateResult({...note,titles}, [id]),
      () => validatePersonalResult({...note,titles,imageCaptions:[]}, [], emptyPersonalInput),
      () => validateVideoPlan(videoInput(), {...video,titles}),
    ];
  };
  for (const check of generate(limit)) assert.doesNotThrow(check);
  for (const check of generate(limit + "！")) assert.throws(check, /标题.*20/u);
});

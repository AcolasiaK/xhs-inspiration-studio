import test from "node:test";
import assert from "node:assert/strict";
import { parsePersonalCustomLength } from "../lib/personal/body-length";
import { newPersonalDraft } from "../lib/personal/drafts";
import { isPersonalPromptStale } from "../lib/personal/flow";
import { personalInputSchema } from "../lib/personal/schema";

test("自定义长度只接受范围内的整数，允许先清空后重新填写", () => {
  for (const value of ["", "99", "1201", "1.5", "-100", "abc"]) assert.equal(parsePersonalCustomLength(value), null);
  assert.equal(parsePersonalCustomLength("100"), 100);
  assert.equal(parsePersonalCustomLength("800"), 800);
  assert.equal(parsePersonalCustomLength("1200"), 1200);
});

test("长度变化会使提示词过期，旧草稿缺少字段时保留兼容默认值", () => {
  const draft = newPersonalDraft();
  draft.prompt = "合成提示词";
  draft.promptInput = structuredClone(draft.input);
  assert.equal(isPersonalPromptStale(draft), false);
  assert.equal(isPersonalPromptStale({ ...draft, input: { ...draft.input, bodyLength: "long" } }), true);
  assert.equal(isPersonalPromptStale({ ...draft, input: { ...draft.input, bodyLength: "custom", customLength: 800 } }), true);
  const oldInput: Partial<typeof draft.input> = { ...draft.input };
  delete oldInput.bodyLength;
  delete oldInput.customLength;
  const restored = personalInputSchema.parse(oldInput);
  assert.equal(restored.bodyLength, "auto");
  assert.equal(restored.customLength, 500);
});

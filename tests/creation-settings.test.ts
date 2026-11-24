import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { briefSchema, emptyBrief, requestSchema } from "../lib/schema";
import { newDraft, serializeDraft, storedDraftSchema, inputSnapshot } from "../lib/drafts";
import { applyStyle, PRESET_STYLES } from "../lib/styles";
import { z } from "zod";

test("旧草稿缺少新增字段时使用清楚的日常分享默认值", () => {
  const old = serializeDraft(newDraft(), 0);
  const brief = { ...old.brief } as Partial<typeof old.brief>;
  for (const key of ["creationTypes", "primaryType", "travelFocus", "dailyFocus", "supplementTravel", "supplementEmotion", "supplementDaily", "travelSearch", "travelSearchPlace", "referenceText", "referenceAspects"] as const) delete brief[key];
  const parsed = storedDraftSchema.parse({ ...old, version: 1, brief });
  assert.deepEqual(parsed.brief.creationTypes, ["daily"]);
  assert.equal(parsed.brief.primaryType, "daily");
  assert.equal(parsed.brief.travelFocus, "experience");
  assert.equal(parsed.brief.dailyFocus, "auto");
  assert.equal(parsed.brief.travelSearch, true);
  assert.equal(parsed.brief.referenceText, "");
});

test("第 3 版草稿防止旧版读取并静默剥除新字段，旧版 1/2 仍可读取", () => {
  const draft = newDraft();
  draft.brief = {...draft.brief,topic:"旅行测试",creationTypes:["travel"],primaryType:"travel",referenceText:"合成的参考文案"};
  const current = serializeDraft(draft, 0);
  assert.equal(current.version, 3);
  // This is the exact version guard used by the previous v2 storedDraftSchema.
  const previousVersionGuard = z.object({ version: z.union([z.literal(1), z.literal(2)]) });
  assert.equal(previousVersionGuard.safeParse(current).success, false);
  assert.equal(storedDraftSchema.safeParse({...current,version:1,selectedTitleIndex:undefined,hasUserEdits:undefined}).success,true);
  assert.equal(storedDraftSchema.safeParse({...current,version:2}).success,true);
  assert.equal(storedDraftSchema.safeParse({...current,version:2,selectedTitleIndex:undefined}).success,false);
  assert.equal(storedDraftSchema.safeParse({...current,version:3,hasUserEdits:undefined}).success,false);
  assert.equal(storedDraftSchema.parse(current).brief.referenceText,"合成的参考文案");
});

test("创作类型可组合且主要类型必须选中，非法重复被拒绝", () => {
  const input = { ...emptyBrief, topic: "测试", creationTypes: ["travel", "emotion"] as const, primaryType: "travel" as const };
  assert.equal(requestSchema.safeParse({ brief: input, mode: "live", imageIds: [randomUUID()] }).success, true);
  assert.equal(requestSchema.safeParse({ brief: { ...input, primaryType: "daily" }, mode: "live", imageIds: [randomUUID()] }).success, false);
  assert.equal(briefSchema.safeParse({ ...input, creationTypes: ["travel", "travel"] }).success, false);
  assert.equal(briefSchema.safeParse({ ...input, creationTypes: [] }).success, false);
});

test("风格模板只更新偏好，不覆盖主题、类型、参考内容或补充信息", () => {
  const current = { ...emptyBrief, topic: "合成测试", creationTypes: ["travel", "emotion"] as typeof emptyBrief.creationTypes, primaryType: "travel" as const, supplementTravel: "已有路线", referenceText: "参考用文字", referenceAspects: ["rhythm"] as typeof emptyBrief.referenceAspects };
  const output = applyStyle(current, PRESET_STYLES[1].preferences);
  assert.equal(output.topic, current.topic);
  assert.deepEqual(output.creationTypes, current.creationTypes);
  assert.equal(output.primaryType, current.primaryType);
  assert.equal(output.supplementTravel, current.supplementTravel);
  assert.equal(output.referenceText, current.referenceText);
  assert.deepEqual(inputSnapshot({ brief: output, images: [], mode: "live" }).brief.referenceAspects, ["rhythm"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { newDraft, type Draft } from "../lib/drafts";
import { createDemoResult } from "../lib/demo";
import { formatNote } from "../lib/format";
import { applyResearchIfCurrent, researchFingerprint } from "../lib/research-client";
import { isSafeTravelSourceUrl, travelResearchSchema } from "../lib/travel-research";

const research = travelResearchSchema.parse({ status: "success", retrievedAt: "2026-10-30T03:00:00.000Z", notice: "请以官方公告为准。", sources: [{ title: "景区公告", url: "https://example.gov.cn/notice", source: "example.gov.cn", snippet: "合成信息" }] });
function draftWithResult(): Draft {
  const draft = newDraft(), id = randomUUID();
  const brief = { ...draft.brief, topic: "测试", creationTypes: ["travel"] as typeof draft.brief.creationTypes, primaryType: "travel" as const, travelSearchPlace: "测试地点" };
  return { ...draft, brief, generation: { result: createDemoResult([id]), mode: "live", imageIds: [id], meta: { durationMs: 1, completedAt: "2026-10-30T03:00:00.000Z" } }, generatedInput: { brief, imageIds: [id], mode: "live" } };
}

test("更新资料只修改匹配的生成快照，不改变正文或复制文本", () => {
  const draft = draftWithResult(), fingerprint = researchFingerprint(draft);
  const note = formatNote(draft.generation!.result, 0);
  const next = applyResearchIfCurrent(draft, fingerprint, research);
  assert.notEqual(next, draft); assert.deepEqual(next.generation?.research, research);
  assert.equal(formatNote(next.generation!.result, 0), note);
  assert.doesNotMatch(note, /example\.gov\.cn/);
  assert.equal(isSafeTravelSourceUrl(research.sources[0].url), true);
  assert.equal(isSafeTravelSourceUrl("https://example.gov.cn.attacker.test/"), false);
});

test("切换草稿、生成内容改变或失败时不会覆盖原资料", () => {
  const draft = draftWithResult(), fingerprint = researchFingerprint(draft);
  const switched = { ...draft, id: randomUUID() };
  assert.equal(applyResearchIfCurrent(switched, fingerprint, research), switched);
  const edited = { ...draft, generation: { ...draft.generation!, result: { ...draft.generation!.result, body: "已编辑" } } };
  assert.equal(applyResearchIfCurrent(edited, fingerprint, research), edited);
  const failed = { ...research, status: "error" as const, sources: [] };
  assert.equal(applyResearchIfCurrent(draft, fingerprint, failed), draft);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { personalTaskPhaseMessage, personalTaskTitle, type PersonalTaskFeedback } from "../lib/personal/feedback";
import { PersonalSteps, PersonalTaskFeedbackCard } from "../components/personal/task-feedback";
import { createElement } from 'react';

type Element = ReactElement<Record<string, unknown>>;
function isElement(node: unknown): node is Element { return Boolean(node && typeof node === "object" && "type" in node && "props" in node); }
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isElement(node) ? [node, ...elements(node.props.children)] : [];
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isElement(node) ? text(node.props.children) : "";
}
const task: PersonalTaskFeedback = { draftId: "synthetic-draft", stage: "prompt", status: "running", detail: "合成处理中说明" };

test("图片能力故障展示恢复控件，由恢复控件按当前验证结果提供重试", () => {
  const recovery = createElement("div", {}, "选择已验证配置或测试图片理解");
  const feedback = { ...task, stage: "note" as const, status: "error" as const, detail: "图片能力验证失败" };
  const root = PersonalTaskFeedbackCard({ feedback, recovery, onRetry: assert.fail, onView: assert.fail });
  assert.ok(text(root).includes("选择已验证配置或测试图片理解"));
  assert.doesNotMatch(text(root), /重试生成笔记/);
});

test("提示词和笔记反馈标题明确区分完成、失败、取消与处理状态", () => {
  for (const stage of ["prompt", "note"] as const) {
    const titles = ["running", "success", "error", "cancelled"].map(status => personalTaskTitle({ ...task, stage, status: status as PersonalTaskFeedback["status"] }));
    assert.equal(new Set(titles).size, 4);
    assert.match(titles[0], /正在生成/u); assert.match(titles[1], /已生成/u);
    assert.match(titles[2], /生成失败/u); assert.match(titles[3], /已取消/u);
    assert.ok(titles.every(value => value.includes(stage === "prompt" ? "提示词" : "笔记")));
  }
});

test("进度文案只描述客户端实际阶段，不假造联网完成或正文/配文细分进度", () => {
  assert.match(personalTaskPhaseMessage("prompt", "preparing", true, true), /准备.*图片/u);
  assert.doesNotMatch(personalTaskPhaseMessage("prompt", "preparing", false, true), /图片/u);
  const searchWait = personalTaskPhaseMessage("prompt", "requesting", false, true);
  assert.match(searchWait, /等待提示词与检索状态返回/u);
  assert.doesNotMatch(searchWait, /已检索|检索完成|正在搜索|正在生成正文|%/u);
  assert.doesNotMatch(personalTaskPhaseMessage("prompt", "requesting", false, false), /检索/u);
  assert.match(personalTaskPhaseMessage("note", "requesting", true, false), /等待笔记与逐图配文返回/u);
  assert.doesNotMatch(personalTaskPhaseMessage("note", "requesting", false, true), /检索|配文/u);
  for (const stage of ["prompt", "note"] as const) assert.match(personalTaskPhaseMessage(stage, "validating", false, false), /已收到回复.*检查/u);
});

test("操作区保留完整失败原因并提供显式重试，渲染不产生动作", () => {
  let retry = 0, cancel = 0, view = 0;
  const callbacks = { onRetry: () => { retry++; }, onCancel: () => { cancel++; }, onView: () => { view++; } };
  const feedback = { ...task, status: "error" as const, detail: "安全错误原因\n已有内容保留，请检查网络。" };
  const snapshot = structuredClone(feedback);
  const root = PersonalTaskFeedbackCard({ feedback, ...callbacks });
  assert.equal(root.props.role, "alert"); assert.equal(root.props["aria-atomic"], "true");
  assert.equal(root.props.id, "personal-feedback-prompt"); assert.equal(root.props.tabIndex, -1);
  assert.match(String(root.props.className), /personal-anchor/u);
  assert.ok(text(root).includes(feedback.detail));
  const buttons = elements(root).filter(item => item.type === "button");
  assert.equal(buttons.length, 1); assert.match(text(buttons[0]), /重试生成提示词/u);
  assert.deepEqual([retry, cancel, view], [0, 0, 0]);
  (buttons[0].props.onClick as () => void)(); assert.equal(retry, 1);
  assert.deepEqual(feedback, snapshot);
  assert.doesNotMatch(text(root), /关闭/u);
});

test("成功卡片提供明确查看入口，检索警告可见且不阻止继续", () => {
  let viewed = 0;
  for (const stage of ["prompt", "note"] as const) {
    const root = PersonalTaskFeedbackCard({ feedback: { ...task, stage, status: "success", detail: "已收到并检查结果。", researchWarning: "合成检索失败原因，暂无可靠资料。" }, onRetry() { assert.fail("不应重试"); }, onView() { viewed++; } });
    assert.equal(root.props.role, "status"); assert.match(text(root), /合成检索失败原因/u); assert.match(text(root), /仍可/u);
    const buttons = elements(root).filter(item => item.type === "button");
    assert.equal(buttons.length, 1); assert.equal(text(buttons[0]), stage === "prompt" ? "查看提示词" : "查看笔记");
    (buttons[0].props.onClick as () => void)();
    assert.doesNotMatch(text(root), /重试生成/u);
  }
  assert.equal(viewed, 2);
});

test("可取消操作才显示取消按钮，取消后可重试；禁用时不提供可点击动作", () => {
  let cancelled = 0;
  const callbacks = { onRetry() {}, onView() {} };
  const preparingCopy = PersonalTaskFeedbackCard({ feedback: { ...task, detail: "正在保存副本" }, ...callbacks });
  assert.equal(elements(preparingCopy).filter(item => item.type === "button").length, 0);
  const running = PersonalTaskFeedbackCard({ feedback: task, ...callbacks, onCancel() { cancelled++; } });
  const cancelButton = elements(running).find(item => item.type === "button")!;
  assert.equal(text(cancelButton), "取消本次操作"); (cancelButton.props.onClick as () => void)(); assert.equal(cancelled, 1);
  const cancelledCard = PersonalTaskFeedbackCard({ feedback: { ...task, stage: "note", status: "cancelled" }, ...callbacks, disabled: true });
  const retryButton = elements(cancelledCard).find(item => item.type === "button")!;
  assert.equal(text(retryButton), "重试生成笔记"); assert.equal(retryButton.props.disabled, true);
  assert.equal(cancelledCard.props.role, "status");
});

test("步骤导航只跳转现有区域，未有结果时禁用入口，不添加第三生成步骤", () => {
  const visited: string[] = [];
  const root = PersonalSteps({ feedback: null, hasPrompt: false, hasResult: false, onGo: target => { visited.push(target); } });
  const buttons = elements(root).filter(item => item.type === "button");
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map(button => button.props.disabled), [false, true, true]);
  assert.equal(buttons[0].props["aria-current"], "step");
  assert.doesNotMatch(text(root), /第三步|生成笔记/u);
  assert.equal(visited.length, 0); (buttons[0].props.onClick as () => void)(); assert.deepEqual(visited, ["input"]);
  const available = PersonalSteps({ feedback: null, hasPrompt: true, hasResult: true, onGo: target => { visited.push(target); } });
  const enabled = elements(available).filter(item => item.type === "button");
  assert.ok(enabled.every(item => item.props.disabled === false));
  (enabled[1].props.onClick as () => void)(); (enabled[2].props.onClick as () => void)();
  assert.deepEqual(visited, ["input", "prompt", "result"]);
});

test("顶部失败短条仅显示标题与返回入口，完整原因留在操作区；运行详情与可选取消可见", () => {
  const visited: string[] = []; let cancelled = 0;
  const error = PersonalSteps({ feedback: { ...task, stage: "note", status: "error", detail: "只应出现在完整卡片的安全详情" }, hasPrompt: true, hasResult: true, onGo: target => { visited.push(target); } });
  assert.match(text(error), /笔记生成失败/u); assert.doesNotMatch(text(error), /只应出现在完整卡片/u);
  const errorAction = elements(error).filter(item => item.type === "button").at(-1)!;
  assert.equal(text(errorAction), "查看失败原因"); (errorAction.props.onClick as () => void)(); assert.deepEqual(visited, ["prompt"]);
  const running = PersonalSteps({ feedback: task, hasPrompt: true, hasResult: false, onGo() {}, onCancel() { cancelled++; } });
  assert.match(text(running), /合成处理中说明/u);
  const cancel = elements(running).filter(item => item.type === "button").at(-1)!;
  assert.equal(text(cancel), "取消"); (cancel.props.onClick as () => void)(); assert.equal(cancelled, 1);
  const nonCancellable = PersonalSteps({ feedback: task, hasPrompt: true, hasResult: false, onGo() {} });
  assert.equal(elements(nonCancellable).filter(item => item.type === "button").length, 3);
});

test("短条失败和取消可以直接定位完整卡片，成功时仍查看内容并提示检索警告", () => {
  let feedbackViews = 0; const visited: string[] = [];
  for (const status of ["error", "cancelled"] as const) {
    const root = PersonalSteps({ feedback: { ...task, status }, hasPrompt: true, hasResult: false, onGo: target => { visited.push(target); }, onViewFeedback: () => { feedbackViews++; } });
    (elements(root).filter(item => item.type === "button").at(-1)!.props.onClick as () => void)();
  }
  assert.equal(feedbackViews, 2); assert.equal(visited.length, 0);
  const success = PersonalSteps({ feedback: { ...task, status: "success", researchWarning: "合成检索失败详情，不应在顶部全部展开。" }, hasPrompt: true, hasResult: false, onGo: target => { visited.push(target); }, onViewFeedback: () => { feedbackViews++; } });
  assert.match(text(success), /检索有提示/u); assert.doesNotMatch(text(success), /不应在顶部全部展开/u);
  assert.ok(elements(success).some(item => String(item.props.className).includes("personal-step-feedback-warning")));
  (elements(success).filter(item => item.type === "button").at(-1)!.props.onClick as () => void)();
  assert.deepEqual(visited, ["prompt"]); assert.equal(feedbackViews, 2);
});

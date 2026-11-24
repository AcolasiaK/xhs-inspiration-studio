"use client";

import * as React from "react";
import { personalTaskTitle, type PersonalTaskFeedback } from "@/lib/personal/feedback";

type FeedbackCardProps = {
  feedback: PersonalTaskFeedback;
  onCancel?: () => void;
  onRetry: () => void;
  onView: () => void;
  disabled?: boolean;
  recovery?: React.ReactNode;
};

/** Persistent, inline operation feedback. The parent owns task state and all actions. */
export function PersonalTaskFeedbackCard({ feedback, onCancel, onRetry, onView, disabled = false, recovery }: FeedbackCardProps) {
  const canRetry = feedback.status === "error" || feedback.status === "cancelled";
  const viewLabel = feedback.stage === "prompt" ? "查看提示词" : "查看笔记";
  return <section
    id={`personal-feedback-${feedback.stage}`}
    tabIndex={-1}
    className={`personal-task-card personal-task-${feedback.status} personal-anchor`}
    role={feedback.status === "error" ? "alert" : "status"}
    aria-atomic="true"
  >
    <div className="personal-task-heading"><span className="personal-task-mark" aria-hidden="true" /><h3>{personalTaskTitle(feedback)}</h3></div>
    {feedback.detail && <p className="personal-task-detail">{feedback.detail}</p>}
    {feedback.status === "success" && feedback.researchWarning && <p className="personal-task-research-warning">
      <strong>参考资料提醒：</strong>{feedback.researchWarning}
      <span>{feedback.stage === "prompt" ? "仍可查看、修改提示词并继续生成笔记；未核实的信息请谨慎使用。" : "仍可编辑和复制当前笔记；未核实的信息请谨慎使用。"}</span>
    </p>}
    {canRetry && recovery}
    {((canRetry && !recovery) || feedback.status === "success" || (feedback.status === "running" && onCancel)) && <div className="personal-task-actions">
      {feedback.status === "running" && onCancel && <button type="button" className="personal-feedback-button" disabled={disabled} onClick={onCancel}>取消本次操作</button>}
      {canRetry && <button type="button" className="personal-feedback-button personal-feedback-primary" disabled={disabled} onClick={onRetry}>{feedback.stage === "prompt" ? "重试生成提示词" : "重试生成笔记"}</button>}
      {feedback.status === "success" && <button type="button" className="personal-feedback-button personal-feedback-primary" disabled={disabled} onClick={onView}>{viewLabel}</button>}
    </div>}
  </section>;
}

type StepsProps = {
  feedback: PersonalTaskFeedback | null;
  hasPrompt: boolean;
  hasResult: boolean;
  onGo: (target: "input" | "prompt" | "result") => void;
  onCancel?: () => void;
  onViewFeedback?: () => void;
  disabled?: boolean;
};

/** Two creation steps plus a result-view shortcut; this does not submit or scroll on its own. */
export function PersonalSteps({ feedback, hasPrompt, hasResult, onGo, onCancel, onViewFeedback, disabled = false }: StepsProps) {
  const active = feedback
    ? feedback.status === "success" ? feedback.stage === "prompt" ? "prompt" : "result" : feedback.stage === "prompt" ? "input" : "prompt"
    : hasResult ? "result" : hasPrompt ? "prompt" : "input";
  const target = feedback?.status === "success" ? feedback.stage === "prompt" ? "prompt" : "result" : feedback?.stage === "prompt" ? "input" : "prompt";
  const viewLabel = feedback?.status === "success" ? feedback.stage === "prompt" ? "查看提示词" : "查看笔记" : feedback?.status === "error" ? "查看失败原因" : "返回操作区";
  const researchWarning = feedback?.status === "success" && Boolean(feedback.researchWarning?.trim());
  return <div className="personal-steps">
    <nav className="personal-step-nav" aria-label="个人创作步骤与结果">
      <button type="button" className={active === "input" ? "is-active" : ""} aria-current={active === "input" ? "step" : undefined} disabled={disabled} onClick={() => onGo("input")}><span className="personal-step-number" aria-hidden="true">1</span>填写经历</button>
      <button type="button" className={active === "prompt" ? "is-active" : ""} aria-current={active === "prompt" ? "step" : undefined} disabled={disabled || !hasPrompt} onClick={() => onGo("prompt")}><span className="personal-step-number" aria-hidden="true">2</span>确认提示词</button>
      <button type="button" className={active === "result" ? "is-active" : ""} aria-current={active === "result" ? "step" : undefined} disabled={disabled || !hasResult} onClick={() => onGo("result")}>查看笔记</button>
    </nav>
    {feedback && <div className={`personal-step-feedback personal-step-feedback-${feedback.status}${researchWarning ? " personal-step-feedback-warning" : ""}`} role={feedback.status === "error" ? "alert" : "status"} aria-atomic="true">
      <div className="personal-step-feedback-text"><strong>{personalTaskTitle(feedback)}</strong>{researchWarning && <span className="personal-step-research-warning">检索有提示</span>}{feedback.status === "running" && feedback.detail && <p>{feedback.detail}</p>}</div>
      {feedback.status === "running" ? onCancel && <button type="button" className="personal-feedback-button" disabled={disabled} onClick={onCancel}>取消</button> : <button type="button" className="personal-feedback-button" disabled={disabled} onClick={feedback.status === "success" ? () => onGo(target) : onViewFeedback ?? (() => onGo(target))}>{viewLabel}</button>}
    </div>}
  </div>;
}

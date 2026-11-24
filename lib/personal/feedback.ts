export type PersonalTaskStage = "prompt" | "note";

export type PersonalTaskFeedback = {
  draftId: string;
  stage: PersonalTaskStage;
  status: "running" | "success" | "error" | "cancelled";
  detail: string;
  needsImageTest?: boolean;
  researchWarning?: string;
};

export function personalTaskTitle(feedback: PersonalTaskFeedback): string {
  const noun = feedback.stage === "prompt" ? "创作提示词" : "笔记";
  switch (feedback.status) {
    case "running": return `正在生成${noun}`;
    case "success": return `${noun}已生成`;
    case "error": return `${noun}生成失败`;
    case "cancelled": return `已取消生成${noun}`;
  }
}

/** Only these client-observed phases are shown; a request does not expose server-side substeps. */
export function personalTaskPhaseMessage(
  stage: PersonalTaskStage,
  phase: "preparing" | "requesting" | "validating",
  hasImages: boolean,
  search: boolean,
): string {
  if (phase === "preparing") return hasImages ? "正在准备创作信息和图片，请稍候。" : "正在准备本次创作信息，请稍候。";
  if (phase === "requesting") {
    if (stage === "prompt") return search
      ? "本次包含背景检索，正在等待提示词与检索状态返回。"
      : "正在等待 AI 返回创作提示词，请稍候。";
    return hasImages ? "正在等待笔记与逐图配文返回，请稍候。" : "正在等待标题、正文和话题返回，请稍候。";
  }
  if (stage === "prompt") return search ? "已收到回复，正在检查提示词和检索状态。" : "已收到回复，正在检查创作提示词。";
  return hasImages ? "已收到回复，正在检查笔记内容和图片对应关系。" : "已收到回复，正在检查标题、正文和 10 个话题。";
}

import { XHS_TITLE_RULE } from "../xhs-title";
import { chinaTravelGuidance } from "../china-travel-reference";
import { emptyBrief } from "../schema";
import type { PersonalInput } from "./schema";
import { truthfulWriting as truthful, creativeWriting as creative, compositionWriting, reviewWriting, personalExpansionInstruction } from "./style-defaults";
import { effectiveStyleRules, isThinkingGuide, rulesForInput, type StyleRuleScope } from "./style-rules";

const guideBodyNoteRule = "正文只写作者想讲的感受和读者用得上的攻略。只为回应假想质疑的自我辩解、预先免责、重复的保留话和编辑说明，集中放到生成末尾的内部说明。说明不计正文目标字数，不展示或复制。正文保留有表达作用的真实犹豫，以及影响行程的条件和取舍。";
const plainBodyRule = "正文使用能直接粘贴到小红书的纯文本。用自然换行或中文小标题分段，不用 Markdown 星号、加粗、列表标记、标题标记、代码标记和链接语法。";

const truthfulEventState = '保持用户明确提供的事件状态和素材来源：已确认亲历中已经发生的动作和感受仍按已发生写，用户的计划保持计划，假设保持假设。不能把用户已确认的亲历改成“我想／我打算”的愿望，也不能把计划或假设写成已经发生。标注为合成验收、虚构示例或参考作者经历的材料，不得改称用户亲历。不得补充素材未提供的具体时间，例如把“休息日”写成“下午”；时间未说明就保持不说明。';

/** Authoritative choices are separate from the model-written prompt, which may be old. */
export function personalBodyTarget(input: PersonalInput) {
  const ranges = { auto: [350, 550], short: [150, 250], medium: [350, 550], long: [650, 850] } as const;
  const [min, max] = input.bodyLength === "custom"
    ? [Math.round(input.customLength * 0.85), Math.round(input.customLength * 1.15)]
    : ranges[input.bodyLength];
  const target = input.bodyLength === "custom" ? input.customLength : (min + max) / 2;
  const instruction = input.bodyLength === "auto"
    ? `自动篇幅：优先遵循用户确认提示词或补充要求中明确填写的长度；没有明确字数时，正文约 ${min}～${max} 字，以 ${target} 字为写作目标。不要把“短段落”“自然”“不啰嗦”理解成整篇必须短。`
    : `本次用户明确选择正文约 ${min}～${max} 字，以约 ${target} 字为目标${input.bodyLength === "custom" ? `（自定义约 ${target} 字）` : ""}。当前长度选项优先于旧的或自动生成的提示词中的不同篇幅；确认提示词的其他主题、风格和要求仍需完整遵循。`;
  return { mode: input.bodyLength, min, max, target, instruction };
}

export function personalWritingGuidance(input: PersonalInput, scope: StyleRuleScope = "body") {
  const rules = rulesForInput(input);
  const length = personalBodyTarget(input);
  const bodyScope = scope==="prompt" || scope==="note" || scope==="body";
  const paragraphHint = length.target <= 250 ? "约 2～4 个有内容的自然段" : length.target <= 550 ? "约 4～6 个有内容的自然段" : "约 6～9 个有内容的自然段";
  const travelGuidance = chinaTravelGuidance({ ...emptyBrief, topic: input.topic, details: input.experience, creationTypes: rules.baseStyle === "china" ? ["china"] : ["daily"], primaryType: rules.baseStyle === "china" ? "china" : "daily" });
  return {
    truthMode: input.truth,
    authenticity: input.truth === "truthful" ? `${truthful}\n${truthfulEventState}` : creative,
    composition: compositionWriting,
    expansion: personalExpansionInstruction(rules.baseStyle === 'custom' ? '所选风格适合的自然段、短句与留白节奏' : paragraphHint),
    styleGuidance: [effectiveStyleRules(rules,scope), ...travelGuidance].join("\n"),
    length,
    review: [reviewWriting, bodyScope ? plainBodyRule : "", bodyScope && isThinkingGuide(rules) ? guideBodyNoteRule : ""].filter(Boolean).join("\n"),
  };
}

/** Visible/editable in step two; never silently appended after the user confirms. */
export function personalPromptContract(input: PersonalInput) {
  const writing = personalWritingGuidance(input);
  const guideRule = isThinkingGuide(rulesForInput(input)) ? `\n${guideBodyNoteRule}` : "";
  return `【本次正文设置】\n${writing.length.instruction}\n${writing.authenticity}\n输入简短不限制正文长度；围绕核心想法充分展开，避免重复和空话。\n${plainBodyRule}${guideRule}\n${XHS_TITLE_RULE}`;
}

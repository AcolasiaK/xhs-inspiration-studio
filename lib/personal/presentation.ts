import type { PersonalInput } from "./schema";
import type { PersonalDraft } from './drafts';
import { samePersonalStyleBasis } from './flow';

const styleNames: Record<string, string> = { china: '环游中国', travel: '旅行攻略', emotion: '情绪表达', daily: '日常分享' };
export function personalStyleLabel(input: PersonalInput) {
  if (input.ruleSnapshot) return `${input.ruleSnapshot.content.name} · v${input.ruleSnapshot.version}`;
  return input.styles.map(id => styleNames[id] || '历史自定义风格').join('、') + (input.styles.length === 1 && styleNames[input.styles[0]] ? ' · 内置 v1' : '（历史依据）');
}

export function personalStyleChanges(draft: PersonalDraft) {
  const current = personalStyleLabel(draft.input);
  return {
    direction: draft.promptInput && !samePersonalStyleBasis(draft.input, draft.promptInput)
      ? `当前已选择${current}；这份创作方向仍使用${personalStyleLabel(draft.promptInput)}。请更新创作方向并确认后再生成。` : null,
    result: draft.generatedInput && !samePersonalStyleBasis(draft.input, draft.generatedInput.input)
      ? `当前已选择${current}；这篇笔记使用${personalStyleLabel(draft.generatedInput.input)}，内容与原生成依据保留。采用新风格需先更新并确认创作方向。` : null,
  };
}

export type PersonalStep = "input" | "prompt" | "result";
export const initialPersonalStep: PersonalStep = "input";

/** Navigation is independent of drafts, completion and autosave. Only success advances. */
export function personalStepAfterSuccess(completed: "prompt" | "note"): PersonalStep {
  return completed === "prompt" ? "prompt" : "result";
}

export function personalLengthLabel(input: PersonalInput) {
  return { auto: "自动篇幅", short: "约 150～250 字", medium: "约 350～550 字", long: "约 650～850 字", custom: `自定义约 ${input.customLength} 字` }[input.bodyLength];
}

function promptSections(prompt: string) {
  const headings = [...prompt.matchAll(/^(?:【([^\n】]+)】|#{1,4}\s+([^\n]+))\s*$/gm)];
  return [...(headings[0]?.index ? [{name:"",text:prompt.slice(0,headings[0].index).trim()}] : !headings.length ? [{name:"",text:prompt}] : []), ...headings.map((match, i) => ({
    name: (match[1] || match[2]).trim(),
    text: prompt.slice(match.index! + match[0].length, headings[i + 1]?.index ?? prompt.length).trim(),
  }))];
}

/** Structural checks only: word lists cannot prove whether prose is a useful plan. */
export function isPersonalWritingPlan(plan: string, intent?: string | null) {
  const compact = (value: string) => value.normalize("NFKC").replace(/[\s\p{P}]/gu, "");
  const withoutFraming = (value: string) => compact(value).replace(/^(?:(?:这篇|本文|本次)(?:笔记|文章)?(?:想要|需要|想|要)?(?:表达|记录|呈现|突出|体现|传达|传递)|(?:表达|记录|呈现|突出|体现|传达|传递|围绕))+/u, "");
  if (!plan.trim() || (intent && withoutFraming(plan) === withoutFraming(intent))) return false;
  if (/输出格式|(?:标题|正文|标签|话题).{0,8}(?:格式|字数)|(?:真实润色|创意发挥)[：:]|\d+\s*个(?:标题|标签|话题)/u.test(plan)) return false;
  // Reject direct intention reuse, but accept legitimate wording beyond a fixed
  // set of writing verbs. The generation instructions govern semantic quality.
  return true;
}

/** Extract exact text, never infer a new direction or substitute a form's old values. */
export function personalPromptSummary(prompt: string) {
  const sections = promptSections(prompt);
  const one = (names: string[]) => { const found = sections.filter(s => names.includes(s.name)); return found.length === 1 && found[0].text ? found[0].text : null; };
  // An intention says *what* to express; only an explicit writing plan can say
  // *how* this prompt will arrange the material. Legacy prompts stay unchanged.
  const plan = one(["写作安排", "创作方向", "写作计划"]);
  const intent = one(["核心感受或观点", "核心表达", "这篇想表达什么"]);
  const core = plan && isPersonalWritingPlan(plan, intent) ? plan : null;
  const writing = one(["语气与写法", "写作要求", "写作风格", "表达方式"]);
  const contract = one(["本次正文设置"]);
  const lines = contract?.split(/\n/).map(s => s.trim()).filter(Boolean) ?? [];
  const lengthLine = lines.find(s => /^(自动篇幅：|本次用户明确选择正文约)/u.test(s));
  const length = one(["正文长度", "篇幅要求"]) ?? (lengthLine ? lengthLine.split("。")[0] + "。" : null);
  const boundary = one(["内容边界", "真实性与图片", "真实性要求"]) ?? lines.find(s => /^(真实润色：|创意发挥：)/u.test(s)) ?? null;
  return { core, writing, length, boundary, fallback: !core, complete: Boolean(core && writing && length && boundary) };
}

/** Display-only excerpts. Never written back to the prompt or sent as model input. */
export function personalDirectionPreview(prompt: string, input: PersonalInput) {
  const summary = personalPromptSummary(prompt);
  // Keep the full explicit plan available when expanded, including its second
  // sentence. The short preview must never replace persisted or executed text.
  const plan = summary.core?.trim() ?? "";
  const core = /输出格式|(?:标题|正文|标签).{0,8}(?:格式|字数)|(?:真实润色|创意发挥)[：:]|\d+\s*个(?:标题|标签)/u.test(plan) ? "" : plan;
  const chars = Array.from(core);
  const preview = chars.length > 70 ? chars.slice(0,70).join("")+"…" : core;
  const writing = summary.writing?.split(/[，,。；;\n]/u).map(s=>s.trim()).find(Boolean);
  const writingLabel = writing ? Array.from(writing).slice(0,14).join("")+(Array.from(writing).length>14?"…":"") : "写法见提示词";
  const instructions = promptSections(prompt).filter(s=>!/参考|素材|经历|来源|联网资料/u.test(s.name)).map(s=>`${s.name}\n${s.text}`).join("\n");
  const modes = [...instructions.matchAll(/(?:^|\n)\s*(?:(?:内容创作方式|真实性(?:选择|模式)?|创作模式|模式)\s*[：:]\s*|(?:请)?(?:采用|选择|使用|按|以)\s*)?(真实润色|创意发挥)(?:模式)?\s*(?=[：:。；，\n]|$)/gmu)].map(m=>m[1]);
  const truthLabel = input.truth === "truthful" ? "真实润色" : "创意发挥";
  const truthConflict = modes.some(mode=>mode!==truthLabel);
  const ranges = {short:[150,250],medium:[350,550],long:[650,850],custom:[Math.round(input.customLength*.85),Math.round(input.customLength*1.15)]};
  const requestedRange = summary.length?.match(/(\d{2,4})\s*[～~–—-]\s*(\d{2,4})\s*字/u);
  const requestedPoint = summary.length?.match(/(\d{2,4})\s*字/u);
  const range = input.bodyLength === "auto" ? null : ranges[input.bodyLength];
  const lengthConflict = Boolean(range && summary.length && !summary.length.startsWith("自动篇幅") && (requestedRange
    ? +requestedRange[1]!==range[0] || +requestedRange[2]!==range[1]
    : requestedPoint && (+requestedPoint[1]<range[0] || +requestedPoint[1]>range[1])));
  const conflicts = [truthConflict?"真实性":"",lengthConflict?"篇幅":""].filter(Boolean);
  return {core,preview,writingLabel,lengthLabel:personalLengthLabel(input),truthLabel,
    conflict: conflicts.length ? `提示词的${conflicts.join("、")}与当前设置不同；本次以以上设置为准，可展开修改。` : null};
}

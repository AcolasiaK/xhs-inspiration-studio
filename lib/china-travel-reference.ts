import type { Brief } from "./schema";

/** 根据本稿主题给出写作提示，所需事实由创作者提供。 */
export function chinaTravelGuidance(brief: Brief): string[] {
  if (!brief.creationTypes?.includes("china")) return [];

  const subject = [brief.topic, brief.details, brief.supplementTravel].filter(Boolean).join(" ");
  const guidance: string[] = [];
  if (/路线|行程|沿途|自驾|环游|交通/u.test(subject)) {
    guidance.push("路线写作：按创作者给出的顺序串联停留点，用本稿提供的地点、交通方式和观察组织段落。");
  }
  if (/费用|花费|消费|预算|账单|价格/u.test(subject)) {
    guidance.push("费用写作：区分预算和实际支出，只使用本稿明确给出的金额、币种与计费单位。");
  }
  return guidance;
}

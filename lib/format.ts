import type { ContentResult } from "./schema";

export const REQUIRED_HASHTAG_COUNT = 10;

/** 把模型和用户输入解释成统一话题；不凭空增加标签，也不截断超过 10 个的内容。 */
export function analyzeHashtags(input: string | string[]) {
  const source = (Array.isArray(input) ? input.join(" ") : input).normalize("NFKC")
    // 列表符或序号不是话题，例如“1. #咖啡”或“- #咖啡”。
    .replace(/(^|[\s,;])#?(?:\d{1,3}|[一二三四五六七八九十]{1,3})[.、),，](?=\s|#|$)/gu, "$1")
    .replace(/(^|[\s,;])(?:\d{1,3}|[一二三四五六七八九十]{1,3})[.、),，](?=\p{L})/gu, "$1")
    .replace(/(^|[\s,;])[-*•·](?=\s*(?:#|\p{L}))/gu, "$1")
    .replace(/["'“”‘’「」『』《》【】\[\]{}()]+(?=#)/gu, "");
  const parts = source.split(/[\s#,，、;；]+/u);
  const tags: string[] = [], seen = new Set<string>();
  let invalidCount = 0, duplicateCount = 0;
  for (const part of parts) {
    // 表情或其他特殊符号不得被悄悄剪掉；编辑器应保留原输入并提示修正。
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(part)) { invalidCount++; continue; }
    const term = part.replace(/^["'“”‘’「」『』《》【】\[\]{}()]+|["'“”‘’「」『』《》【】\[\]{}()]+$/gu, "");
    // 非空的纯表情或符号可能是用户正在编辑的内容；不能在整理时悄悄丢弃。
    // 空白、单独的 #、逗号等分隔符在 split 后为空字符串，仍可安全忽略。
    if (!term) { if (part) invalidCount++; continue; }
    if (!/^[\p{L}\p{M}\p{N}_]+$/u.test(term) || Array.from(term).length > 60) { invalidCount++; continue; }
    const key = term.toLocaleLowerCase("und");
    if (seen.has(key)) { duplicateCount++; continue; }
    seen.add(key); tags.push(`#${term}`);
  }
  return { tags, count: tags.length, valid: tags.length === REQUIRED_HASHTAG_COUNT && invalidCount === 0, invalidCount, duplicateCount };
}
// 兼容旧调用方：返回不含 # 的词；新界面使用 analyzeHashtags 的规范标签。
export function normalizeHashtags(input: string | string[]): string[] {
  return analyzeHashtags(input).tags.map((tag) => tag.slice(1));
}
export function formatHashtags(input: string | string[]): string {
  return analyzeHashtags(input).tags.join(" ");
}
/** 发布笔记只包含选中标题、正文和规范话题；不包含封面或逐图草稿。 */
export function formatNote(result: ContentResult, selectedIndex: number): string {
  return [result.titles[selectedIndex] ?? "", result.body, formatHashtags(result.hashtags)].join("\n\n");
}
/** 模型偶尔遗漏换行；只在既有句末加入空行，不增删或改写事实。 */
export function formatGeneratedParagraphs(body: string): string {
  if (body.includes("\n")) return body;
  const boundaries = [...body.matchAll(/[。！？!?]+[”’」』]?/gu)]
    .map((match) => (match.index ?? 0) + match[0].length)
    .filter((index) => body.slice(index).trim().length > 0);
  if (!boundaries.length) return body;
  const midpoint = body.length / 2;
  const boundary = boundaries.reduce((best, index) => Math.abs(index - midpoint) < Math.abs(best - midpoint) ? index : best);
  return `${body.slice(0, boundary).trimEnd()}\n\n${body.slice(boundary).trimStart()}`;
}
export function formatAll(result: ContentResult): string {
  return [
    "【标题候选】", ...result.titles.map((title, i) => `${i + 1}. ${title}`),
    "", "【封面文案】", result.coverCopy.headline, result.coverCopy.subline,
    "", "【正文】", result.body,
    "", "【话题】", formatHashtags(result.hashtags),
    "", "【逐图配文】", ...result.imageCaptions.map((caption, i) => `图片 ${i + 1}\n${caption.headline}\n${caption.description}`),
  ].join("\n");
}
export function splitTerms(value: string): string[] {
  return value.split(/[,，、;；\n]+/u).map((term) => term.trim()).filter(Boolean);
}
export function textFilename(name: string): string {
  let safe = Array.from(name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, "_").trim().replace(/^[. ]+|[. ]+$/gu, "")).slice(0, 80).join("");
  if (!safe) safe = "未命名草稿";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(safe)) safe = `草稿_${safe}`;
  return `${safe}.txt`;
}

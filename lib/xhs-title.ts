/** Count Unicode code points, the same unit used for the original travel title limit. */
export const XHS_TITLE_LIMIT = 20;
export const XHS_TITLE_RULE = `每个小红书发布标题不超过 ${XHS_TITLE_LIMIT} 字符，标点和空格计入长度。`;

export function titleLength(value: string): number {
  return Array.from(value).length;
}

export function isTitleWithinLimit(value: string): boolean {
  return titleLength(value) <= XHS_TITLE_LIMIT;
}

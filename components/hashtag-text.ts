/**
 * 把可编辑文本的分隔符和前缀排整齐，不删除重复话题或带非法字符的条目。
 * 列表符和独立序号是标记，不是话题；只在它们后面有分隔符时移除。
 */
export function editableHashtags(value: string | string[]): string {
  const source = (Array.isArray(value) ? value.join(" ") : value).normalize("NFKC")
    // 兼容旧版本可能留下的“#1. #话题”，但不删掉 #1 或 #1.周年 等真实内容。
    .replace(/(^|[\s,;])#?\(\d{1,3}\)(?=[\p{L}\p{N}])/gu, "$1")
    .replace(/(^|[\s,;])#?(?:\(?\d{1,3}[.、)]|[-*•·–—])(?=\s|#|$)/gu, "$1");
  return source.split(/[\s#＃,，、;；]+/u).filter(Boolean).map((item) => `#${item}`).join(" ");
}

import { analyzeHashtags, formatAll, formatHashtags } from "../format";
import type { ContentResult } from "../schema";

/** Strip common model-emitted Markdown in the body while retaining its words and line breaks. */
export function plainPersonalBody(body: string) {
  return body.replace(/\r\n?/gu, "\n")
    .replace(/^[ \t]*(?:```+|~~~+)[^\n]*(?:\n|$)/gmu, "")
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gmu, "$1")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/^[ \t]*(?:\*[ \t]*){3,}$|^[ \t]*(?:-{3,}|_{3,})[ \t]*$/gmu, "")
    .replace(/^[ \t]*[-+*][ \t]+/gmu, "")
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/giu, "$1")
    .replace(/(`+)([^`\n]+)\1/gu, "$2")
    .replace(/(?<![\w_])(__?)([^_\n]+)\1(?![\w_])/gu, "$2")
    .replace(/~~([^~\n]+)~~/gu, "$1")
    .replace(/(?<=\d)[ \t]*[*＊][ \t]*(?=\d)/gu, "乘以")
    .replace(/\\?[*＊]/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Personal creation has no selected title. Historical selection metadata is ignored. */
export function formatPersonalBodyAndTags(result: Pick<ContentResult, "body" | "hashtags">) {
  return [plainPersonalBody(result.body), formatHashtags(result.hashtags)].join("\n\n");
}

export function formatPersonalAll(result: ContentResult) {
  return formatAll({...result,body:plainPersonalBody(result.body)});
}

/** Normalize only one completed field, without dropping incomplete text or moving siblings. */
export function finishPersonalTag(value: string) {
  const parsed = analyzeHashtags(value);
  return parsed.count === 1 && parsed.invalidCount === 0 && parsed.duplicateCount === 0 ? parsed.tags[0] : value;
}

export function personalTagsCanRewriteOne(value: string[]) {
  const parsed = analyzeHashtags(value);
  return parsed.valid && parsed.duplicateCount === 0 && value.length === 10
    && value.every(tag => { const one = analyzeHashtags(tag); return one.count === 1 && !one.invalidCount && !one.duplicateCount; });
}

/** Older editors stored a whole #tag line in one array item. Split its display only. */
export function personalTagEntries(value: string[]) {
  const entries = value.flatMap(tag => tag.split(/\s+(?=#)|(?<=[^#])(?=#)/u));
  // Do not exceed the existing draft schema or silently discard any old text.
  return entries.length <= 12 ? entries : value;
}

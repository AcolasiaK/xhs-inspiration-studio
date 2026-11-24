import { z } from "zod";
import { MAX_IMAGES } from "../constants";
import { analyzeHashtags } from "../format";
import { resultSchema, type ContentResult } from "../schema";
import { validatePartial, type PartialChoice, type PartialResult } from "../partial-client";
import type { PersonalInput } from "./schema";
import { validPersonalCaptions } from "./captions";
import type { PersonalDraft } from "./drafts";
import { builtinRuleSnapshot, isBuiltinStyle } from './style-rules';

export function samePersonalStyleBasis(a:PersonalInput,b:PersonalInput){
  if(a.styles.length!==1||b.styles.length!==1||a.styles[0]!==b.styles[0])return false;
  const version=(v:PersonalInput)=>v.ruleSnapshot?.versionId||(isBuiltinStyle(v.styles[0])?builtinRuleSnapshot(v.styles[0]).versionId:'');
  return Boolean(version(a)&&version(a)===version(b));
}

const clientResultSchema=resultSchema.extend({imageCaptions:z.array(resultSchema.shape.imageCaptions.element.extend({headline:z.string().max(100)})).max(MAX_IMAGES)});
export function personalInputKey(d:PersonalDraft){return JSON.stringify({input:d.input,imageIds:d.images.map(i=>i.id)});}
export function isPersonalPromptStale(d:PersonalDraft){return Boolean(d.promptInput&&(JSON.stringify(d.promptInput)!==JSON.stringify(d.input)||JSON.stringify(d.promptImageIds)!==JSON.stringify(d.images.map(i=>i.id))));}
export function personalResultFingerprint(d: PersonalDraft) { return JSON.stringify({id:d.id,result:d.generation?.result,generatedInput:d.generatedInput,imageIds:d.resultImages.map(i=>i.id),currentInput:d.input,currentImageIds:d.images.map(i=>i.id),currentPrompt:d.prompt}); }
export function validatePersonalClientResult(value:unknown,ids:string[],input?:Pick<PersonalInput,"styles"|"ruleSnapshot">):ContentResult {
  const parsed=clientResultSchema.safeParse(value);if(!parsed.success)throw new Error("生成结果不完整，原内容仍保留。");
  const result=parsed.data,returned=result.imageCaptions.map(x=>x.imageId);
  if(JSON.stringify(returned)!==JSON.stringify(ids)||new Set(returned).size!==ids.length)throw new Error("图片和配文没有正确对应，原内容仍保留。");
  if(!validPersonalCaptions(result.imageCaptions,ids,input))throw new Error("图片配文不完整，原内容仍保留。");
  const tags=analyzeHashtags(result.hashtags);if(!tags.valid||tags.duplicateCount)throw new Error("话题不完整或重复，原内容仍保留。");
  return {...result,hashtags:tags.tags};
}

/** Paragraph-only rules apply to all personal captions, never shared photo rewrites. */
export function validatePersonalPartial(result: PartialResult, choice: PartialChoice, current: ContentResult, ids: string[], input: PersonalInput): boolean {
  if (choice.target !== "caption_one" && choice.target !== "captions_all") return validatePartial(result,choice,current,ids);
  const expected = choice.target === "caption_one" ? [choice.targetImageId ?? ""] : ids;
  if (!result || !Array.isArray(result.titles) || result.titles.length || !Array.isArray(result.hashtags) || result.hashtags.length || !validPersonalCaptions(result.imageCaptions,expected,input)) return false;
  return result.imageCaptions.every((caption,index) => {
    const old = current.imageCaptions.find(c => c.imageId === caption.imageId);
    return caption.imageId === expected[index] && Boolean(old && (!old.headline.trim()||caption.description.trim().split(/\r?\n/)[0]!==old.headline.trim()) && (old.headline !== caption.headline || old.description.trim() !== caption.description.trim()));
  });
}

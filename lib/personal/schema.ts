import { z } from "zod";
import { REFERENCE_ASPECTS, modelResultSchema } from "../schema";
import { styleIdSchema, ruleSnapshotSchema } from './style-rules';
import { MAX_IMAGES } from "../constants";
import { rewriteDirectionSchema } from "../rewrite-schema";
import { travelResearchSchema } from "../travel-research";
import { personalHotspotReferenceSchema } from "./hotspot-reference";

export const personalInputSchema = z.object({
  topic: z.string().max(100), experience: z.string().max(4000), requirements: z.string().max(2000),
  coreIntent: z.string().max(600).default(""),
  hotspotReference: personalHotspotReferenceSchema.nullable().default(null),
  // Storage remains tolerant of legacy multi-style records; new requests below do not.
  styles: z.array(styleIdSchema).max(4).refine(items => new Set(items).size === items.length),
  ruleSnapshot: ruleSnapshotSchema.optional(),
  customStyle: z.string().max(1000), truth: z.enum(["truthful", "creative"]),
  referenceText: z.string().max(6000), referenceAspects: z.array(z.enum(REFERENCE_ASPECTS)).max(5),
  search: z.boolean(), searchPlace: z.string().max(100),
  bodyLength: z.enum(["auto", "short", "medium", "long", "custom"]).default("auto"),
  customLength: z.number().int().min(100).max(1200).default(500),
});
export type PersonalInput = z.infer<typeof personalInputSchema>;
export const emptyPersonalInput: PersonalInput = {topic:"",experience:"",requirements:"",coreIntent:"",hotspotReference:null,styles:["daily"],customStyle:"",truth:"truthful",referenceText:"",referenceAspects:[],search:false,searchPlace:"",bodyLength:"auto",customLength:500};
export const personalRewriteSchema = z.object({
  target:z.enum(["body","title_one","titles_all","caption_one","captions_all","tag_one","tags_all"]),
  targetIndex:z.number().int().nonnegative().optional(), targetImageId:z.string().uuid().optional(),
  direction:rewriteDirectionSchema, instruction:z.string().max(500), current:modelResultSchema,
});
export const personalRequestSchema = z.object({
  action:z.enum(["prompt","generate","rewrite"]), input:personalInputSchema,
  imageIds:z.array(z.string().uuid()).max(MAX_IMAGES).refine(ids=>new Set(ids).size===ids.length),
  confirmedPrompt:z.string().max(12000).optional(), research:travelResearchSchema.optional(),
  rewrite:personalRewriteSchema.optional(),
}).superRefine((value,ctx)=>{
  if(value.input.styles.length!==1)ctx.addIssue({code:'custom',message:'请明确选择一种写作风格，并确认新的创作依据。'});
  if(value.input.ruleSnapshot&&value.input.ruleSnapshot.styleId!==value.input.styles[0])ctx.addIssue({code:'custom',message:'写作风格与规则版本不一致，请重新生成并确认提示词。'});
  if (!value.input.experience.trim()) ctx.addIssue({code:"custom",message:"请填写经历、想法或感受。"});
  if(value.action!=="prompt" && !value.confirmedPrompt?.trim())ctx.addIssue({code:"custom",message:"请先确认创作提示词。"});
  if(value.action==="rewrite"&&!value.rewrite)ctx.addIssue({code:"custom",message:"请填写重写要求。"});
  if(value.action==="rewrite" && value.rewrite && JSON.stringify(value.rewrite.current.imageCaptions.map(item=>item.imageId))!==JSON.stringify(value.imageIds))ctx.addIssue({code:"custom",message:"图片配文与生成时的图片快照不一致。"});
});
export type PersonalRequest = z.infer<typeof personalRequestSchema>;

import { z } from "zod";
import { emptyFootage, emptyVideoBrief, footageSchema, phaseSchema, videoBriefSchema, videoPlanSchema, videoSnapshotSchema, type VideoSnapshot, type VideoPlan, type Shot } from "./schema";
import { hotspotBrief, type HotspotTransfer } from "../hotspot-transfer";
export const videoGenerationSchema = z.object({ result: videoPlanSchema, input: videoSnapshotSchema, edited: z.boolean(), mode: z.literal("live"), meta: z.object({ durationMs:z.number(),completedAt:z.string() }) });
export const videoDraftSchema = z.object({ version:z.literal(1), id:z.string().uuid(), revision:z.number().int().nonnegative(), name:z.string().max(80), createdAt:z.string(),updatedAt:z.string(),phase:phaseSchema, brief:videoBriefSchema,footage:footageSchema,before:videoGenerationSchema.nullable(),after:videoGenerationSchema.nullable() });
export type VideoDraft = z.infer<typeof videoDraftSchema>;
export const videoSummarySchema=z.object({id:z.string().uuid(),name:z.string().max(80),updatedAt:z.union([z.string().datetime({offset:true}),z.literal("")]),before:z.boolean(),after:z.boolean(),damaged:z.boolean().optional()});
export type VideoDraftSummary=z.infer<typeof videoSummarySchema>;
export function summarizeVideoDraft(draft:VideoDraft):VideoDraftSummary{return {id:draft.id,name:draft.name,updatedAt:draft.updatedAt,before:Boolean(draft.before),after:Boolean(draft.after)};}
export type VideoGeneration = z.infer<typeof videoGenerationSchema>;
export function newVideoDraft(): VideoDraft { const now=new Date().toISOString();return { version:1,id:crypto.randomUUID(),revision:0,name:"未命名视频草稿",createdAt:now,updatedAt:now,phase:"before",brief:{...emptyVideoBrief},footage:{...emptyFootage},before:null,after:null }; }
export function cloneVideoDraft(draft:VideoDraft):VideoDraft {const copy=structuredClone(videoDraftSchema.parse(draft));return {...copy,id:crypto.randomUUID(),revision:0,name:`${copy.name.slice(0,75)} 副本`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
export function videoFromHotspot(transfer:HotspotTransfer):VideoDraft {const next=newVideoDraft(),brief=hotspotBrief(transfer);next.name=brief.topic.slice(0,80);next.brief.topic=brief.topic;next.brief.details=brief.details;return next;}
export const VIDEO_TRANSFER_KEY="xhs-hotspot-video-v1";
export function snapshotVideo(draft:VideoDraft):VideoSnapshot {return structuredClone({phase:draft.phase,brief:draft.brief,footage:draft.footage,shootingReference:draft.phase==="after"?draft.before?.result??null:null});}
export function videoFingerprint(draft:VideoDraft) { return JSON.stringify([draft.id,draft.phase,draft.brief,draft.footage,draft.before,draft.after]); }
export function applyVideoPlan(draft:VideoDraft, fingerprint:string, result:VideoPlan,input:VideoSnapshot,meta:VideoGeneration["meta"]):VideoDraft { if(videoFingerprint(draft)!==fingerprint)return draft;return {...draft,[input.phase]:{result,input,meta,mode:"live",edited:false}}; }
export function applyVideoShot(draft:VideoDraft, fingerprint:string, shot:Shot):VideoDraft {if(videoFingerprint(draft)!==fingerprint)return draft;const generation=draft[draft.phase];if(!generation||!generation.result.shots.some(s=>s.shotId===shot.shotId))return draft;return {...draft,[draft.phase]:{...generation,edited:true,result:{...generation.result,shots:generation.result.shots.map(s=>s.shotId===shot.shotId?shot:s)}}};}

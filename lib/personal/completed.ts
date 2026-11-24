import { isTitleWithinLimit, XHS_TITLE_RULE } from "../xhs-title";
import { z } from 'zod';
import { analyzeHashtags } from '../format';
import { newPersonalDraft, personalStoredSchema, serializePersonalDraft, copyPersonalDraft, type PersonalDraft, type PersonalStored } from './drafts';

export const completedNoteSchema=z.object({version:z.literal(1),id:z.string().uuid(),sourceDraftId:z.string().uuid(),savedAt:z.string().datetime(),snapshot:personalStoredSchema,nextDraft:personalStoredSchema}).superRefine((n,c)=>{
 const s=n.snapshot,b=s.generatedInput,r=s.generation?.result,next=n.nextDraft;
 if(!r||!b||s.id!==n.id||n.id===next.id||s.prompt!==b.confirmedPrompt||JSON.stringify(s.input)!==JSON.stringify(b.input)||JSON.stringify(s.imageIds)!==JSON.stringify(s.resultImageIds))c.addIssue({code:'custom',message:'完成笔记的结果与生成依据不一致。'});
 if(!r?.body.trim()||r.titles.some(t=>!t.trim())||!analyzeHashtags(r.hashtags).valid||analyzeHashtags(r.hashtags).duplicateCount)c.addIssue({code:'custom',message:'请保留 5 个标题、正文及 10 个有效且不重复的话题后保存。'});
 if(next.generation||next.generatedInput||next.assets.length||next.imageIds.length||next.resultImageIds.length||next.prompt||next.promptInput||next.promptResearch||next.promptImageIds.length||next.input.topic||next.input.experience||next.input.coreIntent||next.input.requirements||next.input.referenceText||next.input.referenceAspects.length||next.input.hotspotReference||next.input.search||next.input.searchPlace)c.addIssue({code:'custom',message:'下一篇应为空白草稿。'});
});
export type CompletedNote=z.infer<typeof completedNoteSchema>;
export const completedSummarySchema=z.object({id:z.string().uuid(),name:z.string().max(80),savedAt:z.string().datetime(),excerpt:z.string().max(180),searchText:z.string(),imageCount:z.number().int().min(0).max(9),thumbnailId:z.string().uuid().nullable()});
export type CompletedSummary=z.infer<typeof completedSummarySchema>&{thumbnail?:Blob};
export function completionSignature(n:Pick<CompletedNote,'sourceDraftId'|'snapshot'>){
 const s=n.snapshot;
 return JSON.stringify([n.sourceDraftId,s.name,s.input,s.prompt,s.generation,s.generatedInput,s.resultImageIds,s.assets.map(({blob,...a})=>({...a,type:blob.type}))]);
}
async function stableId(value:string){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
export function nextPersonalDraft(d:PersonalDraft){
 const n=newPersonalDraft();n.input.styles=d.input.styles.length===1?[...d.input.styles]:['daily'];n.input.customStyle=d.input.customStyle;n.input.truth=d.input.truth;n.input.bodyLength=d.input.bodyLength;
 if(d.input.bodyLength==='custom'&&Number.isInteger(d.input.customLength)&&d.input.customLength>=100&&d.input.customLength<=1200)n.input.customLength=d.input.customLength;
 return n;
}
export async function prepareCompletedNote(d:PersonalDraft):Promise<CompletedNote>{
 if(!d.generation||!d.generatedInput)throw new Error('请先生成笔记，再保存到已完成笔记。');
 if(!d.generation.result.titles.every(isTitleWithinLimit))throw new Error(`${XHS_TITLE_RULE}请缩短后再保存。`);
 const basis=d.generatedInput,now=new Date().toISOString(),name=d.name.trim()||d.generation.result.body.replace(/\s+/gu,' ').trim().slice(0,28)||`笔记 ${now.slice(0,10)}`;
 const clean:PersonalDraft={...d,name,input:structuredClone(basis.input),images:d.resultImages,prompt:basis.confirmedPrompt,promptInput:structuredClone(basis.input),promptImageIds:[...basis.imageIds],promptResearch:structuredClone(basis.research),selectedTitleIndex:0};
 const snapshot=serializePersonalDraft(clean,0),id=await stableId(completionSignature({sourceDraftId:d.id,snapshot}));snapshot.id=id;
 const next=nextPersonalDraft(d);next.id=await stableId(`next:${id}`);
 const parsed=completedNoteSchema.safeParse({version:1,id,sourceDraftId:d.id,savedAt:now,snapshot,nextDraft:serializePersonalDraft(next,0)});
 if(!parsed.success)throw new Error(parsed.error.issues[0]?.message||'笔记不完整，当前内容仍保留。');return parsed.data;
}
export function completedSummary(n:CompletedNote):CompletedSummary{
 const s=n.snapshot,r=s.generation!.result;
 return {id:n.id,name:s.name,savedAt:n.savedAt,excerpt:r.body.replace(/\s+/gu,' ').slice(0,180),searchText:[s.name,...r.titles,r.body,...r.hashtags,...Object.values(r.coverCopy),...r.imageCaptions.flatMap(c=>[c.headline,c.description])].join('\n').toLocaleLowerCase(),imageCount:s.resultImageIds.length,thumbnailId:s.resultImageIds[0]??null,thumbnail:s.assets.find(a=>a.id===s.resultImageIds[0])?.blob};
}
export function continueCompletedNote(n:CompletedNote){const d=copyPersonalDraft(n.snapshot);d.name=`${n.snapshot.name.slice(0,68)}（继续创作）`;return d;}
export type CompletionStore={saveCompleted:(n:CompletedNote)=>Promise<CompletedNote>;ensureDraft:(draft:PersonalStored)=>Promise<PersonalStored>};
/** Archive commits first; retries reuse an immutable record and deterministic next draft ID. */
export async function completeAndStart(store:CompletionStore,n:CompletedNote,onArchived:(n:CompletedNote)=>void){const saved=await store.saveCompleted(n);onArchived(saved);return store.ensureDraft(saved.nextDraft);}

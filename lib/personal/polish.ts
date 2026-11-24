import type { ContentResult } from '../schema';
import { latestPersonalRewriteBasis, type PersonalDraft } from './drafts';
import { polishInputSchema, polishRequestSchema, type PolishField, type PolishRequest, type PolishResponse, type PolishScope, type PolishUndo } from './polish-schema';
import { polishHasChanges, validatePolishOutput } from './polish-validation';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function polishFields(result:ContentResult,scope:PolishScope):PolishField[]{
 const captions=result.imageCaptions.map(c=>({key:`caption:${c.imageId}`,text:c.description}));
 if(scope==='body')return [{key:'body',text:result.body}];
 if(scope==='captions')return captions;
 return [...result.titles.map((text,i)=>({key:`title:${i}`,text})),{key:'body',text:result.body},{key:'cover:headline',text:result.coverCopy.headline},{key:'cover:subline',text:result.coverCopy.subline},...captions];
}
export function canPolish(draft:PersonalDraft,scope:PolishScope='all'){return Boolean(draft.generation&&draft.generatedInput&&polishFields(draft.generation.result,scope).some(f=>f.text.trim()));}
export function buildPolishRequest(draft:PersonalDraft,scope:PolishScope):PolishRequest{
 if(!draft.generation||!draft.generatedInput)throw new Error('请先生成笔记，再润色文案。');
 const fields=polishFields(draft.generation.result,scope),base=draft.generatedInput,bases:PolishRequest['bases']=[];
 if(!same(draft.generation.result.imageCaptions.map(c=>c.imageId),base.imageIds)||!same(base.imageIds,draft.resultImages.map(i=>i.id)))throw new Error('当前图片与笔记依据不一致，原文保留。');
 for(const field of fields){
  const choice=field.key.startsWith('title:')?{target:'title_one',targetIndex:Number(field.key.slice(6))}:field.key.startsWith('caption:')?{target:'caption_one',targetImageId:field.key.slice(8)}:{target:field.key};
  const prior=latestPersonalRewriteBasis(base.rewrites||[],choice),basis=prior||base;
  const context={input:polishInputSchema.strip().parse(basis.input),confirmedPrompt:basis.confirmedPrompt};
  const existing=bases.find(b=>same(b.input,context.input)&&b.confirmedPrompt===context.confirmedPrompt);
  if(existing)existing.keys.push(field.key);else bases.push({...context,keys:[field.key]});
 }
 const parsed=polishRequestSchema.safeParse({scope,fields,bases});
 if(!parsed.success)throw new Error(parsed.error.issues.find(i=>i.code==='custom')?.message||'润色依据不完整，请先确认此结果的风格与方向。');
 return parsed.data;
}
function identity(draft:PersonalDraft){return JSON.stringify({id:draft.id,meta:draft.generation?.meta,imageIds:draft.generation?.imageIds,assets:draft.resultImages.map(i=>({id:i.id,name:i.file.name,size:i.file.size,at:i.file.lastModified,width:i.width,height:i.height})),input:draft.generatedInput?.input,prompt:draft.generatedInput?.confirmedPrompt});}
function basisKey(draft:PersonalDraft,request:PolishRequest){return JSON.stringify({bases:request.bases,headlines:request.scope==='body'?[]:draft.generation?.result.imageCaptions.map(c=>[c.imageId,c.headline])});}
export type PolishTicket={draftId:string;identity:string;basisKey:string;request:PolishRequest};
export function capturePolish(draft:PersonalDraft,scope:PolishScope):PolishTicket{const request=buildPolishRequest(draft,scope);return {draftId:draft.id,identity:identity(draft),basisKey:basisKey(draft,request),request:structuredClone(request)};}
export function mergePolishFields(result:ContentResult,fields:PolishField[]):ContentResult{
 const values=new Map(fields.map(f=>[f.key,f.text]));
 return {...result,titles:result.titles.map((v,i)=>values.get(`title:${i}`)??v),body:values.get('body')??result.body,coverCopy:{headline:values.get('cover:headline')??result.coverCopy.headline,subline:values.get('cover:subline')??result.coverCopy.subline},imageCaptions:result.imageCaptions.map(c=>({...c,description:values.get(`caption:${c.imageId}`)??c.description}))};
}
export function applyPolish(draft:PersonalDraft,ticket:PolishTicket,response:PolishResponse):PersonalDraft{
 const request=buildPolishRequest(draft,ticket.request.scope);
 if(draft.id!==ticket.draftId||identity(draft)!==ticket.identity||basisKey(draft,request)!==ticket.basisKey||!same(request.fields,ticket.request.fields))throw new Error('草稿、目标内容或生成依据已改变，请重新润色；没有覆盖最新编辑。');
 const after=validatePolishOutput(ticket.request,response);
 if(!polishHasChanges(ticket.request.fields,after))return draft;
 const polishUndo:PolishUndo={scope:request.scope,before:structuredClone(ticket.request.fields),after:structuredClone(after),identity:ticket.identity,basisKey:ticket.basisKey,at:new Date().toISOString(),model:response.model,humanizer:response.humanizer};
 return {...draft,generation:{...draft.generation!,result:mergePolishFields(draft.generation!.result,after)},hasUserEdits:true,polishUndo};
}
export function undoPolish(draft:PersonalDraft):PersonalDraft{
 const undo=draft.polishUndo;if(!undo)throw new Error('没有可撤回的润色。');
 const request=buildPolishRequest(draft,undo.scope);
 if(identity(draft)!==undo.identity||basisKey(draft,request)!==undo.basisKey||!same(request.fields,undo.after))throw new Error('润色范围内的内容或依据已修改，撤回会覆盖新编辑，因此未执行；其他内容保留。');
 return {...draft,generation:{...draft.generation!,result:mergePolishFields(draft.generation!.result,undo.before)},polishUndo:undefined,hasUserEdits:true};
}
export function polishCopyText(fields:PolishField[]){return fields.map(f=>f.text).filter(Boolean).join('\n\n');}

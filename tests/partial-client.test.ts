import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createDemoResult } from '../lib/demo';
import { inputSnapshot,newDraft,serializeDraft,formatDraftExport } from '../lib/drafts';
import { localStore } from '../lib/local-store';
import { analyzeHashtags,formatNote } from '../lib/format';
import { applyPartialIfCurrent,partialFingerprint,submitPartial,validatePartial,type PartialChoice,type PartialResult } from '../lib/partial-client';
import type { StudioImage } from '../lib/types';

function setup(){
  const draft=newDraft(); const images=[1,2].map((_,i):StudioImage=>({id:crypto.randomUUID(),file:new File(['image'],`${i}.jpg`,{type:'image/jpeg'}),preview:`blob:${i}`,width:10,height:10}));
  draft.images=images;draft.resultImages=images;draft.brief.topic='合成素材';draft.mode='live';draft.generatedInput=inputSnapshot(draft);
  draft.generation={mode:'live',imageIds:images.map(x=>x.id),result:createDemoResult(images.map(x=>x.id)),meta:{durationMs:1,completedAt:new Date().toISOString()}};
  const current=draft.generation.result;
  const output=(choice:PartialChoice):PartialResult=>({titles:choice.target==='title_one'?['新标题甲','新标题乙','新标题丙']:choice.target==='titles_all'?['新标题一','新标题二','新标题三','新标题四','新标题五']:[], imageCaptions:choice.target==='caption_one'?[{imageId:choice.targetImageId!,headline:'新短标题',description:'新说明\n第二行'}]:choice.target==='captions_all'?images.map((x,i)=>({imageId:x.id,headline:`新标题${i}`,description:`新说明${i}\n第二行`})):[],hashtags:choice.target==='tag_one'?['#新话题甲','#新话题乙','#新话题丙']:choice.target==='tags_all'?Array.from({length:10},(_,i)=>`#新话题${i}`):[]});
  return {draft,images,current,output};
}
const choices=(ids:string[]):PartialChoice[]=>[{target:'title_one',targetIndex:1},{target:'titles_all'},{target:'caption_one',targetImageId:ids[1]},{target:'captions_all'},{target:'tag_one',targetIndex:1},{target:'tags_all'}];

test('六类局部重写均携带所选配置且失败不回退',async()=>{
 const {draft,images,current}=setup();
 for(const choice of choices(images.map(x=>x.id))){let count=0;
  await assert.rejects(submitPartial({brief:draft.generatedInput!.brief,current,images,choice,direction:'natural',instruction:'',aiSource:'test-profile',controller:new AbortController(),onProgress:()=>{},compress:async()=>images.map(()=>new Blob(['x'])),request:async(_url,init)=>{count++;assert.equal(new Headers(init?.headers).get('X-AI-Profile'),'test-profile');return Response.json({error:{message:'测试失败'}},{status:502});}}),/测试失败/);
  assert.equal(count,1);
 }
});

test('六种预览、确认只更改指定区域，图片按 ID 对应',()=>{
 const {draft,images,current,output}=setup(); const before=structuredClone(current);
 for(const choice of choices(images.map(x=>x.id))){
  const result=output(choice);assert.equal(validatePartial(result,choice,current,images.map(x=>x.id)),true);
  assert.deepEqual(draft.generation!.result,before);
  const after=applyPartialIfCurrent(draft,partialFingerprint(draft),choice,result,0);assert.notEqual(after,draft);
  const changed=after.generation!.result;
  if(choice.target==='title_one'){assert.equal(changed.titles[1],'新标题甲');assert.deepEqual(changed.titles.filter((_,i)=>i!==1),before.titles.filter((_,i)=>i!==1));}
  if(choice.target==='titles_all')assert.equal(changed.titles.length,5);
  if(choice.target==='caption_one'){assert.deepEqual(changed.imageCaptions[0],before.imageCaptions[0]);assert.equal(changed.imageCaptions[1].imageId,images[1].id);assert.equal(changed.imageCaptions[1].headline,'新短标题');}
  if(choice.target==='captions_all')assert.deepEqual(changed.imageCaptions.map(x=>x.imageId),images.map(x=>x.id));
  if(choice.target==='tag_one'){assert.equal(changed.hashtags[1],'#新话题甲');assert.equal(analyzeHashtags(changed.hashtags).count,10);}
  if(choice.target==='tags_all')assert.equal(analyzeHashtags(changed.hashtags).count,10);
  for(const field of ['body','coverCopy','warnings'] as const)assert.deepEqual(changed[field],before[field]);
 }
});

test('不合格结果、重复候选、图片错位、标签不足或重复不能应用',()=>{
 const {draft,images,current,output}=setup();
 const one={target:'tag_one',targetIndex:0} as const;const tags=output(one); tags.hashtags[0]=analyzeHashtags(current.hashtags).tags[1];assert.equal(validatePartial(tags,one,current,images.map(x=>x.id)),false);
 const all={target:'tags_all'} as const;const short=output(all);short.hashtags.pop();assert.equal(validatePartial(short,all,current,images.map(x=>x.id)),false);
 const captions={target:'captions_all'} as const;const wrong=output(captions);wrong.imageCaptions.reverse();assert.equal(validatePartial(wrong,captions,current,images.map(x=>x.id)),false);
 const title={target:'title_one',targetIndex:0} as const;const duplicate=output(title);duplicate.titles[0]=current.titles[1];assert.equal(applyPartialIfCurrent(draft,partialFingerprint(draft),title,duplicate,0),draft);
});

test('重写必须返回新内容：拒绝原标签、整组同标签、旧标题及未变化配文',()=>{
 const {draft,images,current,output}=setup();const ids=images.map(x=>x.id);
 const tagOne={target:'tag_one',targetIndex:0} as const;
 const sameTag=output(tagOne);sameTag.hashtags[0]=analyzeHashtags(current.hashtags).tags[0];
 assert.equal(validatePartial(sameTag,tagOne,current,ids),false);
 const allTags={target:'tags_all'} as const;const sameTags=output(allTags);
 sameTags.hashtags=[...analyzeHashtags(current.hashtags).tags].reverse().map(x=>x.toLocaleUpperCase());
 assert.equal(validatePartial(sameTags,allTags,current,ids),false);
 assert.equal(applyPartialIfCurrent(draft,partialFingerprint(draft),allTags,sameTags,0),draft);
 const allTitles={target:'titles_all'} as const;const sameTitle=output(allTitles);
 sameTitle.titles[0]=current.titles[0];assert.equal(validatePartial(sameTitle,allTitles,current,ids),false);
 const oneTitle={target:'title_one',targetIndex:0} as const;const sameSelectedTitle=output(oneTitle);
 sameSelectedTitle.titles[0]=current.titles[0];assert.equal(validatePartial(sameSelectedTitle,oneTitle,current,ids),false);
 const oneCaption={target:'caption_one',targetImageId:ids[0]} as const;const sameCaption=output(oneCaption);
 sameCaption.imageCaptions[0]={...current.imageCaptions[0]};assert.equal(validatePartial(sameCaption,oneCaption,current,ids),false);
 const allCaptions={target:'captions_all'} as const;const partlySame=output(allCaptions);
 partlySame.imageCaptions[1]={...current.imageCaptions[1]};assert.equal(validatePartial(partlySame,allCaptions,current,ids),false);
});

test('服务返回整组原标签时提示不合格且保留原值',async()=>{
 const {draft,images,current,output}=setup();const choice={target:'tags_all'} as const;const result=output(choice);
 result.hashtags=[...analyzeHashtags(current.hashtags).tags].reverse();
 const before=structuredClone(current);
 await assert.rejects(submitPartial({brief:draft.generatedInput!.brief,current,images,choice,direction:'natural',instruction:'',accessToken:'test',controller:new AbortController(),onProgress:()=>{},compress:async()=>images.map(()=>new Blob(['x'])),request:async()=>Response.json({result,meta:{durationMs:1,completedAt:new Date().toISOString()}})}),/不合格.*原内容仍保留/);
 assert.deepEqual(draft.generation!.result,before);
});

test('草稿切换、输入图片排序、表单或相关编辑变化后拒绝过期结果',()=>{
 const {draft,images,output}=setup();const fp=partialFingerprint(draft);const choice={target:'caption_one',targetImageId:images[0].id} as const;const result=output(choice);
 for(const changed of [{...draft,id:crypto.randomUUID()},{...draft,images:[...draft.images].reverse()},{...draft,brief:{...draft.brief,topic:'新要求'}},{...draft,generation:{...draft.generation!,result:{...draft.generation!.result,body:'新编辑'}}}]) assert.equal(applyPartialIfCurrent(changed,fp,choice,result,0),changed);
});

test('模拟请求传输快照，502、超时、取消不修改旧内容',async()=>{
 for(const kind of ['success','502','timeout','cancel'] as const){
  const {draft,current,images,output}=setup();const choice={target:'title_one',targetIndex:0} as const;let calls=0;const controller=new AbortController(); const before=structuredClone(current);
  const work=submitPartial({brief:draft.generatedInput!.brief,current,images,choice,direction:'natural',instruction:'',accessToken:'test',controller,onProgress:()=>{},compress:async()=>images.map(()=>new Blob(['x'])),timeoutMs:15,request:async(_url,init)=>{calls++;const p=JSON.parse(String((init!.body as FormData).get('payload')));assert.deepEqual(p.imageIds,images.map(x=>x.id));assert.equal(p.current.body,current.body);if(kind==='success')return Response.json({result:output(choice),meta:{durationMs:1,completedAt:new Date().toISOString()}});if(kind==='502')return Response.json({error:{message:'HTTP 502 原内容保留'}},{status:502});return new Promise<Response>((_,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});if(kind==='cancel')queueMicrotask(()=>controller.abort());});}});
  if(kind==='success')await work;else await assert.rejects(work,kind==='502'?/502/:kind==='timeout'?/超时/:/取消/);
  assert.equal(calls,1);assert.deepEqual(draft.generation!.result,before);
 }
});

test('确认话题后持久化与复制导出均使用最新内容',async()=>{
 globalThis.indexedDB=new IDBFactory(); const {draft,output}=setup();const choice={target:'tags_all'} as const;
 const updated=applyPartialIfCurrent(draft,partialFingerprint(draft),choice,output(choice),0);
 await localStore.writeDraft(serializeDraft(updated,0),null);const saved=await localStore.getDraft(draft.id);
 assert.deepEqual(saved.generation!.result.hashtags,updated.generation!.result.hashtags);
 const line=output(choice).hashtags.join(' ');assert.ok(formatNote(saved.generation!.result,0).includes(line));
 assert.ok(formatDraftExport(updated).includes(line));
});

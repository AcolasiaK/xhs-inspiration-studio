import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { emptyPersonalInput, personalRequestSchema, type PersonalInput } from '../lib/personal/schema';
import { emotionalCaptionInstructions, validPersonalCaptions, personalCaptionText, hasUnverifiedBookQuote } from '../lib/personal/captions';
import { validatePersonalClientResult, validatePersonalPartial, personalResultFingerprint } from '../lib/personal/flow';
import { runPersonal, validatePersonalResult } from '../lib/server/personal';
import { newPersonalDraft, serializePersonalDraft } from '../lib/personal/drafts';
import { personalLocalStore } from '../lib/personal/store';
import { prepareCompletedNote, continueCompletedNote } from '../lib/personal/completed';
import { formatAll } from '../lib/format';

const ids=[randomUUID(),randomUUID()];
const input:PersonalInput={...emptyPersonalInput,experience:'在公园看树影，慢慢走了一会。',coreIntent:'给自己一个慢下来的片刻',styles:['emotion']};
const captions=ids.map((imageId,i)=>({imageId,headline:'',description:i?'长椅留在树下，我也不用急着赶路。让今天留一点空白，心情似乎就有地方坐下。':'树影把普通的路分成明暗。慢慢走的时候，连这样的细节也能让我觉得，这一刻没有白过。'}));
const note={titles:['标题一','标题二','标题三','标题四','标题五'],body:'保持原有正文。\n\n原有情绪与篇幅不变。',coverCopy:{headline:'封面',subline:'副标题'},imageCaptions:captions,hashtags:Array.from({length:10},(_,i)=>`#测试话题${i}`),warnings:[]};
function response(value:unknown){return Response.json({id:'test',object:'response',created_at:1,model:'test',status:'completed',error:null,incomplete_details:null,output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}]});}
function env(){const old={...process.env};process.env.APP_MODE='local';process.env.APP_LOCAL_ONLY='1';process.env.OPENAI_API_KEY='synthetic';process.env.OPENAI_MODEL='synthetic';delete process.env.OPENAI_BASE_URL;return()=>{process.env=old;};}

test('新情绪配文允许完整单段、禁止小标题；其他风格保留两行但不再有小标题；引用无法核验时拒绝',()=>{
 assert.ok(validPersonalCaptions(captions,ids,input));assert.equal(emotionalCaptionInstructions({...input,styles:['travel']}),'');
 assert.equal(validPersonalCaptions(captions,ids,{styles:['travel']}),false);
 assert.ok(validPersonalCaptions(ids.map(imageId=>({imageId,headline:'',description:'第一行\n第二行'})),ids,{styles:['travel']}));
 for(const broken of [[...captions,{...captions[0]}],[captions[0],captions[0]],captions.map(c=>({...c,headline:'不应生成的小标题'})),captions.map(c=>({...c,description:' '})),captions.map(c=>({...c,imageId:randomUUID()}))])assert.equal(validPersonalCaptions(broken,ids,input),false);
 const quote='“伪造的测试引文。”——测试作者《不存在的书》';assert.ok(hasUnverifiedBookQuote(quote));assert.throws(()=>validatePersonalResult({...note,imageCaptions:[{...captions[0],description:quote},captions[1]]},ids,input),/未经核实/);
 assert.equal(personalCaptionText(captions[0]),captions[0].description);
 assert.equal(personalCaptionText({...captions[0],headline:'用户旧的小标题'}),`用户旧的小标题\n${captions[0].description}`);
});

test('不同素材和两种真实性沿用已确认方向，正文请求仍独立，图片ID匹配并按输入排序',async()=>{
 const restore=env(),requests:Array<{text:{format:{name:string;schema:unknown}};input:Array<{role:string;content:unknown}>}>=[];
 const net=mock.method(globalThis,'fetch',async(_u:RequestInfo|URL,init?:RequestInit)=>{const sent=JSON.parse(String(init?.body));requests.push(sent);return response(sent.text.format.name==='personal_note'?{...note,imageCaptions:[]}:{imageCaptions:[...captions].reverse()});});
 try{
  for(const [experience,truth] of [['街边装扮很有趣，让我觉得轻松自由。','truthful'],['看海很安静，想写一点自己的联想。','creative'],['树影落在路上，我慢慢走了一会。','truthful']] as const){
   const chosen={...input,experience,truth},confirmedPrompt=`用户编辑确认：围绕${experience}展开观察与感受，不改正文。`;
   const result=await runPersonal(personalRequestSchema.parse({action:'generate',input:chosen,imageIds:ids,confirmedPrompt}),ids.map(id=>({id,dataUrl:'data:image/png;base64,c3ludGhldGlj'})),new AbortController().signal);
   assert.ok('result' in result);assert.equal(result.result.body,note.body);assert.deepEqual(result.result.imageCaptions,captions);assert.deepEqual(validatePersonalClientResult(result.result,ids,chosen),result.result);
   const [body,photo]=requests.slice(-2),bodySystem=String(body.input[0].content),photoSystem=String(photo.input[0].content);
   assert.doesNotMatch(bodySystem,/情绪逐图配文|本次全部采用原创配文/);assert.doesNotMatch(JSON.stringify(body),/input_image/);assert.match(JSON.stringify(photo),/input_image/);
   for(const s of [body,photo])assert.ok(JSON.stringify(s).includes(confirmedPrompt));
   assert.match(JSON.stringify(photo),/逐张选择不同/);assert.match(photoSystem,/没有核实书摘/);assert.match(photoSystem,truth==='truthful'?/不补造具体人物/:/想象、假设或拟写情节/);
   assert.match(JSON.stringify(photo.text.format.schema),/"const":""/);
  }
  assert.equal(requests.length,6);
 }finally{net.mock.restore();restore();}
});

test('规划提示词包含照片专属规则；无图和其他方向不附加此规则',async()=>{
 const restore=env();const requests:string[]=[];
 const net=mock.method(globalThis,'fetch',async(_u:RequestInfo|URL,init?:RequestInit)=>{requests.push(String(init?.body));return response({prompt:'保留原有的正文写法，写出完整感受。',coreIntent:'放慢脚步',writingPlan:'从树影落在路面的细节切入，写散步时注意到的明暗变化，让放慢脚步的感受自然贯穿，不罗列行程。'});});
 try{for(const [chosen,imageIds] of [[input,ids],[input,[]],[{...input,styles:['travel']},ids]] as [PersonalInput,string[]][]){const result=await runPersonal(personalRequestSchema.parse({action:'prompt',input:chosen,imageIds}),imageIds.map(id=>({id,dataUrl:'data:image/png;base64,c3ludGhldGlj'})),new AbortController().signal);assert.ok(result.prompt);assert.equal(result.prompt.includes('情绪逐图配文'),chosen.styles.includes('emotion')&&imageIds.length>0);}assert.equal(requests.length,3);}finally{net.mock.restore();restore();}
});

test('单图和整组重写只生成目标，使用生成依据，不接受错误ID、小标题或正文混入',async()=>{
 const restore=env();let out:unknown,sent='',calls=0;const net=mock.method(globalThis,'fetch',async(_u:RequestInfo|URL,init?:RequestInit)=>{calls++;sent=String(init?.body);return response(out);});
 const current={...note,imageCaptions:captions.map(c=>({...c,headline:'旧稿标题',description:'用户已编辑的旧配文\n仍然保留'}))},before=structuredClone(current);
 const generated={...input,truth:'creative' as const},confirmedPrompt='用户最终确认：写出轻松好笑的瞬间，不刻意煽情。';
 try{
  for(const target of ['caption_one','captions_all'] as const){const expected=target==='caption_one'?[captions[1]]:captions,choice={target,targetImageId:ids[1]},payload=personalRequestSchema.parse({action:'rewrite',input:generated,imageIds:ids,confirmedPrompt,rewrite:{...choice,direction:'natural',instruction:'保留轻松感',current}});out={body:'',titles:[],hashtags:[],imageCaptions:expected};
   const result=await runPersonal(payload,ids.map(id=>({id,dataUrl:'data:image/png;base64,c3ludGhldGlj'})),new AbortController().signal);assert.ok(result.rewrite);assert.ok(validatePersonalPartial(result.rewrite,choice,current,ids,generated));assert.match(sent,/用户最终确认/);assert.match(sent,/旧稿标题/);assert.match(sent,/不覆盖用户关键事实/);assert.deepEqual(current,before);
   for(const broken of [{...out as object,imageCaptions:[{...captions[0],imageId:randomUUID()}]},{...out as object,body:'偷偷改正文'},{...out as object,imageCaptions:expected.map(c=>({...c,headline:'错误小标题'}))}]){out=broken;await assert.rejects(runPersonal(payload,ids.map(id=>({id,dataUrl:'data:image/png;base64,c3ludGhldGlj'})),new AbortController().signal));assert.deepEqual(current,before);}
  }
  assert.equal(calls,8);assert.equal(validatePersonalPartial({titles:[],hashtags:[],imageCaptions:captions},{target:'captions_all'},note,ids,input),false);
 }finally{net.mock.restore();restore();}
});

test('旧小标题与新段落混合保存、完成归档、继续创作及复制均不丢字，输入图片变化不改变结果图片',async()=>{
 const previous=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();
 try{const legacy={...input,styles:['emotion','daily']};const draft=newPersonalDraft();draft.input=structuredClone(legacy);draft.name='合成情绪配文验收';draft.prompt='已确认的方向';draft.resultImages=ids.map((id,i)=>({id,file:new File(['synthetic-blob'],`image-${i}.png`,{type:'image/png'}),preview:`blob:temporary-${i}`,width:20,height:20}));draft.images=[...draft.resultImages];draft.generatedInput={input:structuredClone(legacy),confirmedPrompt:draft.prompt,research:null,imageIds:ids};const result={...note,imageCaptions:[{...captions[0],headline:'旧稿手动编辑的标题'},captions[1]]};draft.generation={mode:'live',result,meta:{completedAt:new Date().toISOString(),durationMs:1},imageIds:ids};
 const fingerprint=personalResultFingerprint(draft);draft.images.reverse();draft.images.pop();draft.input.styles=['travel'];assert.notEqual(personalResultFingerprint(draft),fingerprint);await personalLocalStore.writeDraft(serializePersonalDraft(draft,0),null);
 const read=await personalLocalStore.getDraft(draft.id);assert.deepEqual(read.generation!.result,result);assert.deepEqual(read.resultImageIds,ids);assert.deepEqual(read.imageIds,[ids[1]]);
 const complete=await prepareCompletedNote(draft);await personalLocalStore.saveCompleted(complete);const reopened=await personalLocalStore.getCompleted(complete.id),copy=continueCompletedNote(reopened);assert.deepEqual(copy.generation!.result,result);assert.deepEqual(copy.imageIds,ids);assert.deepEqual(copy.generatedInput!.input.styles,['emotion','daily']);assert.notEqual(copy.id,draft.id);
 for(const asset of reopened.snapshot.assets)assert.equal(await asset.blob.text(),'synthetic-blob');const all=formatAll(copy.generation!.result);assert.ok(all.includes(`旧稿手动编辑的标题\n${captions[0].description}`));assert.ok(all.includes(captions[1].description));assert.ok(!JSON.stringify(read).includes('blob:temporary'));
 copy.generation!.result.imageCaptions[0].description='副本的新编辑';assert.deepEqual((await personalLocalStore.getCompleted(complete.id)).snapshot.generation!.result,result);
 }finally{globalThis.indexedDB=previous;}
});

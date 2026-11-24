import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { isCloudMode } from '@/lib/cloud/mode';
import { getRepository } from '@/lib/cloud/server/repository';
import { BUILTIN_PERSONAL_STYLES, builtinRuleSnapshot, isBuiltinStyle, ruleContentSchema, ruleSnapshotSchema, styleRecordSchema, type RuleContent, type RuleSnapshot, type StyleRecord, type StyleVersion } from '@/lib/personal/style-rules';
import { organizeWritingSkill } from '@/lib/personal/style-import';
import type { PersonalRequest } from '@/lib/personal/schema';

const trialSchema=z.object({id:z.string().uuid(),styleId:z.string(),versionId:z.string(),kind:z.enum(['body','title','captions']),at:z.string().datetime(),model:z.string().max(160),snapshot:ruleSnapshotSchema,material:z.string().max(4000),output:z.string().max(16000)});
export type StyleTrial=z.infer<typeof trialSchema>;
const learningAdoptionSchema=z.object({adoptionId:z.string().uuid(),jobId:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/),styleId:z.string(),versionId:z.string()}).strict();
const stateSchema=z.object({learningAdoptions:z.array(learningAdoptionSchema).default([]),version:z.literal(1),styles:z.array(styleRecordSchema).max(30),trials:z.array(trialSchema).max(60),deletedVersionHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([])});
type State=z.infer<typeof stateSchema>;
const ownerKey=(owner:string)=>createHash('sha256').update(owner).digest('hex');
const directory=()=>process.env.PERSONAL_STYLES_DIR||join(process.cwd(),'.local-data','personal-styles');
function initial():State{return {learningAdoptions:[],version:1,trials:[],deletedVersionHashes:[],styles:BUILTIN_PERSONAL_STYLES.map(id=>{
  const snapshot=builtinRuleSnapshot(id);return {id,revision:1,builtin:true,activeVersionId:snapshot.versionId,activatedVersionIds:[snapshot.versionId],draftVersionId:snapshot.versionId,versions:[{snapshot,createdAt:'2026-11-04T00:00:00.000Z',reason:'从个人创作现有规则提取；仅统一单选和逐图无小标题'}]};
})};}
async function acquire(file:string){
  const lock=file+'.lock', marker=`owner-${process.pid}-${randomUUID()}`;
  for(let attempt=0;attempt<100;attempt++){
    let created=false;
    try{await mkdir(lock,{mode:0o700});created=true;await writeFile(join(lock,marker),'',{flag:'wx',mode:0o600});return async()=>{try{await unlink(join(lock,marker));await rmdir(lock);}catch{}};}
    catch(e){
      if(created){try{await unlink(join(lock,marker));await rmdir(lock);}catch{}}
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      try{const entries=await readdir(lock),match=entries.length===1?entries[0].match(/^owner-(\d+)-[0-9a-f-]+$/):null;if(match){try{process.kill(Number(match[1]),0);}catch(err){if((err as NodeJS.ErrnoException).code==='ESRCH'){await unlink(join(lock,entries[0]));await rmdir(lock);}}}}catch{}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  throw new AppError('STYLE_BUSY','风格正在另一个页面保存，请稍后重试。',409);
}
async function transaction<T>(owner:string,work:(s:State)=>T,write=true):Promise<T>{
  if(!owner)throw new AppError('UNAUTHORIZED','请先登录。',401);
  const id=ownerKey(owner);
  if(isCloudMode())return (await getRepository()).transaction(async tx=>{const raw=await tx.get('personal_styles',id),state=raw?stateSchema.parse(raw):initial();const result=work(state);stateSchema.parse(state);if(JSON.stringify(state).length>8_000_000)throw new AppError('STYLE_LIMIT','风格与试生成记录过多，请精简示例。',400);if(write||!raw)await tx.put('personal_styles',id,state,owner);return structuredClone(result);});
  await mkdir(directory(),{recursive:true,mode:0o700});const file=join(directory(),id+'.json'),release=await acquire(file);
  try{
    let state=initial(),missing=false;
    let text:string|undefined;
    try{text=await readFile(file,'utf8');}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')missing=true;
      else throw new AppError('STYLE_STORAGE','风格文件暂时无法从本机存储读取，原记录保留。请确认文件已下载到本机后重新读取；若反复发生，请更新本机工作台以迁移到专用存储。',503);
    }
    if(text!==undefined){try{if(text.length>8_000_000)throw new Error('SIZE');state=stateSchema.parse(JSON.parse(text));}catch{throw new AppError('STYLE_RECORD_INVALID','风格记录格式校验未通过，原文件保留，未重置或覆盖。请检查或恢复已备份的风格记录。',503);}}
    // GET, version resolution and task binding must not rewrite the library.
    // Only first-time initialization or an explicit change persists data.
    const result=work(state);stateSchema.parse(state);const serialized=JSON.stringify(state);if(serialized.length>8_000_000)throw new AppError('STYLE_LIMIT','风格与试生成记录过多，请精简示例。',400);
    if(write||missing){const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,serialized,{mode:0o600});await rename(temporary,file);}
    return structuredClone(result);
  }finally{await release();}
}
function find(state:State,id:string){const record=state.styles.find(s=>s.id===id);if(!record)throw new AppError('STYLE_NOT_FOUND','风格不存在或不属于当前账号。',404);return record;}
function checkRevision(record:StyleRecord,expected:number){if(record.revision!==expected)throw new AppError('STYLE_CONFLICT','风格已在其他页面更新。当前填写内容保留，请重新读取后再保存。',409);}
function append(record:StyleRecord,content:RuleContent,reason:string,extra:Partial<Pick<StyleVersion,'restoredFrom'|'importReview'|'learningReview'>>={}){
  if(record.versions.length>=200)throw new AppError('STYLE_LIMIT','此风格已达到 200 个版本，请复制为新风格继续。',400);
  const snapshot:RuleSnapshot={...record.versions[0].snapshot,versionId:randomUUID(),version:record.versions.length+1,content:ruleContentSchema.parse(content)};
  record.versions.push({snapshot,createdAt:new Date().toISOString(),reason,...extra});record.draftVersionId=snapshot.versionId;record.revision++;return record;
}
export async function listPersonalStyles(owner:string){return transaction(owner,({version,styles,trials})=>({version,styles,trials}),false);}
export async function savePersonalStyle(owner:string,id:string,revision:number,content:unknown){const parsed=ruleContentSchema.safeParse(content);if(!parsed.success)throw new AppError('INVALID_FORM',parsed.error.issues[0]?.message||'请检查风格规则。',400);return transaction(owner,s=>{const r=find(s,id);checkRevision(r,revision);const version=r.versions.find(v=>v.snapshot.versionId===r.draftVersionId);return append(r,parsed.data,'保存规则草稿',{...(version?.importReview?{importReview:version.importReview}:{}),...(version?.learningReview?{learningReview:version.learningReview}:{})});});}
export async function createPersonalStyle(owner:string,content:RuleContent,baseStyle:RuleSnapshot['baseStyle']='custom',review?:StyleVersion['importReview'],learningReview?:StyleVersion['learningReview']){return transaction(owner,s=>{
  if(s.styles.length>=30)throw new AppError('STYLE_LIMIT','最多保存 30 个风格。',400);
  const id='style-'+randomUUID(),versionId=randomUUID(),record:StyleRecord={id,revision:1,builtin:false,activeVersionId:null,activatedVersionIds:[],draftVersionId:versionId,versions:[{snapshot:{styleId:id,versionId,version:1,baseStyle,commonVersion:'personal-v1',content:ruleContentSchema.parse(content)},createdAt:new Date().toISOString(),reason:review?'导入 Skill 为新草稿':'新风格草稿',...(review?{importReview:review}:{}),...(learningReview?{learningReview}:{})}]};s.styles.push(record);return record;
});}
export async function copyPersonalStyle(owner:string,id:string,versionId:string){const source=await transaction(owner,s=>find(s,id).versions.find(v=>v.snapshot.versionId===versionId),false);if(!source)throw new AppError('STYLE_NOT_FOUND','规则版本不存在。',404);return createPersonalStyle(owner,{...source.snapshot.content,name:(source.snapshot.content.name+'（副本）').slice(0,60)},source.snapshot.baseStyle,source.importReview,source.learningReview);}
export async function importPersonalStyle(owner:string,text:string,filename?:string){const {content,review}=organizeWritingSkill(text,filename);if(!ruleContentSchema.safeParse(content).success)throw new AppError('INVALID_FORM','导入规则某个栏目过长，请精简文本后再导入。整体表达、标题和避免事项最多 3000 字符，正文与配文最多 6000 字符；原文仍保留在表单中。',400);return createPersonalStyle(owner,content,'custom',review);}
export async function activatePersonalStyle(owner:string,id:string,revision:number,versionId:string){return transaction(owner,s=>{const r=find(s,id);checkRevision(r,revision);if(!r.versions.some(v=>v.snapshot.versionId===versionId))throw new AppError('STYLE_NOT_FOUND','规则版本不存在。',404);r.activeVersionId=versionId;if(!r.activatedVersionIds.includes(versionId))r.activatedVersionIds.push(versionId);r.revision++;return r;});}
export async function deactivatePersonalStyle(owner:string,id:string,revision:number){
  return transaction(owner,state=>{
    const record=find(state,id);
    checkRevision(record,revision);
    if(record.activeVersionId){
      record.activeVersionId=null;
      record.revision++;
    }
    return record;
  });
}

function snapshotHash(snapshot:RuleSnapshot){
  // Parsing fixes property order so a JSON round trip preserves the fingerprint.
  return createHash('sha256').update(JSON.stringify(ruleSnapshotSchema.parse(snapshot))).digest('hex');
}

export async function deletePersonalStyle(owner:string,id:string,revision:number){
  return transaction(owner,state=>{
    const record=find(state,id);
    checkRevision(record,revision);
    // Drafts/notes own their snapshots. Retain only proof of previously enabled versions for this owner.
    const enabled=new Set(record.activatedVersionIds);
    const history=record.versions.filter(v=>enabled.has(v.snapshot.versionId));
    state.deletedVersionHashes.push(...history.map(v=>snapshotHash(v.snapshot)));
    state.styles=state.styles.filter(style=>style.id!==id);
    state.trials=state.trials.filter(trial=>trial.styleId!==id);
  });
}
export async function restorePersonalStyle(owner:string,id:string,revision:number,versionId:string){return transaction(owner,s=>{const r=find(s,id);checkRevision(r,revision);const old=r.versions.find(v=>v.snapshot.versionId===versionId);if(!old)throw new AppError('STYLE_NOT_FOUND','规则版本不存在。',404);return append(r,old.snapshot.content,'从历史版本恢复为新草稿',{restoredFrom:versionId,...(old.importReview?{importReview:old.importReview}:{}),...(old.learningReview?{learningReview:old.learningReview}:{})});});}
function versionFor(record:StyleRecord,versionId?:string,allowDraft=false){
  const version=record.versions.find(v=>v.snapshot.versionId===(versionId??record.activeVersionId));
  if(!version||(!allowDraft&&!record.activatedVersionIds.includes(version.snapshot.versionId))){
    throw new AppError('STYLE_NOT_ACTIVE','此风格版本尚未启用，请在管理风格中选择并启用版本。',400);
  }
  return version.snapshot;
}
export async function resolvePersonalStyle(owner:string,id:string,versionId?:string,allowDraft=false):Promise<RuleSnapshot>{
  return transaction(owner,state=>versionFor(find(state,id),versionId,allowDraft),false);
}
/** Image/video drafts pin the same owner-scoped, previously enabled versions. */
export async function bindWritingStyle<T extends {writingStyle?:RuleSnapshot}>(brief:T,owner='local-owner'):Promise<T>{
  const provided=brief.writingStyle;
  if(!provided)return brief;
  const resolved=await transaction(owner,state=>{
    const record=state.styles.find(style=>style.id===provided.styleId);
    if(record)return versionFor(record,provided.versionId);
    if(state.deletedVersionHashes.includes(snapshotHash(provided)))return provided;
    throw new AppError('STYLE_NOT_FOUND','风格已删除或不属于当前账号，请重新选择写作风格。',404);
  },false);
  if(JSON.stringify(provided)!==JSON.stringify(resolved))throw new AppError('STYLE_CONFLICT','风格规则与保存版本不一致，请重新选择；已有内容保留。',409);
  return {...brief,writingStyle:resolved};
}
/** Bind once at submission; current activation never overrides a confirmed snapshot. */
export async function bindPersonalRules(request:PersonalRequest,owner='local-owner',stage:'submission'|'queued'='submission'):Promise<PersonalRequest>{
  if(request.input.styles.length!==1)throw new AppError('STYLE_SELECTION_REQUIRED','旧内容包含多个风格。请明确选择一种，并重新确认创作依据后继续。',400);
  const id=request.input.styles[0],provided=request.input.ruleSnapshot;
  if(provided&&provided.styleId!==id)throw new AppError('STYLE_CONFLICT','风格与规则版本不一致，请重新生成并确认提示词。',409);
  if(!provided&&request.action!=='prompt'&&!isBuiltinStyle(id))throw new AppError('STYLE_VERSION_REQUIRED','自定义风格请先生成并确认包含规则版本的提示词。',400);
  const newPrompt=request.action==='prompt'&&!(stage==='queued'&&provided);
  const historical=provided??(request.action!=='prompt'&&isBuiltinStyle(id)?builtinRuleSnapshot(id):undefined);
  const resolved=await transaction(owner,state=>{
    const record=state.styles.find(style=>style.id===id);
    if(!record){
      if(!newPrompt&&historical&&state.deletedVersionHashes.includes(snapshotHash(historical)))return historical;
      throw new AppError('STYLE_NOT_FOUND','风格已删除或不属于当前账号，请选择已启用的风格。',404);
    }
    if(newPrompt&&!record.activeVersionId)throw new AppError('STYLE_NOT_ACTIVE','所选风格尚未启用或已停用，请选择其他风格或在管理风格中启用。',400);
    return versionFor(record,historical?.versionId);
  },false);
  if(provided&&JSON.stringify(provided)!==JSON.stringify(resolved))throw new AppError('STYLE_CONFLICT','规则快照与保存版本不一致，请重新读取规则；已有内容保留。',409);
  return {...request,input:{...request.input,ruleSnapshot:resolved}};
}
export async function recordStyleTrial(owner:string,trial:StyleTrial){return transaction(owner,s=>{find(s,trial.styleId);s.trials=[trialSchema.parse(trial),...s.trials].slice(0,60);return trial;});}


export type StyleLearningTarget = { styleId: string; revision: number; versionId: string };
/** Bind the saved draft once; model work cannot substitute client-supplied old rules. */
export async function resolveStyleLearningTarget(owner: string, target: StyleLearningTarget) {
  return transaction(owner, state => {
    const record = find(state, target.styleId); checkRevision(record, target.revision);
    const version = record.versions.find(item => item.snapshot.versionId === target.versionId);
    if (!version || record.draftVersionId !== target.versionId) throw new AppError('STYLE_CONFLICT', '所选规则已不是当前草稿，请重新读取后再综合。', 409);
    return { baseline: version.snapshot.content, learningReview: version.learningReview };
  }, false);
}
/** Atomically adopt a reviewed result, its provenance and its idempotency receipt. */
export async function adoptStyleLearningResult(owner: string, options: {
  adoptionId: string; jobId: string; payloadHash: string; content: RuleContent;
  target?: StyleLearningTarget; review: NonNullable<StyleVersion['learningReview']>;
}) {
  const content = ruleContentSchema.parse(options.content);
  return transaction(owner, state => {
    const old = state.learningAdoptions.find(item => item.adoptionId === options.adoptionId || item.jobId === options.jobId);
    if (old) {
      if (old.jobId !== options.jobId || old.payloadHash !== options.payloadHash) throw new AppError('STYLE_ADOPTION_CONFLICT', '这次分析已经保存过不同内容，请重新读取已保存草稿后修改。', 409);
      const style = find(state, old.styleId);
      if (!style.versions.some(version => version.snapshot.versionId === old.versionId)) throw new AppError('STYLE_NOT_FOUND', '已采用的规则版本不可用，请查看风格历史。', 404);
      return { style, versionId: old.versionId };
    }
    let style: StyleRecord;
    if (options.target) {
      style = find(state, options.target.styleId); checkRevision(style, options.target.revision);
      if (style.draftVersionId !== options.target.versionId) throw new AppError('STYLE_CONFLICT', '规则草稿在综合期间已更新，请重新综合；当前方案保留。', 409);
      const oldVersion = style.versions.find(version => version.snapshot.versionId === options.target!.versionId)!;
      append(style, content, '综合新旧参考后保存规则草稿', { learningReview: options.review, ...(oldVersion.importReview ? { importReview: oldVersion.importReview } : {}) });
    } else {
      if (state.styles.length >= 30) throw new AppError('STYLE_LIMIT', '最多保存 30 个风格。', 400);
      const id = 'style-' + randomUUID(), versionId = randomUUID();
      style = { id, revision: 1, builtin: false, activeVersionId: null, activatedVersionIds: [], draftVersionId: versionId, versions: [{ snapshot: { styleId: id, versionId, version: 1, baseStyle: 'custom', commonVersion: 'personal-v1', content }, createdAt: new Date().toISOString(), reason: '从认可的参考写法建立风格草稿', learningReview: options.review }] };
      state.styles.push(style);
    }
    const versionId = style.draftVersionId;
    state.learningAdoptions.push({ adoptionId: options.adoptionId, jobId: options.jobId, payloadHash: options.payloadHash, styleId: style.id, versionId });
    return { style, versionId };
  });
}

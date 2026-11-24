'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AiUsageStatus, useAiTask } from '../ai/usage-status';
import { AppShell } from '@/components/app-shell';
import { CopyButton } from '@/components/copy-button';
import { VideoDialog } from '@/components/video/dialog';
import { ImageUploader } from '@/components/image-uploader';
import { useCloud } from '@/components/cloud/context';
import { cloudFetch } from '@/lib/cloud/client';
import { makeCloudPersonalStore } from '@/lib/cloud/store';
import { aiSourceHeader } from '@/lib/ai-source';
import { compressImages, prepareImage } from '@/lib/images';
import type { StudioImage } from '@/lib/types';
import { personalLocalStore } from '@/lib/personal/store';
import { hydratePersonalDraft } from '@/lib/personal/drafts';
import { emptyPersonalInput, type PersonalInput } from '@/lib/personal/schema';
import { usePersonalStyles, personalStyleAction } from '@/lib/personal/style-client';
import { fullRulePackage, readOnlyRules, ruleContentSchema, ruleSections, ruleSectionText, type RuleContent, type RuleSection, type StyleRecord, type StyleVersion } from '@/lib/personal/style-rules';
import type { StyleTrial } from '@/lib/server/personal-style-store';
import { StyleLearning, type LearnedStyleTarget, type LearnedStyleAdoption } from './style-learning';
import './studio.css';
import './style-manager.css';

type Tab='rules'|'examples'|'trial'|'versions'|'preview';
type StyleConfirmation={operation:'activate'|'delete';record:StyleRecord;version:StyleVersion;unsaved:boolean};
const tabs:Record<Tab,string>={rules:'编辑规则',examples:'参考示例',trial:'试生成',versions:'版本记录',preview:'完整规则'};
export function PersonalStyleManager(){const {user}=useCloud();return <Manager key={user?.id||'local-owner'}/>;}

function Manager(){
  const aiTask=useAiTask();
  const router=useRouter(),{user,cloud}=useCloud(),{data,error:loadError,loading,load}=usePersonalStyles();
  const [editor,setEditor]=useState<{record:StyleRecord;content:RuleContent}|null>(null),[tab,setTab]=useState<Tab>('rules');
  const [busy,setBusy]=useState(false),[testing,setTesting]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [confirmation,setConfirmation]=useState<StyleConfirmation|null>(null);
  const [learningOpen,setLearningOpen]=useState(false),[learningDirty,setLearningDirty]=useState(false);
  const [importing,setImporting]=useState(false),[importText,setImportText]=useState(''),[filename,setFilename]=useState('粘贴的 Skill');
  const [testInput,setTestInput]=useState<PersonalInput>(()=>structuredClone(emptyPersonalInput));
  const [kind,setKind]=useState<'body'|'title'|'captions'>('body'),[images,setImages]=useState<StudioImage[]>([]),[trial,setTrial]=useState<StyleTrial|null>(null),[compareId,setCompareId]=useState('');
  const working=useRef(false),controller=useRef<AbortController|null>(null),urls=useRef(new Set<string>()),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;const imageUrls=urls.current;return()=>{mounted.current=false;controller.current?.abort();imageUrls.forEach(url=>URL.revokeObjectURL(url));};},[]);
  const original=editor?.record.versions.find(v=>v.snapshot.versionId===editor.record.draftVersionId);
  const dirty=Boolean(editor&&original&&JSON.stringify(editor.content)!==JSON.stringify(original.snapshot.content));
  const remote=data?.styles.find(style=>style.id===editor?.record.id);
  const record=dirty&&editor?editor.record:remote??data?.styles[0]??null;
  const draft=record?.versions.find(v=>v.snapshot.versionId===record.draftVersionId);
  const content=dirty&&editor?editor.content:draft?.snapshot.content;
  const snapshot=draft&&content?{...draft.snapshot,content}:null;
  const outdated=Boolean(dirty&&data&&remote?.revision!==editor?.record.revision);
  const active=record?.versions.find(v=>v.snapshot.versionId===record.activeVersionId);
  useEffect(()=>{if(!dirty&&!learningDirty)return;const warn=(e:BeforeUnloadEvent)=>e.preventDefault();window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty,learningDirty]);
  function leave(){return (!dirty&&!learningDirty)||window.confirm('还有未保存的规则或风格学习内容，离开会丢失这次填写。继续吗？');}
  async function navigate(action:()=>void){if(busy||!leave())return false;action();return true;}
  function selectRecord(record:StyleRecord|null){
    const version=record?.versions.find(v=>v.snapshot.versionId===record.draftVersionId);
    setEditor(record&&version?{record,content:structuredClone(version.snapshot.content)}:null);
    setTrial(null);
    setCompareId('');
  }
  function choose(record:StyleRecord){if(!leave())return;selectRecord(record);setError('');setNotice('');}
  function edit(next:RuleContent){if(record)setEditor({record,content:next});}
  async function action(body:unknown,message:string,adoption?:LearnedStyleAdoption){
    if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
    try{
      let style:StyleRecord|null,adoptedVersionId:string|undefined;
      if(adoption){
        const {jobId,...review}=adoption;
        const response=await cloudFetch(`/api/personal/styles/learning-jobs/${jobId}/adopt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...review,content:(body as {content:RuleContent}).content})});
        const result=await response.json();
        if(!response.ok)throw new Error(result.error?.message||'规则尚未保存，综合预览保留。');
        style=result.style;adoptedVersionId=result.versionId;window.dispatchEvent(new Event('xhs-personal-styles-updated'));
      }else({style}=await personalStyleAction(body));
      if(!mounted.current)return;
      selectRecord(style);
      setNotice(message);
      try{await load();}catch{if(mounted.current)setError('操作已保存，风格列表刷新失败，请重新读取。');}
      return {style,adoptedVersionId};
    }
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:'保存失败，填写内容保留。');return false;}
    finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  async function save(){if(!record||!content)return;const parsed=ruleContentSchema.safeParse(content);if(!parsed.success){setError('请检查名称、示例输出和规则长度。每条示例必须填写喜欢的输出，规则与示例合计最多 24000 字符。');return;}await action({action:'save',id:record.id,revision:record.revision,content:parsed.data},'草稿已保存，当前启用版本未改变。');}
  function openLearning(){
    if(dirty){setError('请先保存当前规则草稿，再从笔记学习风格。');return;}
    setImporting(false);setLearningOpen(true);setError('');setNotice('');
  }
  function restoreLearningTarget(id:string){
    const target=data?.styles.find(style=>style.id===id);
    if(target)selectRecord(target);
    else setError('综合任务对应的风格已不在列表中。保留方案供查看，不能保存到其他风格。');
  }
  async function applyLearned(content:RuleContent,target:LearnedStyleTarget,trialKind:'body'|'title'|'captions',adoption?:LearnedStyleAdoption){
    if(target&&!adoption){setError('已有风格需要先结合当前草稿重新综合，不能直接追加旧分析结果。');return false;}
    const ok=await action(target?{action:'save',id:target.id,revision:target.revision,content}:{action:'create',content},'学习的规则已保存为草稿。填写你自己的素材试生成，满意后再启用此版本。',adoption);
    if(ok){
      setLearningOpen(false);
      if(adoption&&ok.style&&ok.adoptedVersionId&&ok.adoptedVersionId!==ok.style.draftVersionId){
        const version=ok.style.versions.find(item=>item.snapshot.versionId===ok.adoptedVersionId)?.snapshot.version;
        setTab('versions');setNotice(`此方案先前已保存为${version?` v${version}`:'历史版本'}，当前草稿已有更新。已打开版本记录，未覆盖当前草稿或自动启用。`);
      }else{setTab('trial');setKind(trialKind);}
    }
    return Boolean(ok);
  }
  function deactivate(){
    if(!record||!active||dirty)return;
    void action({action:'deactivate',id:record.id,revision:record.revision},'风格已停用，可随时重新启用。');
  }
  function review(operation:StyleConfirmation['operation']){
    if(!record||!draft||working.current)return;
    setConfirmation({operation,record,version:draft,unsaved:dirty});
  }
  function confirmChange(){
    if(!confirmation||working.current)return;
    const {operation,record,version}=confirmation;
    setConfirmation(null);
    if(operation==='activate'){
      void action({action:'activate',id:record.id,revision:record.revision,versionId:version.snapshot.versionId},'版本已启用。');
    }else{
      void action({action:'delete',id:record.id,revision:record.revision},`已删除「${version.snapshot.content.name}」。`);
    }
  }
  async function importSkill(){if(!leave())return;const ok=await action({action:'import',text:importText,filename},'已整理为新的风格草稿，请检查识别结果与依赖提示。尚未启用。');if(ok){setImporting(false);setImportText('');setTab('rules');}}
  async function readSkill(file?:File){if(!file)return;if(file.size>128000||!/\.md$/i.test(file.name)){setError('请上传不超过 128 KB 的 Markdown 文件，文本最多 64000 字符。');return;}try{const text=await file.text();if(text.length>64000)throw new Error('导入文本最多 64000 字符。');setImportText(text);setFilename(file.name);}catch(e){setError(e instanceof Error?e.message:'文件无法读取。');}}
  async function copyMaterial(){
    if(working.current)return;
    if(!window.confirm('将当前草稿的素材、创作设置和图片复制到独立测试区；这里原有的测试素材会被替换。正式草稿不会改变。'))return;
    working.current=true;setBusy(true);
    try{const store=cloud?makeCloudPersonalStore(user!.id):personalLocalStore,workspace=await store.readWorkspace();if(!workspace.activeId)throw new Error('还没有已保存的当前草稿。');const current=await hydratePersonalDraft(await store.getDraft(workspace.activeId));current.images.forEach(i=>urls.current.add(i.preview));current.resultImages.forEach(i=>urls.current.add(i.preview));setImages(current.images);setTestInput({...current.input,search:false});setNotice('已复制素材到测试区；正式草稿未改变。');}catch(e){setError(e instanceof Error?e.message:'无法读取当前草稿。');}finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  async function addImages(files:File[]){if(working.current)return;if(files.length+images.length>9){setError('最多选择 9 张测试图片。');return;}working.current=true;setBusy(true);const loaded:StudioImage[]=[];try{for(const file of files)loaded.push(await prepareImage(file));loaded.forEach(i=>urls.current.add(i.preview));setImages(old=>[...old,...loaded]);setError('');}catch(e){loaded.forEach(i=>URL.revokeObjectURL(i.preview));setError(e instanceof Error?e.message:'图片读取失败。');}finally{working.current=false;setBusy(false);}}
  async function test(){
    if(working.current||!record||!draft||dirty)return;if(!testInput.experience.trim()){setError('请填写测试素材。');return;}if(kind==='captions'&&!images.length){setError('逐图试生成需要主动添加测试图片。');return;}
    const frozen={recordId:record.id,versionId:draft.snapshot.versionId,input:structuredClone(testInput),kind,images:kind==='captions'?[...images]:[],source:aiTask.start().id};
    working.current=true;setBusy(true);setTesting(true);setError('');setNotice('正在独立试生成，不会覆盖正式草稿。');const abort=new AbortController();controller.current=abort;
    try{const blobs=await compressImages(frozen.images,()=>undefined);abort.signal.throwIfAborted();const form=new FormData();form.set('payload',JSON.stringify({id:frozen.recordId,versionId:frozen.versionId,kind:frozen.kind,input:frozen.input,imageIds:frozen.images.map(i=>i.id)}));blobs.forEach((blob,i)=>form.append('images',blob,`${frozen.images[i].id}.jpg`));
      const response=await cloudFetch('/api/personal/styles/test',{method:'POST',headers:aiSourceHeader(frozen.source),body:form,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(195000)])});const value=await response.json();if(!response.ok)throw new Error(value.error?.message||'试生成失败，规则及上次结果保留。');abort.signal.throwIfAborted();if(mounted.current){setTrial(value.trial);setNotice('试生成已保存。确认满意后，可主动启用此版本。');await load();}
    }catch(e){if(mounted.current)setError(abort.signal.aborted?'试生成已取消，规则和上次结果保留。':e instanceof Error?e.message:'试生成失败，规则和上次结果保留。');}
    finally{working.current=false;controller.current=null;if(mounted.current){setBusy(false);setTesting(false);aiTask.finish();}}
  }
  const savedTrials=data?.trials.filter(t=>t.styleId===record?.id&&t.kind===kind)??[];
  const shownTrial=trial&&trial.styleId===record?.id&&trial.kind===kind?trial:savedTrials[0];
  const comparison=savedTrials.find(t=>t.id===compareId)||(shownTrial?savedTrials.find(t=>t.id!==shownTrial.id):undefined);
  return <AppShell disabled={busy} navigateSafely={navigate}><main className="page-main personal-style-manager">
    <header className="style-manager-header"><div><p className="style-eyebrow">PERSONAL WRITING</p><h1>管理写作风格</h1><p>先保存草稿、试写，再决定启用。已有笔记和提示词保留原版本。</p></div><button type="button" className="secondary-button" disabled={busy} onClick={()=>void navigate(()=>router.push('/personal'))}>返回个人创作</button></header>
    {(error||loadError)&&<p role="alert" className="storage-error">{error||loadError} <button type="button" className="text-button" disabled={busy} onClick={()=>{if(leave())void load().then(d=>{selectRecord(d.styles.find(s=>s.id===record?.id)??null);setError('');}).catch(()=>{});}}>重新读取</button></p>}
    {outdated&&<p role="status" className="storage-warning">{remote?'此风格已在其他页面更新。':'此风格已在其他页面删除。'}当前填写内容可复制。<button type="button" className="text-button" disabled={busy} onClick={()=>{if(leave())selectRecord(remote??null);}}>重新读取</button></p>}
    {notice&&<p role="status" className="style-notice">{notice}</p>}
    <div className="style-manager-layout"><aside className="style-list" aria-label="风格列表"><button type="button" className="generate-button style-learn-entry" disabled={busy||!data} aria-pressed={learningOpen} onClick={openLearning}>从笔记学习风格</button><div className="style-list-actions"><button type="button" className="secondary-button" disabled={busy||learningOpen} onClick={()=>{if(leave())void action({action:'create'},'新风格已保存为草稿，尚未启用。');}}>新增风格</button><button type="button" className="text-button" disabled={busy||learningOpen} onClick={()=>setImporting(v=>!v)}>导入 Skill</button></div>
      {!data&&loading&&!loadError&&<p role="status">正在读取风格…</p>}{data?.styles.map(s=>{const v=s.versions.find(v=>v.snapshot.versionId===s.draftVersionId)!;return <button className={`style-list-item ${record?.id===s.id?'selected':''}`} type="button" key={s.id} disabled={busy||learningOpen} aria-pressed={record?.id===s.id} onClick={()=>choose(s)}><strong>{v.snapshot.content.name}</strong><span>{s.builtin?'内置 · ':''}{s.activeVersionId?`启用 v${s.versions.find(v=>v.snapshot.versionId===s.activeVersionId)!.snapshot.version}`:s.activatedVersionIds.length?'已停用':'未启用'} · 草稿 v{v.snapshot.version}</span></button>;})}
    </aside><section className="style-editor">
      <div hidden={!learningOpen}><StyleLearning active={learningOpen} styles={data?.styles ?? []} disabled={busy} cloud={cloud} onBusy={setBusy} onDirty={setLearningDirty} onApply={applyLearned} onRestoreTarget={restoreLearningTarget} onClose={()=>setLearningOpen(false)}/></div>
      {importing&&<section className="style-import"><h2>导入写作 Skill</h2><p>仅按栏目整理文本，不调用模型、不执行脚本。导入后是新的未启用草稿。</p><label className="field">上传 SKILL.md<input type="file" accept=".md,text/markdown" disabled={busy} onChange={e=>void readSkill(e.target.files?.[0])}/></label><label className="field">或粘贴写作 Skill<textarea value={importText} rows={8} maxLength={64000} disabled={busy} onChange={e=>setImportText(e.target.value)}/></label><button type="button" className="generate-button" disabled={busy||!importText.trim()} onClick={()=>void importSkill()}>整理为新风格草稿</button><button type="button" className="text-button" onClick={()=>setImporting(false)}>收起</button></section>}
      {data&&!record&&!importing&&<p className="style-empty">暂无写作风格，可新增风格或导入 Skill。</p>}
      {!learningOpen&&record&&draft&&content&&snapshot&&<>
        <div className="style-editor-heading">
          <div><h2>{content.name||'未命名风格'}</h2><p>{active?`当前启用 v${active.snapshot.version}`:record.activatedVersionIds.length?'已停用':'尚未启用'} · 编辑草稿 v{draft.snapshot.version}{dirty?' · 未保存':''}</p></div>
          <div className="personal-toolbar-actions">
            <button type="button" disabled={busy||!dirty||outdated} onClick={()=>void save()}>保存规则草稿</button>
            {active?.snapshot.versionId!==draft.snapshot.versionId&&<button type="button" disabled={busy||dirty} onClick={()=>review('activate')}>启用此版本</button>}
            {active&&<button type="button" disabled={busy||dirty} onClick={deactivate}>停用风格</button>}
            <button type="button" disabled={busy||dirty} onClick={()=>void action({action:'copy',id:record.id,versionId:draft.snapshot.versionId},'已复制为新风格草稿。')}>复制为新风格</button>
            <button type="button" disabled={busy||outdated} onClick={()=>review('delete')}>删除风格</button>
          </div>
        </div>
        {draft.importReview&&<details className="style-import-review" open><summary>导入检查与未支持的依赖</summary>{draft.importReview.warnings.map(w=><p key={w}>{w}</p>)}{draft.importReview.dependencies.length>0&&<p>未加载文件：{draft.importReview.dependencies.join('、')}</p>}<details><summary>查看原始 Skill（仅文本）</summary><pre>{draft.importReview.originalText}</pre></details></details>}
        <nav className="style-tabs" aria-label="风格管理栏目">{(Object.keys(tabs) as Tab[]).map(t=><button type="button" key={t} aria-current={tab===t?'page':undefined} onClick={()=>setTab(t)}>{tabs[t]}</button>)}</nav>
        {tab==='rules'&&<fieldset disabled={busy} className="style-rule-fields"><label className="field">风格名称<input maxLength={60} value={content.name} onChange={e=>edit({...content,name:e.target.value})}/></label><p className="field-hint">整体表达适用于各栏目；正文、标题、逐图配文的补充只作用于对应栏目。原有风格要求已保留在整体表达中。空白栏目沿用共同规则，不补造偏好。</p>{(Object.entries(ruleSections) as [RuleSection,string][]).map(([key,label])=><label className="field" key={key}>{label}<textarea rows={key==='overall'||key==='captions'?7:3} value={ruleSectionText(content.sections[key],key)} maxLength={key==='body'||key==='captions'?6000:3000} placeholder="沿用共同规则" onChange={e=>edit({...content,sections:{...content.sections,[key]:e.target.value}})}/></label>)}<details className="style-readonly"><summary>共同规则与固定约束（只读）</summary><pre>{readOnlyRules(snapshot)}</pre><p>格式与长度的硬约束暂不在此编辑；正文长度仍在每次创作中选择。写作规则中的相反要求不能覆盖这些约束。</p></details></fieldset>}
        {tab==='examples'&&<section><p className="field-hint">只添加你认可的写法。示例人物、地点和经历不会当作新笔记的事实；试生成记录不会自动加入这里。</p>{content.examples.length===0&&<p className="style-empty">暂无参考示例</p>}{content.examples.map((example,index)=>{function change(field:string,value:string){edit({...content!,examples:content!.examples.map(e=>e.id===example.id?{...e,[field]:value}:e)});}return <fieldset disabled={busy} className="style-example" key={example.id}><legend>示例 {index+1}</legend><label className="field">适用栏目<select value={example.scope} onChange={e=>change('scope',e.target.value)}><option value="overall">整体表达</option><option value="body">正文</option><option value="title">标题</option><option value="captions">逐图配文</option></select></label>{([['background','素材或背景',2000],['output','喜欢的输出（必填）',4000],['reason','喜欢的原因',1500],['disliked','不满意版本（选填）',4000],['changes','修改说明（选填）',1500]] as const).map(([key,label,max])=><label className="field" key={key}>{label}<textarea rows={3} value={example[key]} maxLength={max} onChange={e=>change(key,e.target.value)}/></label>)}<button type="button" className="text-button" onClick={()=>edit({...content,examples:content.examples.filter(e=>e.id!==example.id)})}>移除此示例</button></fieldset>;})}<button type="button" className="secondary-button" disabled={busy||content.examples.length>=8} onClick={()=>edit({...content,examples:[...content.examples,{id:crypto.randomUUID(),scope:'body',background:'',output:'',reason:'',disliked:'',changes:''}]})}>添加认可示例</button></section>}
        {tab==='trial'&&<section className="style-trial"><AiUsageStatus task={aiTask}/><p className="field-hint">测试草稿 v{draft.snapshot.version}。使用当前 AI 配置，点击才产生 API 用量。检索不会自动开启，正式草稿与已完成笔记不变。</p>{dirty&&<p className="storage-warning">先保存规则草稿，再测试该版本。</p>}<fieldset disabled={busy}><div className="style-trial-toolbar"><label className="field">测试栏目<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="body">正文</option><option value="title">标题</option><option value="captions">逐图配文</option></select></label><button type="button" className="secondary-button" onClick={()=>void copyMaterial()}>复制当前草稿素材到测试区</button></div><label className="field">测试素材<textarea rows={5} maxLength={4000} value={testInput.experience} onChange={e=>setTestInput({...testInput,experience:e.target.value})}/></label><label className="field">本次核心感受（选填）<input maxLength={600} value={testInput.coreIntent} onChange={e=>setTestInput({...testInput,coreIntent:e.target.value})}/></label><label className="field">本次风格补充<textarea rows={2} maxLength={1000} value={testInput.customStyle} onChange={e=>setTestInput({...testInput,customStyle:e.target.value})}/></label><div className="style-trial-toolbar"><label className="field">真实性<select value={testInput.truth} onChange={e=>setTestInput({...testInput,truth:e.target.value as PersonalInput['truth']})}><option value="truthful">真实润色</option><option value="creative">创意发挥</option></select></label><label className="field">正文长度<select value={testInput.bodyLength} onChange={e=>setTestInput({...testInput,bodyLength:e.target.value as PersonalInput['bodyLength']})}><option value="auto">自动</option><option value="short">短篇</option><option value="medium">中篇</option><option value="long">长篇</option><option value="custom">自定义</option></select></label>{testInput.bodyLength==='custom'&&<label className="field">目标字数<input type="number" min={100} max={1200} value={testInput.customLength} onChange={e=>setTestInput({...testInput,customLength:Number(e.target.value)})}/></label>}</div>{kind==='captions'&&<ImageUploader images={images} disabled={busy} onAdd={files=>void addImages(files)} onRemove={id=>setImages(images.filter(i=>i.id!==id))} onMove={(index,delta)=>{const next=[...images],to=index+delta;if(to<0||to>=next.length)return;[next[index],next[to]]=[next[to],next[index]];setImages(next);}}/>}</fieldset><div className="style-actions"><button type="button" className="generate-button" disabled={busy||dirty} onClick={()=>void test()}>{testing?'正在试生成…':'试生成（使用 API 用量）'}</button>{testing&&<button type="button" className="secondary-button" onClick={()=>controller.current?.abort()}>取消试生成</button>}</div><div className="style-trial-results"><article><h3>本次 / 最近结果</h3>{shownTrial?<><p className="field-hint">{shownTrial.model} · 规则 v{shownTrial.snapshot.version} · {new Date(shownTrial.at).toLocaleString()}</p><pre>{shownTrial.output}</pre><CopyButton text={shownTrial.output} label="复制试生成结果" onError={setError}/></>:<p className="style-empty">尚未试生成</p>}</article><article><h3>对照已保存结果</h3><select aria-label="选择旧试生成结果" value={comparison?.id||''} onChange={e=>setCompareId(e.target.value)}><option value="">选择历史结果</option>{savedTrials.filter(t=>t.id!==shownTrial?.id).map(t=><option key={t.id} value={t.id}>v{t.snapshot.version} · {new Date(t.at).toLocaleString()}</option>)}</select>{comparison?<><p className="field-hint">{comparison.model} · 规则 v{comparison.snapshot.version}</p><details><summary>当时测试素材</summary><pre>{comparison.material}</pre></details><pre>{comparison.output}</pre></>:<p className="style-empty">暂无可对照的旧结果</p>}</article></div></section>}
        {tab==='versions'&&<section className="style-versions"><p className="field-hint">恢复会新增草稿版本，保留调整历史；启用后仅用于后续任务。原始内置 v1 始终保留。</p>{[...record.versions].reverse().map(v=><article key={v.snapshot.versionId}><div><h3>v{v.snapshot.version} · {v.reason}</h3><p>{new Date(v.createdAt).toLocaleString()} {record.activeVersionId===v.snapshot.versionId?' · 当前启用':''}{record.draftVersionId===v.snapshot.versionId?' · 当前草稿':''}</p></div><div className="style-actions"><CopyButton text={fullRulePackage(v.snapshot)} label={`复制 v${v.snapshot.version} 完整规则`} onError={setError}/><button type="button" className="secondary-button" disabled={busy||dirty} onClick={()=>{if(window.confirm('将此历史版本复制为新草稿？现有历史记录和当前启用版本都会保留。'))void action({action:'restore',id:record.id,revision:record.revision,versionId:v.snapshot.versionId},'已恢复为新的草稿版本。试生成后可主动启用。');}}>{record.builtin&&v.snapshot.version===1?'恢复内置默认为草稿':'恢复为新草稿'}</button></div><details><summary>查看此版本规则</summary><pre>{fullRulePackage(v.snapshot)}</pre></details></article>)}</section>}
        {tab==='preview'&&<section className="style-full-preview"><p className="field-hint">预览直接来自当前表单{dirty?'（尚未保存）':''}，与生成时使用的规则数据一致。各任务只加载相应栏目的规则，未修改其他栏目。</p><CopyButton text={fullRulePackage(snapshot)} label="复制完整规则包" onError={setError}/><pre>{fullRulePackage(snapshot)}</pre></section>}
      </>}
    </section></div>
    {confirmation&&<VideoDialog title={confirmation.operation==='delete'?'删除写作风格':'启用风格版本'} onClose={()=>setConfirmation(null)}>
      {confirmation.operation==='delete'
        ?<p>删除「{confirmation.version.snapshot.content.name}」及其规则版本和试生成记录？此操作无法撤回。已有笔记和已确认的提示词保留原规则。{confirmation.unsaved&&'未保存的编辑也会丢失。'}</p>
        :<p>启用「{confirmation.version.snapshot.content.name}」v{confirmation.version.snapshot.version} 用于后续创作？{confirmation.version.importReview&&'请先核对导入依赖和冲突提示。'}</p>}
      <div className="style-confirm-actions"><button type="button" className="secondary-button" onClick={()=>setConfirmation(null)}>取消</button><button type="button" className="generate-button" onClick={confirmChange}>{confirmation.operation==='delete'?'确认删除':'确认启用'}</button></div>
    </VideoDialog>}
  </main></AppShell>;
}

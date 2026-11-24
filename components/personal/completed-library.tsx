"use client";
/* eslint-disable @next/next/no-img-element -- Private Blob previews are created locally and released. */
import { isTitleWithinLimit } from "@/lib/xhs-title";
import { useEffect,useMemo,useRef,useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft,CheckCheck,FileText } from 'lucide-react';
import { AppShell } from '../app-shell';
import { personalCaptionText } from "@/lib/personal/captions";
import { CopyButton } from '../copy-button';
import { useCloud } from '../cloud/context';
import { getCloudThumbnail,makeCloudPersonalStore } from '@/lib/cloud/store';
import { personalLocalStore } from '@/lib/personal/store';
import { usePersonalWorkspace } from '@/lib/personal/use-workspace';
import type { CompletedNote,CompletedSummary } from '@/lib/personal/completed';
import { hydratePersonalDraft,type PersonalDraft } from '@/lib/personal/drafts';
import { analyzeHashtags,formatHashtags } from '@/lib/format';
import { formatPersonalAll,formatPersonalBodyAndTags,plainPersonalBody } from '@/lib/personal/note-format';
import { fullRulePackage } from '@/lib/personal/style-rules';
import { rewriteLabels } from '@/components/rewrite/result';
import { CREATION_TYPE_LABELS } from '@/lib/schema';
import { personalLengthLabel } from '@/lib/personal/presentation';
import { ResearchInfo } from './research-info';
import './completed-library.css';
import './research-info.css';

function time(value:string){return new Date(value).toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'short'});}
function Thumbnail({row,userId,cloud}:{row:CompletedSummary;userId:string;cloud:boolean}){
 const [url,setUrl]=useState(''),[failed,setFailed]=useState(false);
 useEffect(()=>{let live=true,url='';const blob=cloud&&row.thumbnailId?getCloudThumbnail(userId,row.thumbnailId):Promise.resolve(row.thumbnail);void blob.then(value=>{if(live&&value){url=URL.createObjectURL(value);setUrl(url);}}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;if(url)URL.revokeObjectURL(url);};},[row.thumbnail,row.thumbnailId,userId,cloud]);
 if(!row.imageCount)return null;
 return <div className="completed-thumb">{url?<img src={url} alt={`${row.name}的第一张图片`}/>:<span>{failed?'缩略图暂不可用':'图片读取中'}</span>}<small>{row.imageCount} 张</small></div>;
}
export function CompletedLibrary({noteId}:{noteId?:string}){
 const router=useRouter(),{cloud,user}=useCloud(),userId=user?.id??'',workspace=usePersonalWorkspace();
 const store=useMemo(()=>cloud?makeCloudPersonalStore(userId):personalLocalStore,[cloud,userId]);
 const [rows,setRows]=useState<CompletedSummary[]>([]),[note,setNote]=useState<CompletedNote|null>(null),[view,setView]=useState<PersonalDraft|null>(null),[search,setSearch]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[warning,setWarning]=useState(''),[feedback,setFeedback]=useState(''),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false);
 const locked=useRef(false);
 useEffect(()=>{let live=true;const urls:string[]=[];async function read(){try{if(noteId){const n=await store.getCompleted(noteId),d=await hydratePersonalDraft(n.snapshot);d.images.forEach(i=>urls.push(i.preview));if(!live){urls.forEach(u=>URL.revokeObjectURL(u));return;}setNote(n);setView(d);}else{const list=await store.listCompleted();if(live){setRows(list.notes);if(list.hiddenDamaged)setWarning(`${list.hiddenDamaged} 条记录损坏或不兼容，已跳过，原记录未更改。`);}}}catch{if(live)setError('无法读取已完成笔记，请检查网络或浏览器存储后重试。原记录没有被更改。');}finally{if(live)setLoading(false);}}void read();return()=>{live=false;urls.forEach(u=>URL.revokeObjectURL(u));};},[store,noteId,retry]);
 const disabled=busy||workspace.switching||!workspace.draft;
 async function navigate(path:string){if(disabled||locked.current)return;locked.current=true;setBusy(true);if(!await workspace.navigateSafely(()=>router.push(path))){locked.current=false;setBusy(false);}}
 async function continueNote(id:string){if(disabled||locked.current)return;locked.current=true;setBusy(true);setError('');try{const n=note?.id===id?note:await store.getCompleted(id);if(await workspace.continueNote(n)){router.push('/personal');return;}}catch{setError('暂时无法创建继续编辑的草稿，原笔记和当前草稿均保留，请重试。');}locked.current=false;setBusy(false);}
 async function copyRow(id:string){if(locked.current)return;locked.current=true;setBusy(true);setError('');try{const n=await store.getCompleted(id);await navigator.clipboard.writeText(formatPersonalBodyAndTags(n.snapshot.generation!.result));setFeedback('正文与话题已复制');}catch{setError('复制未完成，请打开详情后重试复制。笔记仍保留。');}finally{locked.current=false;setBusy(false);}}
 const r=view?.generation?.result,filtered=rows.filter(row=>row.searchText.includes(search.trim().toLocaleLowerCase()));
 return <AppShell disabled={disabled} navigateSafely={workspace.navigateSafely}><div className="personal-completed">
  <header className="completed-topbar"><div><h1>已完成笔记</h1><p>保存满意的版本，随时回来查看。</p></div><button className="secondary-button" disabled={disabled} onClick={()=>void navigate('/personal')}><ArrowLeft size={15}/>返回个人创作</button></header>
  <main className="completed-main">
   <p className="completed-storage-note">{cloud?'保存在当前账号，仅你可见，可跨设备查看。':'保存在当前设备的浏览器中；清除站点数据会丢失，不支持跨设备同步。'} 继续创作会新建草稿，原笔记不变。</p>
   {(error||workspace.storageError)&&<p className="storage-error" role="alert">{error||workspace.storageError}<button className="text-button" onClick={()=>{if(workspace.storageError)void workspace.save();else {setLoading(true);setError('');setRetry(x=>x+1);}}}>重试</button></p>}
   {warning&&<p className="storage-warning" role="status">{warning}</p>}{feedback&&<p className="completed-feedback" role="status">{feedback}</p>}
   {loading?<p role="status">正在读取已完成笔记…</p>:!noteId?<>
    <label className="completed-search">搜索笔记<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="搜索名称或内容关键词"/></label>
    <p className="completed-list-caption">按保存时间倒序</p>
    <div className="completed-list">{filtered.map(row=><article className="completed-row" key={row.id}>
     <Thumbnail row={row} userId={userId} cloud={cloud}/><div className="completed-row-content"><h2><button onClick={()=>void navigate(`/personal/completed/${row.id}`)} disabled={disabled}>{row.name}</button></h2><time dateTime={row.savedAt}>{time(row.savedAt)}</time><p className="completed-excerpt">{row.excerpt}</p><div className="completed-actions"><button className="text-button" disabled={disabled} onClick={()=>void navigate(`/personal/completed/${row.id}`)}>查看详情</button><button className="text-button" disabled={disabled} onClick={()=>void copyRow(row.id)}>复制正文与话题</button><button className="text-button" disabled={disabled} onClick={()=>void continueNote(row.id)}>继续创作</button></div></div>
    </article>)}</div>
    {!filtered.length&&<div className="completed-empty"><FileText size={30}/><h2>{search?'没有找到匹配的笔记':'还没有已完成笔记'}</h2><p>{search?'换一个名称或内容关键词试试。':'在个人创作第三步点击“保存并写下一篇”，满意的笔记会出现在这里。'}</p></div>}
   </>:note&&view&&r?<>
    <div className="completed-heading"><button className="text-button" disabled={disabled} onClick={()=>void navigate('/personal/completed')}>← 全部已完成笔记</button><div className="completed-name"><h2>{view.name}</h2><span><CheckCheck size={14}/>已完成</span></div><time dateTime={note.savedAt}>保存于 {time(note.savedAt)}</time></div>
    <article className="completed-detail">
     <div className="completed-section-heading"><h3>正文</h3><CopyButton text={plainPersonalBody(r.body)} label="复制正文" onError={setError}/></div><p className="completed-body">{r.body}</p>
     <div className="completed-section-heading"><h3>话题 · {analyzeHashtags(r.hashtags).count} 个</h3><CopyButton text={formatHashtags(r.hashtags)} label="复制话题" onError={setError}/></div><p className="completed-tags">{formatHashtags(r.hashtags)}</p>
     {!!view.resultImages.length&&<><h3 className="completed-image-heading">对应图片 · {view.resultImages.length} 张</h3><div className="completed-images">{view.resultImages.map((im,i)=><figure key={im.id}><img src={im.preview} alt={`完成笔记对应图片 ${i+1}`}/><figcaption>图片 {i+1}</figcaption></figure>)}</div></>}
     <details><summary>标题备选 · {r.titles.length} 个</summary>{!r.titles.every(isTitleWithinLimit)&&<p>部分旧标题超过 20 字，可在「继续创作」中缩短后复制。</p>}<ol className="completed-titles">{r.titles.map((title,i)=><li key={i}><span>{title}</span><CopyButton text={title} disabled={!isTitleWithinLimit(title)} label={`复制标题 ${i+1}`} onError={setError}/></li>)}</ol></details>
     <details><summary>封面文案</summary><p className="completed-preserve">{r.coverCopy.headline}{'\n'}{r.coverCopy.subline}</p><CopyButton text={`${r.coverCopy.headline}\n${r.coverCopy.subline}`} label="复制封面" onError={setError}/></details>
     {!!r.imageCaptions.length&&<details><summary>逐图配文 · {r.imageCaptions.length} 张</summary>{r.imageCaptions.map((c,i)=><section className="completed-caption" key={c.imageId}>{view.resultImages.find(im=>im.id===c.imageId)&&<img src={view.resultImages.find(im=>im.id===c.imageId)!.preview} alt={`配文对应图片 ${i+1}`}/>}<div>{c.headline&&<h3>{c.headline}</h3>}<p className="completed-preserve">{c.description}</p><CopyButton text={personalCaptionText(c)} label={`复制图片 ${i+1} 配文`} onError={setError}/></div></section>)}</details>}
     <details><summary>原始输入与创作设置</summary><dl className="completed-basis"><dt>主题</dt><dd>{view.input.topic||'未填写'}</dd><dt>经历与素材</dt><dd>{view.input.experience}</dd><dt>核心感受</dt><dd>{view.input.coreIntent||'未填写'}</dd><dt>风格</dt><dd>{view.input.styles.map(s=>(view.input.ruleSnapshot?.styleId===s?view.input.ruleSnapshot.content.name:CREATION_TYPE_LABELS[s as keyof typeof CREATION_TYPE_LABELS]||"自定义风格")).join(' · ')}{view.input.customStyle&&` · ${view.input.customStyle}`}</dd><dt>真实性与篇幅</dt><dd>{view.input.truth==='truthful'?'真实润色':'创意发挥'} · {personalLengthLabel(view.input)}</dd><dt>补充要求</dt><dd>{view.input.requirements||'未填写'}</dd><dt>参考文案</dt><dd>{view.input.referenceText||'未填写'}</dd><dt>参考方式</dt><dd>{view.input.referenceAspects.map(s=>({tone:'语气',structure:'结构',opening:'开头',rhythm:'节奏',imageCopy:'图上文字'})[s]).join(' · ')||'未选择'}</dd><dt>检索设置</dt><dd>{view.input.search?'开启':'关闭'}{view.input.searchPlace&&` · ${view.input.searchPlace}`}</dd></dl></details>
     {view.input.ruleSnapshot&&<details><summary>原笔记规则 · {view.input.ruleSnapshot.content.name} · v{view.input.ruleSnapshot.version}</summary><p className="completed-preserve">{fullRulePackage(view.input.ruleSnapshot)}</p><CopyButton text={fullRulePackage(view.input.ruleSnapshot)} label="复制原笔记规则" onError={setError}/></details>}
     {!!view.generatedInput?.rewrites?.length&&<details><summary>已采用的局部重写依据 · {view.generatedInput.rewrites.length} 次</summary>{view.generatedInput.rewrites.map((entry,i)=><section key={i}><h3>{rewriteLabels[entry.target as keyof typeof rewriteLabels]||'局部重写'} · {time(entry.at)}</h3><p>{entry.input.ruleSnapshot?.content.name} · v{entry.input.ruleSnapshot?.version}</p><p className="completed-preserve">{entry.confirmedPrompt}</p>{entry.input.ruleSnapshot&&<CopyButton text={fullRulePackage(entry.input.ruleSnapshot)} label={`复制第 ${i+1} 次重写规则`} onError={setError}/>}</section>)}</details>}
     <details><summary>完整确认提示词</summary><p className="completed-preserve">{view.prompt}</p><CopyButton text={view.prompt} label="复制提示词" onError={setError}/></details>
     <ResearchInfo compact research={view.generatedInput?.research??null} title="这份笔记保存的参考来源"/>
     {!!r.warnings.length&&<details><summary>需要核实的信息 · {r.warnings.length} 条</summary><ul>{r.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
    </article>
    <div className="completed-bottom"><CopyButton text={formatPersonalBodyAndTags(r)} label="复制正文与话题" onError={setError}/><CopyButton text={formatPersonalAll(r)} disabled={!r.titles.every(isTitleWithinLimit)} label="复制全部文案" onError={setError}/><button className="generate-button" disabled={disabled} onClick={()=>void continueNote(note.id)}>{busy?'正在处理…':'继续创作'}</button></div>
   </>:null}
  </main>
 </div></AppShell>;
}

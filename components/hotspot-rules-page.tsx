"use client";
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Save, Settings2, Trash2, Sparkles, LoaderCircle } from 'lucide-react';
import { AppShell } from './app-shell';
import { AiUsageStatus, useAiTask } from './ai/usage-status';
import { aiSourceHeader } from '@/lib/ai-source';
import { DEFAULT_XHS_RULES, categoryIds, enabledCategoryIds, categoryName, effectiveRules, themeInteractionFloor, executionSchema, formatXhsRuleIssues, XHS_SORTS, xhsRulesSchema, type XhsRules, type XhsRulesVersion, type XhsCategoryRule } from '@/lib/xhs-hotspot-rules';
import { changedRuleFields, editableRuleFields, ruleFieldValue } from '@/lib/xhs-rule-draft';
import type { RuleDemandIntent } from '@/lib/xhs-rule-demand';
import type { XhsRankingDiagnostics } from '@/lib/xhs-hotspots';
import styles from '@/app/hotspots/rules/rules.module.css';
type RuleRow = { name: string; terms: string };
type Preview = { category: string; noteCount: number; previous: number; count: number; singles: number; diagnostics: XhsRankingDiagnostics; themes: { title: string; heat: number; notes: number; authors: number }[] }[];
type Proposal = { categoryRules: XhsCategoryRule; explanation: string[]; assumptions: string[]; intent: RuleDemandIntent; warnings: string[]; unchangedReason: string; model: string };
const words = (value: string) => value.split(/[\n,，、]/).map(v => v.trim()).filter(Boolean);
const toRows = (rows: { name: string; terms: string[] }[]) => rows.map(r => ({ name: r.name, terms: r.terms.join('、') }));
const fieldLabels: Record<string, string> = { queries: '搜索词及优先级', includeTerms: '相关内容词', topics: '主题与同义表达', requireDestination: '增加地点细分主题', minInteractions: '单篇热门参考最低互动', minThemeInteractions: '主题最低总互动', overlapPercent: '重复主题重叠阈值（%）', minNotes: '主题最少笔记', minAuthors: '主题最少作者', 'settings.windowDays': '发布时间窗口', 'settings.topicLimit': '主题数量', 'settings.representatives': '代表笔记数量', 'settings.searchSorts': '搜索排序', 'settings.weights': '互动权重', 'settings.candidateBudget': '候选预算', 'settings.detailBudget': '详情预算', 'settings.cardsPerQuery': '每批候选数', 'settings.scrollsPerQuery': '追加加载批数', 'settings.maxMinutes': '最长检索时间', 'settings.noNewRounds': '无新增停止轮数', 'settings.cacheMinutes': '互动缓存时效', 'settings.autoUpdate': '每日自动更新', 'settings.retryMinutes': '失败重试间隔', 'settings.excludeTerms': '排除词', 'settings.broadTopics': '宽泛主题', 'settings.genericTags': '泛标签', 'settings.destinations': '地点与别名' };
function readable(value: unknown): string {
 if (value == null) return '未设置';
 if (typeof value === 'boolean') return value ? '开启' : '关闭';
 if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v ? `${v.name}：${v.terms?.join('、') || ''}` : XHS_SORTS[v as keyof typeof XHS_SORTS] || String(v)).join('；') || '无';
 if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${({ likes: '赞', collects: '藏', comments: '评' } as Record<string,string>)[k] || k} ${v}`).join(' / ');
 return String(value);
}
async function responseJson(response: Response) { const data = await response.json().catch(() => null); if (!response.ok) throw new Error(data?.error?.message || '操作失败，输入和已有规则保留。'); return data; }
function RowEditor({ label, rows, max, onChange }: { label: string; rows: RuleRow[]; max: number; onChange: (rows: RuleRow[]) => void }) {
  function move(index: number, direction: number) {
    const next = [...rows]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange(next);
  }
  return <div className={styles.rows}>
    {rows.map((row, index) => <div className={styles.ruleRow} key={index}>
      <label><span>{label} {index + 1}</span><input aria-label={`${label} ${index + 1} 名称`} value={row.name} maxLength={40} onChange={e => onChange(rows.map((r, i) => i === index ? { ...r, name: e.target.value } : r))}/></label>
      <label><span>触发词</span><textarea aria-label={`${label} ${index + 1} 触发词`} rows={2} value={row.terms} onChange={e => onChange(rows.map((r, i) => i === index ? { ...r, terms: e.target.value } : r))}/></label>
      <div className={styles.rowActions}><button type="button" aria-label={`上移${label} ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16}/></button><button type="button" aria-label={`下移${label} ${index + 1}`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16}/></button><button type="button" aria-label={`删除${label} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={16}/></button></div>
    </div>)}
    <button type="button" disabled={rows.length >= max} onClick={() => onChange([...rows, { name: "", terms: "" }])}><Plus size={15}/> 添加{label}</button><small>已配置 {rows.length} / {max} 条；靠上的规则优先匹配。</small>
  </div>;
}
export function HotspotRulesPage() {
 const router = useRouter(), aiTask = useAiTask();
 const [saved, setSaved] = useState<XhsRulesVersion | null>(null), [draft, setDraft] = useState<XhsRules | null>(null);
 const [category, setCategory] = useState('travel'), [newName, setNewName] = useState('');
 const [busy, setBusy] = useState<string | null>('load'), [error, setError] = useState(''), [message, setMessage] = useState('');
 const [proposal, setProposal] = useState<Proposal | null>(null), [preview, setPreview] = useState<Preview | null>(null);
 const [buffers, setBuffers] = useState<Record<string, string>>({}), [rows, setRows] = useState<Record<string, RuleRow[]>>({});
 const proposalHeading = useRef<HTMLHeadingElement>(null);
 const active = useRef(true), running = useRef(false), abort = useRef<AbortController | null>(null);
 const changed = Boolean(saved && draft && JSON.stringify(saved.rules) !== JSON.stringify(draft));
 useEffect(() => { active.current = true; const controller = new AbortController();
  void fetch('/api/hotspots/rules', { cache: 'no-store', signal: controller.signal }).then(responseJson).then(value => { if (active.current) { setSaved(value); setDraft(value.rules); setCategory(categoryIds(value.rules)[0] || categoryIds(value.rules, true)[0]); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (active.current) setBusy(null); });
  return () => { active.current = false; controller.abort(); abort.current?.abort(); };
 }, []);
 useEffect(() => { if (!changed) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [changed]);
 useEffect(()=>{if(proposal){proposalHeading.current?.focus({preventScroll:true});proposalHeading.current?.scrollIntoView({block:'start',behavior:'instant'});}},[proposal]);
 function guard(next: () => void) { if (!changed || window.confirm('有未保存规则，确定放弃修改并离开？')) next(); }
 function edit(next: XhsRules) { setDraft(next); setPreview(null); setProposal(null); setError(''); setMessage(''); }
 function editCategory(patch: Partial<XhsCategoryRule>) { if (draft) edit({ ...draft, categories: { ...draft.categories, [category]: { ...draft.categories[category], ...patch } } }); }
 function editSettings(patch: XhsCategoryRule['settings']) { editCategory({ settings: { ...draft!.categories[category].settings, ...patch } }); }
 function clearBuffers() { setBuffers({}); setRows({}); }
 function select(id: string) { setCategory(id); setProposal(null); setPreview(null); setError(''); }
 function addCategory() {
  const name = newName.trim(); if (!draft || !name) return;
  if (Object.keys(draft.categories).length >= 30) { setError('分类最多 30 个（含归档）。'); return; }
  const id = `cat-${crypto.randomUUID().slice(0, 12)}`;
  const c: XhsCategoryRule = { name, enabled: true, archived: false, order: Object.keys(draft.categories).length, demand: '', queries: [name], includeTerms: [name], topics: [], minInteractions: 1000, minNotes: 2, minAuthors: 2, requireDestination: false, settings: { ...executionSchema.parse(effectiveRules(draft, category)), autoUpdate: false }, semantic: { enabled: false, profileId: '', maxCalls: 0 } };
  edit({ ...draft, categories: { ...draft.categories, [id]: c } }); setCategory(id); setNewName('');
 }
 function moveCategory(id: string, delta: number) { if (!draft) return; const ids = categoryIds(draft), at = ids.indexOf(id), to = at + delta; if (to < 0 || to >= ids.length) return; [ids[at], ids[to]] = [ids[to], ids[at]]; edit({ ...draft, categories: Object.fromEntries(Object.entries(draft.categories).map(([k, c]) => [k, { ...c, order: ids.includes(k) ? ids.indexOf(k) : c.order }])) }); }
 async function submit(action: 'save' | 'preview', updateIds?: string[]) {
  if (!draft || !saved || running.current) return;
  if (proposal) { setError('请先应用草案，或选择保留原规则，再保存或检索。'); proposalHeading.current?.focus(); return; }
  const parsed = xhsRulesSchema.safeParse(draft); if (!parsed.success) { setError(formatXhsRuleIssues(parsed.error.issues)); return; }
  running.current = true; setBusy(action); setError(''); setMessage('');
  try {
   const value = await responseJson(await fetch('/api/hotspots/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, rules: parsed.data, revision: saved.revision }), signal: AbortSignal.timeout(30_000) }));
   if (!active.current) return;
   if (action === 'preview') setPreview(value.preview);
   else { setSaved(value); setDraft(value.rules); setProposal(null); clearBuffers(); setMessage('规则已保存，从下次检索生效。');
    if (updateIds?.length) { const result = await responseJson(await fetch('/api/hotspots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', force: true, categories: updateIds }), signal: AbortSignal.timeout(30_000) })); if (active.current) setMessage(result.updating ? '已请求检索。返回今日热点可分批查看结果；同类已有任务仍使用原快照。' : '规则已保存，请返回今日热点查看结果。'); }
   }
  } catch (e) { if (active.current) setError(e instanceof Error ? e.message : '操作失败，编辑保留。'); }
  finally { running.current = false; if (active.current) setBusy(null); }
 }
 async function generate() {
  if (!draft || running.current) return;
  const parsed = xhsRulesSchema.safeParse(draft); if (!parsed.success) { setError(formatXhsRuleIssues(parsed.error.issues)); return; }
  const c = draft.categories[category]; if ((c.demand || '').trim().length < 5) { setError('请先描述想寻找的内容、范围和要求。'); return; }
  const ai = aiTask.start(); if (!ai.id || Boolean(ai.issue)) { setError(ai.issue); aiTask.finish(); return; }
  running.current = true; const controller = new AbortController(); abort.current = controller; setBusy('generate'); setError(''); setMessage(''); setProposal(null);
  try { const value = await responseJson(await fetch('/api/hotspots/rules/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...aiSourceHeader(ai.id) }, body: JSON.stringify({ rules: parsed.data, category, demand: c.demand, lockedFields: c.lockedFields || [] }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(190_000)]) })); if (active.current) setProposal(value); }
  catch (e) { if (active.current) setError(controller.signal.aborted ? '已取消生成，输入与原规则保留。' : e instanceof Error ? e.message : '生成失败。'); }
  finally { running.current = false; abort.current = null; aiTask.finish(); if (active.current) setBusy(null); }
 }
 const c = draft?.categories[category], effective = draft ? effectiveRules(draft, category) : null;
 const ids = draft ? categoryIds(draft) : [], allIds = draft ? categoryIds(draft, true) : [];
 function termsField(key: string, label: string, values: string[], change: (values: string[]) => void, help?: string) {
  const id = `${category}:${key}`;
  return <label className={styles.field}><span>{label}</span><textarea rows={4} value={buffers[id] ?? values.join('\n')} onChange={e => { setBuffers(b => ({ ...b, [id]: e.target.value })); change(words(e.target.value)); }}/>{help && <small>{help}</small>}</label>;
 }
 function rowField(key: 'topics' | 'destinations', label: string, values: { name: string; terms: string[] }[], change: (values: { name: string; terms: string[] }[]) => void) {
  const id = `${category}:${key}`;
  return <RowEditor label={label} rows={rows[id] ?? toRows(values)} max={key === 'topics' ? 60 : 100} onChange={value => { setRows(r => ({ ...r, [id]: value })); change(value.map(r => ({ name: r.name, terms: words(r.terms) }))); }}/>;
 }
 function number(key: keyof XhsRules, label: string, min: number, max: number, help?: string) {
  return <label className={styles.field}><span>{label}</span><input type="number" min={min} max={max} step={1} value={Number(effective?.[key] ?? min)} onChange={e => editSettings({ [key]: Number(e.target.value) })}/>{help && <small>{help}</small>}</label>;
 }
 const proposedRules = draft && proposal ? { ...draft, categories: { ...draft.categories, [category]: proposal.categoryRules } } : null;
 const diffs = draft && proposedRules ? changedRuleFields(draft, proposedRules, category) : [];
 return <AppShell disabled={Boolean(busy)} guardNavigation={guard}><main className={styles.page}>
  <button className={styles.back} onClick={() => guard(() => router.push('/hotspots'))} disabled={Boolean(busy)}><ArrowLeft size={15}/> 返回今日热点</button>
  <header className={styles.header}><div className={styles.eyebrow}><Settings2 size={15}/> 今日热点 · 管理</div><h1>热点规则管理</h1><p>说清想找什么，再决定搜索范围与判断标准。</p></header>
  {error && <p className={styles.error} role="alert">{error}</p>}{message && <p className={styles.success} role="status">{message}</p>}
  {busy === 'generate' && <div className={styles.generationStatus} role="status"><LoaderCircle size={16} className="spin"/>正在生成并检查需求覆盖…<button type="button" onClick={() => abort.current?.abort()}>取消生成</button></div>}
  {!draft || !c || !effective ? <p>{busy ? '正在读取规则…' : '规则未能载入，请刷新页面重试。'}</p> : <form onSubmit={e => { e.preventDefault(); void submit('save'); }}><fieldset className={styles.form} disabled={Boolean(busy)}>
   <section className={styles.card} aria-labelledby="categories-title"><div className={styles.sectionHeading}><div><h2 id="categories-title">我的分类</h2><p>独立保存需求与规则，可单独检索。</p></div></div>
    <div className={styles.tabs} role="tablist" aria-label="规则分类">{ids.map((id,index) => <button type="button" key={id} id={`rules-tab-${id}`} role="tab" aria-selected={id === category} tabIndex={id===category?0:-1} onClick={() => select(id)} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?ids.length-1:(index+(event.key==="ArrowRight"?1:ids.length-1))%ids.length;select(ids[next]);document.getElementById(`rules-tab-${ids[next]}`)?.focus();}}}>{categoryName(draft, id)}{draft.categories[id].enabled === false && <small>已停用</small>}</button>)}</div>
    <details className={styles.details}><summary>管理分类 · 新增、排序与归档</summary><div className={styles.addCategory}><label className={styles.field}><span>新分类名称</span><input value={newName} maxLength={30} onChange={e => setNewName(e.target.value)} placeholder="例如：家居收纳"/></label><button type="button" onClick={addCategory} disabled={!newName.trim()}><Plus size={15}/>新增分类</button></div>
     <div className={styles.categoryManager}>{ids.map((id, i) => <div key={id}><span>{categoryName(draft, id)}</span><button type="button" aria-label={`上移${categoryName(draft,id)}`} disabled={!i} onClick={() => moveCategory(id,-1)}><ArrowUp size={14}/></button><button type="button" aria-label={`下移${categoryName(draft,id)}`} disabled={i===ids.length-1} onClick={() => moveCategory(id,1)}><ArrowDown size={14}/></button></div>)}</div>
     {allIds.filter(id => draft.categories[id].archived).map(id => <div className={styles.archivedRow} key={id}><span>{categoryName(draft,id)} · 已归档</span><button type="button" onClick={() => { edit({ ...draft, categories: { ...draft.categories, [id]: { ...draft.categories[id], archived:false, enabled:false } } }); select(id); }}>恢复分类</button></div>)}
    </details>
    <div className={styles.categoryIdentity}><label className={styles.field}><span>当前分类名称</span><input value={c.name ?? categoryName(draft,category)} maxLength={30} onChange={e => editCategory({ name:e.target.value })}/></label><label className={styles.checkbox}><input type="checkbox" checked={c.enabled !== false} onChange={e => editCategory({enabled:e.target.checked})}/>启用检索</label><button type="button" disabled={c.archived} onClick={() => { editCategory({archived:true,enabled:false}); const next=ids.find(id=>id!==category);if(next)select(next); }}>归档分类</button></div><p className={styles.help}>归档后从热点页移除，规则、榜单和拆解保留，可随时恢复。所有修改保存后生效。</p>
   </section>
   <section className={`${styles.card} ${styles.demandCard}`} aria-labelledby="demand-title"><h2 id="demand-title">按需求生成规则</h2><label className={styles.field}><span>这次想找什么热点？</span><textarea rows={4} maxLength={4000} value={c.demand || ''} onChange={e => editCategory({demand:e.target.value})} placeholder="例如：找近30天新疆冬季旅行的热门主题，关注赏雪、自驾与保暖准备，不要旅行社广告。选10个主题，每个附代表笔记。"/></label>
    <div className={styles.demandActions}><button type="button" className={styles.primary} onClick={() => void generate()}><Sparkles size={15}/>生成规则草案</button><span>根据需求调整搜索词和相关规则；先查看差异，再应用到表单。</span></div><AiUsageStatus task={aiTask}/><p className={styles.help}>生成后会检查需求覆盖，遗漏时自动纠正一次。锁定的字段保留原值。</p>
    <details className={styles.details}><summary>锁定字段 · 生成时保留我的设置（{c.lockedFields?.length || 0}）</summary><div className={styles.lockGrid}>{editableRuleFields.map(key => <label key={key} className={styles.checkbox}><input type="checkbox" checked={c.lockedFields?.includes(key) || false} onChange={e => editCategory({lockedFields:e.target.checked ? [...(c.lockedFields || []),key] : (c.lockedFields || []).filter(k=>k!==key)})}/>{fieldLabels[key] || key}</label>)}</div></details>
   </section>
   {proposal && proposedRules && <section className={styles.card} aria-labelledby="proposal-title">
    <h2 id="proposal-title" ref={proposalHeading} tabIndex={-1}>{diffs.length ? '规则草案 · 尚未应用' : '规则检查 · 没有字段变化'}</h2>
    <p className={styles.intentSummary}>{proposal.intent.summary}</p>
    <div className={styles.keywordDiffs}>{(['queries','includeTerms'] as const).map(key=><div key={key}><h3>{key==='queries'?'搜索词':'内容相关词'}<small>{diffs.includes(key)?'将更新':c.lockedFields?.includes(key)?'已锁定':'保持不变'}</small></h3><span>当前</span><p>{readable(ruleFieldValue(draft,category,key))}</p><span>草案</span><p className={styles.proposedKeywords}>{readable(ruleFieldValue(proposedRules,category,key))}</p></div>)}</div>
    {proposal.warnings.length>0&&<div className={styles.notice} role="status"><strong>部分需求受锁定限制</strong><ul>{proposal.warnings.map((v,i)=><li key={i}>{v}</li>)}</ul></div>}
    <ul className={styles.explanation}>{proposal.explanation.map((v,i)=><li key={i}>{v}</li>)}</ul>
    {proposal.assumptions.length>0&&<div className={styles.notice}><strong>需要留意的建议值</strong><ul>{proposal.assumptions.map((v,i)=><li key={i}>{v}</li>)}</ul></div>}
    {diffs.some(key=>!['queries','includeTerms'].includes(key))&&<details className={styles.details}><summary>其他规则变化（{diffs.filter(key=>!['queries','includeTerms'].includes(key)).length}）</summary><div className={styles.diffList}>{diffs.filter(key=>!['queries','includeTerms'].includes(key)).map(key=><div key={key}><strong>{fieldLabels[key]}</strong><span>当前：{readable(ruleFieldValue(draft,category,key))}</span><p>草案：{readable(ruleFieldValue(proposedRules,category,key))}</p></div>)}</div></details>}
    {!diffs.length&&<p className={styles.notice}>{proposal.unchangedReason}</p>}
    <p className={styles.help}>{diffs.length?`共 ${diffs.length} 项变化。应用后，下方表单才会更新；保存后用于检索。`:'没有可应用的修改。可以保留原规则，或调整需求后重新生成。'}</p>
    <div className={styles.buttons}><button type="button" className={styles.primary} disabled={!diffs.length} onClick={()=>{editCategory(proposal.categoryRules);clearBuffers();setMessage('草案已应用到下方表单，保存后用于检索。');}}>应用到下方规则</button><button type="button" onClick={()=>setProposal(null)}>保留原规则</button></div><p className={styles.help}>模型：{proposal.model}。锁定字段、分类名称和 AI 归并开关保持不变。</p>
   </section>}
   <section className={styles.card} aria-labelledby="criteria-title"><h2 id="criteria-title">范围与热度</h2><div className={styles.fields}>{number('windowDays','发布时间窗口（天）',1,30)}{number('topicLimit','主题数量上限',5,20,'每次至少提供 5 个选题，区分达标热点与待验证选题；旧上限低于 5 时按 5 执行。')}{number('representatives','每主题代表笔记',1,5)}</div><div className={styles.fields}>{(['minInteractions','minNotes','minAuthors'] as const).map(key=><label key={key} className={styles.field}><span>{fieldLabels[key]}</span><input type="number" min={key==='minInteractions'?1:2} max={key==='minInteractions'?1_000_000_000:20} value={c[key]} onChange={e=>editCategory({[key]:Number(e.target.value)})}/></label>)}</div><div className={styles.fields}><label className={styles.field}><span>主题最低总互动</span><input type="number" min={1} max={20_000_000_000} value={themeInteractionFloor(c)} onChange={e=>editCategory({minThemeInteractions:Number(e.target.value)})}/><small>赞＋藏＋评；未单独设置时沿用单篇门槛 × 最少作者数。</small></label><label className={styles.field}><span>重复主题重叠阈值（%）</span><input type="number" min={50} max={100} value={c.overlapPercent ?? 80} onChange={e=>editCategory({overlapPercent:Number(e.target.value)})}/><small>同一关注点且新增作者不足时合并；不同内容角度分别保留。</small></label></div><p className={styles.help}>先归纳，再按主题整体互动和不同作者数量判断。单篇不必达到热门门槛；主题原始互动与加权热度均按每位作者各自最高一篇计算。</p>
    <details className={styles.details}><summary>互动权重</summary><div className={styles.weights}>{(['likes','collects','comments'] as const).map(key=><label key={key} className={styles.field}><span>{{likes:'点赞',collects:'收藏',comments:'评论'}[key]}</span><input type="number" min={0} max={10} value={effective.weights[key]} onChange={e=>editSettings({weights:{...effective.weights,[key]:Number(e.target.value)}})}/></label>)}</div></details>
   </section>
   <section className={styles.card} aria-labelledby="search-title"><h2 id="search-title">搜索与筛选</h2><div className={styles.categoryFields}>{termsField('queries','搜索词（按优先级）',c.queries,queries=>editCategory({queries}),'每行一个，最多10个。先核心范围，再细分方向；不足时在此范围内补搜。')}{termsField('includeTerms','内容相关词',c.includeTerms,includeTerms=>editCategory({includeTerms}),'检查标题、标签和正文；新分类独立匹配。')}</div><div className={styles.sortChoices}><strong>搜索排序</strong>{Object.entries(XHS_SORTS).map(([key,label])=><label className={styles.checkbox} key={key}><input type="checkbox" checked={effective.searchSorts.includes(key as keyof typeof XHS_SORTS)} onChange={e=>editSettings({searchSorts:e.target.checked?[...effective.searchSorts,key as keyof typeof XHS_SORTS]:effective.searchSorts.filter(k=>k!==key)})}/>{label}</label>)}</div><p className={styles.help}>先按首选排序查看最近一周（窗口更短则沿用窗口），再结合完整窗口的“最新”与所选排序；不足 5 个时穿插定向补搜，最终按原窗口核验发布时间。</p><details className={styles.details}><summary>排除内容与宽泛标签</summary><div className={styles.categoryFields}>{termsField('excludeTerms','排除词',effective.excludeTerms,excludeTerms=>editSettings({excludeTerms}))}{termsField('broadTopics','不作为主题的宽泛名称',effective.broadTopics,broadTopics=>editSettings({broadTopics}))}{termsField('genericTags','泛标签',effective.genericTags,genericTags=>editSettings({genericTags}))}</div></details>
   </section>
   <section className={styles.card} aria-labelledby="topic-title"><h2 id="topic-title">主题识别</h2><label className={styles.checkbox}><input type="checkbox" checked={c.requireDestination ?? category==='travel'} onChange={e=>editCategory({requireDestination:e.target.checked})}/>增加地点细分主题（共同方向仍保留）</label><label className={styles.checkbox}><input type="checkbox" checked={c.semantic?.enabled || false} onChange={e=>{if(e.target.checked&&(!aiTask.current.id || Boolean(aiTask.current.issue))){setError(aiTask.current.issue);return;}editCategory({semantic:{enabled:e.target.checked,profileId:aiTask.current.id || '',maxCalls:c.semantic?.maxCalls ?? 0}});}}/>使用 AI 语义归并（检索时调用模型）</label><p className={styles.help}>根据主要内容归纳具体主题与共同方向，每篇可有多个主题。0 表示不额外限制次数；仍受本轮采集范围、任务时限与服务商实际限制。关闭或失败时使用内容词表归类。</p>
    {c.semantic?.enabled&&<div className={styles.fields}><label className={styles.field}><span>每轮归并次数上限（0 表示不限）</span><input type="number" min={0} step={1} value={c.semantic.maxCalls} onChange={e=>editCategory({semantic:{...c.semantic!,maxCalls:Number(e.target.value)}})}/></label><div><AiUsageStatus task={aiTask}/><button type="button" disabled={(!aiTask.current.id || Boolean(aiTask.current.issue))} onClick={()=>editCategory({semantic:{...c.semantic!,profileId:aiTask.current.id || ''}})}>绑定当前配置</button>{c.semantic.profileId!==aiTask.current.id&&<p className={styles.help}>本类绑定的配置与当前选择不同。</p>}</div></div>}
    <details className={styles.details}><summary>主题方向与同义词（{c.topics.length}）</summary>{rowField('topics','主题',c.topics,topics=>editCategory({topics}))}</details><details className={styles.details}><summary>地点与别名（{effective.destinations.length}）</summary>{rowField('destinations','地点',effective.destinations,destinations=>editSettings({destinations}))}</details>
   </section>
   <section className={styles.card} aria-labelledby="budget-title"><h2 id="budget-title">检索预算与更新</h2><div className={styles.fields}>{number('candidateBudget','候选总预算',20,600)}{number('detailBudget','详情核验预算',10,200)}{number('maxMinutes','最长检索时间（分钟）',1,90)}</div><p className={styles.help}>先让每个关键词完成一小批基础搜索，再按新增价值轮流补搜；同时分配时间与核验机会。每次以至少 5 个选题为目标，优先检索达标热点；不足时用有真实笔记支撑的待验证选题补足，并说明未达到的门槛。检索继续争取 5 个达标热点，仍遵守总预算、时限、登录验证和主动停止；不编造来源或把待验证选题计作热点。</p><details className={styles.details}><summary>批次、缓存与自动更新</summary><div className={styles.fields}>{number('cardsPerQuery','每批新增候选数',5,60)}{number('scrollsPerQuery','每次搜索追加加载批数',0,12)}{number('noNewRounds','连续无新增停止轮数',1,5,'仅在已找到至少 5 个达标热点后生效；不足时继续检索至预算、时限或可用方向耗尽。')}{number('cacheMinutes','互动缓存时效（分钟）',0,1440,'0 表示每次重新核验；复用时保留真实采集时间。')}{number('retryMinutes','失败重试间隔（分钟）',5,180)}</div><label className={styles.checkbox}><input type="checkbox" checked={effective.autoUpdate} onChange={e=>editSettings({autoUpdate:e.target.checked})}/>本类每日自动更新</label></details>
   </section>
   {preview&&<section className={styles.card} aria-labelledby="preview-title"><h2 id="preview-title">已有笔记预览</h2><p className={styles.help}>只重算已保存笔记，不搜索、不调用 AI。复用适用的语义标签，其余按内容规则归纳；更多来源需重新检索。</p><div className={styles.previewGrid}>{preview.filter(v=>v.category===category).map(v=><div key={v.category}><h3>{categoryName(draft,v.category)}</h3><p>{v.noteCount} 篇已有笔记 · {v.previous} → {v.count} 个主题 · {v.singles} 篇单篇参考</p><p>低于单篇参考门槛但仍参与归纳 {v.diagnostics.lowInteraction} · 未识别共同主题 {v.diagnostics.noSpecificTopic}</p><ol>{v.themes.map(t=><li key={t.title}>{t.title}<small>{t.heat.toLocaleString()} 分 · {t.authors} 位作者</small></li>)}</ol>{v.diagnostics.rejectedThemes.map(t=><p key={t.title}>{t.title}：{t.reason}</p>)}</div>)}</div></section>}
   <p className={styles.help}>仅代表实际采集范围，不保证全站前十。编辑时间不充当发布时间；不自动放宽范围凑数。拆解仍由点击触发并保存复用。</p>
   <div className={styles.footer}><div><strong>{proposal?'请先处理规则草案':changed?'有未保存的修改':'规则已同步'}</strong><span>{proposal?'应用草案或保留原规则后，再保存和检索。':`当前：${categoryName(draft,category)}`}</span></div><div className={styles.buttons}><button type="button" disabled={Boolean(proposal)} onClick={()=>void submit('preview')}>预览已有笔记</button><button type="submit" disabled={Boolean(proposal)}><Save size={14}/>保存规则</button><button type="button" className={styles.primary} disabled={Boolean(proposal)||c.archived||c.enabled===false} onClick={()=>void submit('save',[category])}>保存并检索本类</button></div></div>
   <div className={styles.secondaryActions}><button type="button" onClick={()=>{const base=DEFAULT_XHS_RULES.categories[category] || {...DEFAULT_XHS_RULES.categories.daily,queries:[categoryName(draft,category)],includeTerms:[categoryName(draft,category)],topics:[]};editCategory({...base,settings:executionSchema.parse(effectiveRules(DEFAULT_XHS_RULES,category)),requireDestination:category==='travel'});clearBuffers();setMessage('本类默认规则已载入表单，保存后生效。');}}>还原本类默认规则</button><button type="button" disabled={Boolean(proposal)||!enabledCategoryIds(draft).length} onClick={()=>void submit('save',enabledCategoryIds(draft))}>保存并检索全部启用分类</button></div>
  </fieldset></form>}
 </main></AppShell>;
}

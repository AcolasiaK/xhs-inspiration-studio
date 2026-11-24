"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ChevronDown, ExternalLink, Flame, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { AiUsageStatus, useAiTask } from "./ai/usage-status";
import { SceneHeader } from "@/components/scene-header";
import { AppShell } from "./app-shell";
import { HotspotAnalysis } from "./hotspot-analysis";
import { HotspotSearchCoverage, NoteQuerySources } from "./hotspot-search-coverage";
import { hotspotScrollPanel } from "@/lib/hotspot-scroll";
import { HotspotCreateMenu } from "./hotspot-create-menu";
import { useCloud } from "./cloud/context";
import { makeCloudPersonalStore } from "@/lib/cloud/store";
import { personalLocalStore } from "@/lib/personal/store";
import { createPersonalHotspotStarter } from "@/lib/personal/hotspot-transfer";
import type { HotspotDestination } from "@/lib/hotspot-menu";
import { HOTSPOT_TRANSFER_KEY } from "@/lib/hotspot-transfer";
import { VIDEO_TRANSFER_KEY } from "@/lib/video/drafts";
import { aiSourceHeader } from "@/lib/ai-source";
import type { Hotspot, HotspotSuggestion as Suggestion } from "@/lib/server/hotspots-types";
import { beijingDate, isIngestAnalysis, XHS_ORDERING, type XhsCategory, type XhsHotspotState, type XhsNote, type XhsAnalysis } from "@/lib/xhs-hotspots";
import type { PublicConfig } from "@/lib/types";
import { DEFAULT_XHS_RULES, XHS_MIN_THEME_TARGET, describeXhsRules, categoryRulesSignature, categoryIds, enabledCategoryIds, categoryName, effectiveRules, themeSearchRules, themeInteractionFloor } from "@/lib/xhs-hotspot-rules";
import styles from "@/app/hotspots/hotspots.module.css";
import reader from "@/app/hotspots/analysis.module.css";

function displayTime(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function sourceLink(value: string): string | undefined {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "www.xiaohongshu.com" ? url.href : undefined; } catch { return undefined; }
}
function asHotspot(note: XhsNote): Hotspot {
  return { id: note.id, title: note.title, description: note.body.slice(0, 1800), url: note.url, source: "小红书代表笔记", publishedAt: note.publishedAt, collectedAt: note.collectedAt, rank: 1 };
}
async function jsonResponse(response: Response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error?.message || "热点服务暂时无法连接，请稍后重试。已有结果保留。");
  return value;
}
export function HotspotsPage({ config }: { config: PublicConfig }) {
  void config;
  const router = useRouter(), aiTask = useAiTask();
  const { cloud, user } = useCloud();
  const [selection, setSelection] = useState<{key:string;anchor:HTMLButtonElement;last:boolean;hotspot:Hotspot;suggestion?:Suggestion}|null>(null);
  const [creatingDestination, setCreatingDestination] = useState<HotspotDestination|null>(null);
  const menuId = useId(), creating = useRef(false), personalStarter = useRef(createPersonalHotspotStarter());
  const [creationError, setCreationError] = useState("");
  const mounted = useRef(true), busy = useRef(false);
  const [data, setData] = useState<XhsHotspotState|null>(null);
  const [preferredCategory, setCategory] = useState<XhsCategory>("travel");
  const [previousCategory, setPreviousCategory] = useState<string | null>(null);
  const configuredRules = data?.configuredRules?.rules || DEFAULT_XHS_RULES;
  const categories = categoryIds(configuredRules), enabledCategories = enabledCategoryIds(configuredRules);
  const category = categories.includes(preferredCategory) ? preferredCategory : categories[0] || preferredCategory;
  const [status, setStatus] = useState<"loading"|"idle"|"analyzing">("loading");
  const [requestingUpdate, setRequestingUpdate] = useState(false);
  const [requestScope, setRequestScope] = useState<XhsCategory[]>([]);
  const [selectedNote, setSelectedNote] = useState<XhsNote|null>(null);
  const [error, setError] = useState(""), [analysisError, setAnalysisError] = useState("");
  const [analysisNotice, setAnalysisNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisHeading = useRef<HTMLHeadingElement>(null);
  const getState = useCallback(async (signal?: AbortSignal) => {
    const value = await jsonResponse(await fetch("/api/hotspots", { cache: "no-store", signal })) as XhsHotspotState;
    if (mounted.current && !signal?.aborted) { setData(value); setError(""); }
    return value;
  }, []);
  const update = useCallback(async (force: boolean, categories?: XhsCategory[], action: "update" | "regroup" = "update") => {
    setRequestScope(categories || []); setRequestingUpdate(true); setError("");
    try {
      const value = await jsonResponse(await fetch("/api/hotspots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, force, categories }), signal: AbortSignal.timeout(30_000) })) as XhsHotspotState;
      if (mounted.current) setData(value);
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "热点更新失败，请稍后重试。"); }
    finally { if (mounted.current) { setRequestingUpdate(false); setRequestScope([]); } }
  }, []);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController();
    void (async () => {
      try { await getState(controller.signal); if (!controller.signal.aborted) await update(false); }
      catch (err) { if (!controller.signal.aborted && mounted.current) setError(err instanceof Error ? err.message : "热点读取失败，请重试。"); }
      finally { if (mounted.current && !controller.signal.aborted) setStatus("idle"); }
    })();
    return () => { mounted.current = false; controller.abort(); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, [getState, update]);
  useEffect(() => {
    if (!data?.updating && !data?.analyzing.length) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { void getState(controller.signal).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "状态暂时无法读取，正在重试。"); }); }, 4000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [data?.updating, data?.analyzing.length, getState]);

  async function analyze(note: XhsNote, force = false) {
    if (busy.current) return;
    setSelectedNote(note); setAnalysisError(""); setAnalysisNotice("");
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    if (selectedNote?.id !== note.id) window.requestAnimationFrame(() => {
      analysisHeading.current?.focus({ preventScroll: true });
      const heading = analysisHeading.current;
      const panel = hotspotScrollPanel(heading);
      if (panel) panel.scrollTo({ top: 0, behavior: "instant" });
      else if (heading && (heading.getBoundingClientRect().top < 0 || heading.getBoundingClientRect().top > window.innerHeight - 120)) heading.scrollIntoView({ block: "start", behavior: "instant" });
    });
    const saved = data?.analyses[note.id];
    if (!force && saved?.fingerprint === note.fingerprint) return;
    busy.current = true; setStatus("analyzing");
    try {
      const source = aiTask.start().id;
      const value = await jsonResponse(await fetch("/api/hotspots", { method: "POST", headers: { "Content-Type": "application/json", ...aiSourceHeader(source) }, body: JSON.stringify({ action: "analyze", noteId: note.id, force }), signal: AbortSignal.timeout(230_000) })) as { analysis: XhsAnalysis };
      if (mounted.current) {
        setData(current => current ? { ...current, analyses: { ...current.analyses, [note.id]: value.analysis } } : current);
        if (force) {
          setAnalysisNotice("拆解已更新并保存。");
          noticeTimer.current = setTimeout(() => setAnalysisNotice(""), 5000);
        }
      }
    } catch (err) { if (mounted.current) setAnalysisError(err instanceof Error && err.name === "TimeoutError" ? "拆解等待超时，已有拆解保留。可稍后重新打开查看结果。" : err instanceof Error ? err.message : "拆解失败，已有结果保留。"); }
    finally { busy.current = false; if (mounted.current) { setStatus("idle"); aiTask.finish(); } }
  }
  function closeMenu(restoreFocus = false) {
    if (restoreFocus) selection?.anchor.focus({ preventScroll: true });
    setSelection(null);
  }
  function startTopic(key: string, anchor: HTMLButtonElement, hotspot: Hotspot, suggestion?: Suggestion, last = false) {
    if (selection?.key === key) { closeMenu(true); return; }
    if (creating.current) return;
    setCreationError("");
    setSelection({ key, anchor, last, hotspot: structuredClone(hotspot), suggestion: suggestion ? structuredClone(suggestion) : undefined });
  }
  async function createSelected(destination: HotspotDestination) {
    if (creating.current || !selection || status !== "idle") return;
    creating.current = true; setCreatingDestination(destination); setCreationError("");
    let moved = false;
    try {
      if (destination === "personal") {
        if (cloud && !user?.id) throw new Error("请先登录后创建个人草稿。");
        const store = cloud ? makeCloudPersonalStore(user!.id) : personalLocalStore;
        await personalStarter.current.start(store, cloud ? `cloud:${user!.id}` : "local", selection.hotspot, selection.suggestion);
        if (!mounted.current) return;
        router.push("/personal");
      } else {
        const { hotspot } = selection;
        const suggestion = selection.suggestion ?? { topic: hotspot.title, angle: hotspot.editorial?.angles[0] || "围绕来源资料和自己的真实经历展开，发布前核实信息。", headline: "" };
        const url = sourceLink(hotspot.url);
        if (!url) throw new Error("来源链接无效，暂时无法创建选题，请先刷新热点。");
        const video = destination === "video";
        sessionStorage.setItem(video ? VIDEO_TRANSFER_KEY : HOTSPOT_TRANSFER_KEY, JSON.stringify({ version: 1, topic: suggestion.topic, angle: suggestion.angle, headline: suggestion.headline, hotspotTitle: hotspot.title, source: hotspot.source, url }));
        router.push(video ? "/video" : "/");
      }
      moved = true;
    } catch {
      if (mounted.current) setCreationError(destination === "personal"
        ? "个人草稿未能完成保存或跳转，请检查网络和存储后重试。选题和原有草稿仍保留；重试不会重复创建。"
        : "无法暂存或打开这个选题，请检查浏览器存储权限后重试。当前草稿没有改动。");
    } finally {
      // Hold the single-flight lock through route commit for every destination.
      if (!moved) { creating.current = false; if (mounted.current) setCreatingDestination(null); }
    }
  }
  function creationButton(key: string, hotspot: Hotspot, suggestion?: Suggestion) {
    const open = selection?.key === key;
    return <button type="button" className={styles.useButton} disabled={status !== "idle" || Boolean(creatingDestination && !open)}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={event => startTopic(key, event.currentTarget, hotspot, suggestion)}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!open) startTopic(key, event.currentTarget, hotspot, suggestion, event.key === "ArrowUp");
          else document.getElementById(menuId)?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        }
      }}>开始创作 <ChevronDown size={14} aria-hidden="true" /></button>;
  }

  const partial = data?.previews?.[category];
  const current = partial && previousCategory !== category ? partial : data?.categories[category];
  const appliedRules = current?.run?.themeTarget ? themeSearchRules(current?.ruleSnapshot?.rules || configuredRules, category) : effectiveRules(current?.ruleSnapshot?.rules || configuredRules, category);
  const target = current?.run?.themeTarget;
  const themeCount = current?.themes.length || 0;
  const candidateThemes = current?.candidateThemes || [];
  const topicCount = themeCount + candidateThemes.length;
  const legacy = Boolean(current?.collectedAt && current.rankingVersion !== 3);
  const gate = appliedRules.categories[category] || DEFAULT_XHS_RULES.categories.travel;
  const changedRules = Boolean(current?.collectedAt && !legacy && data?.configuredRules && current.ruleSnapshot && categoryRulesSignature(current.ruleSnapshot.rules, category) !== categoryRulesSignature(data.configuredRules.rules, category));
  const updating = requestingUpdate || Boolean(data?.updating);
  const stale = Boolean(current?.collectedAt && beijingDate(current.collectedAt) !== beijingDate(new Date()));
  const analysis = selectedNote ? data?.analyses[selectedNote.id] : null;
  const cachedCurrent = analysis?.fingerprint === selectedNote?.fingerprint;
  const externalBusy = Boolean(data?.analyzing.length);
  const currentUpdating = requestScope.includes(category) || Boolean(data?.updating && (data.updatingCategories || enabledCategories).includes(category));
  const previousFailure = !currentUpdating && data?.categories[category]?.error ? data.categories[category] : null;
  const failedAt = previousFailure?.attemptedAt;
  const failureLabel = failedAt ? `上次更新未完成 · ${displayTime(failedAt)}` : "上次更新未完成";
  const historicalFailure = failedAt && beijingDate(failedAt) !== beijingDate(new Date());
  function renderNoteCard(id: string) { const note = current?.notes.find(note => note.id === id); if (!note) return null; const cached = data?.analyses[id]?.fingerprint === note.fingerprint; return <article key={id} className={`${styles.noteCard} ${selectedNote?.id === id ? styles.selectedNote : ""}`}>
            {note.coverFile ? <Image unoptimized className={styles.noteCover} src={`/api/hotspots/cover/${note.coverFile}`} alt={`${note.title}的首图`} width={76} height={96} loading="lazy"/> : <div className={styles.coverPlaceholder}>暂无封面</div>}
            <div className={styles.noteContent}><h4>{note.title}</h4><p>{note.author || "作者未读取"} · 发布于 {note.dateLabel}</p><p>赞 {note.likes.toLocaleString()} · 藏 {note.collects.toLocaleString()} · 评 {note.comments.toLocaleString()}</p><div className={styles.noteActions}><button type="button" disabled={status !== "idle" || (!cached && externalBusy)} onClick={() => void analyze(note)}><Sparkles size={14} aria-hidden="true"/> {cached ? "查看拆解" : "分析拆解"}</button><a href={sourceLink(note.url)} target="_blank" rel="noopener noreferrer">原笔记 <ExternalLink size={13} aria-hidden="true"/></a></div><NoteQuerySources note={note}/></div>
          </article>; }
  return <AppShell disabled={status === "analyzing" || Boolean(creatingDestination)}><div className={styles.page}><main className={styles.main}>
    {selection && <HotspotCreateMenu key={selection.key} id={menuId} anchor={selection.anchor} last={selection.last} busy={creatingDestination} error={creationError} onClose={closeMenu} onChoose={destination => void createSelected(destination)} />}
    <div className={styles.overviewControls}>
    {!selection && creationError && <p className={styles.alert} role="alert">{creationError}</p>}
    <SceneHeader scene="explore" title="今日热点" description="从别人的灵感，找到自己的表达。"/>
    <div className={styles.statusBar}><div><strong>{currentUpdating ? `正在更新${categoryName(configuredRules, category)}` : previousFailure ? failureLabel : current === partial && partial ? "本轮未完成" : target?.status === "shortfall" ? "主题不足，检索目标未完成" : stale ? "上次采集结果" : current?.collectedAt ? "今日已采集" : "等待首次采集"}</strong></div><div className={styles.refreshActions}><button className={styles.updateButton} disabled={!enabledCategories.includes(category) || updating || status !== "idle" || externalBusy} onClick={() => void update(true, [category])}>{currentUpdating ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>} {currentUpdating ? `正在更新${categoryName(configuredRules, category)}…` : `更新${categoryName(configuredRules, category)}`}</button><button className={styles.updateButton} disabled={!enabledCategories.length || updating || status !== "idle" || externalBusy} onClick={() => void update(true, enabledCategories)}>全部更新</button><button type="button" className={styles.updateButton} disabled={!current?.notes.length || updating || status !== "idle" || externalBusy} onClick={() => void update(false, [category], "regroup")}>重新归纳已有笔记</button><button type="button" className={styles.updateButton} aria-label="热点规则管理" disabled={status !== "idle"} onClick={() => router.push("/hotspots/rules")}>规则管理</button>{data?.updating && <button type="button" className={styles.updateButton} onClick={() => { void fetch("/api/hotspots", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"cancel"}) }).then(jsonResponse).then(value=>setData(value)).catch(e=>setError(e.message)); }}>停止本轮检索</button>}</div></div>
    {legacy && <p className={styles.notice}>旧版归纳结果，可点“重新归纳已有笔记”应用新逻辑。</p>}
    {current?.regroupedAt && <p className={styles.notice}>已于 {displayTime(current.regroupedAt)} 重新归纳已有笔记，未重新采集；原互动与采集时间保留。</p>}
    {changedRules && <p className={`${styles.notice} ${styles.ruleChangeNotice}`}>规则已修改，更新后生效。</p>}
    {error && <p className={styles.alert} role="alert">{error}</p>}
    {data?.error && !Object.values(data.categories).some(c => c.error) && <p className={styles.alert} role="alert">{data.error}</p>}
    {updating && <p className={styles.info} role="status">{data?.progress?.message || "正在准备采集，请保留 OpenClaw 浏览器运行。"} · 排名暂定</p>}
    <div className={styles.categoryTabs} role="tablist" aria-label="热点分类">{categories.map((key, index) => <button key={key} id={`tab-${key}`} type="button" role="tab" aria-selected={category === key} aria-controls="hotspot-category-panel" tabIndex={category === key ? 0 : -1} onClick={() => setCategory(key)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : (index + (event.key === "ArrowRight" ? 1 : categories.length - 1)) % categories.length; const key = categories[next]; setCategory(key); document.getElementById(`tab-${key}`)?.focus(); } }}>{categoryName(configuredRules, key)}{data?.updatingCategories?.includes(key) ? <LoaderCircle size={13} className="spin" aria-label="采集中"/> : data?.categories[key]?.error ? <span aria-label="上次更新未完成">!</span> : null} <span>{((data?.previews?.[key] || data?.categories[key])?.themes.length || 0) + ((data?.previews?.[key] || data?.categories[key])?.candidateThemes?.length || 0)}<small> / 至少 {XHS_MIN_THEME_TARGET}</small></span></button>)}</div>
    </div>
    {!categories.length && <p className={styles.notice}>暂无启用的分类，请到热点规则管理新增或恢复分类。</p>}
    <div className={styles.grid}>
      <section id="hotspot-category-panel" data-hotspot-scroll tabIndex={0} role="tabpanel" aria-labelledby={`tab-${category}`} className={styles.card}>
        <div className={styles.cardHeading}><h2><Flame size={15} aria-hidden="true"/> {categoryName(configuredRules, category)}选题 <small>{topicCount} / 至少 {XHS_MIN_THEME_TARGET} 个</small></h2></div>
        {partial && <div className={styles.resultSwitch}><span>{currentUpdating ? '本轮核验 · 暂定排名' : '未完成轮次的已核验结果'}</span><button type="button" onClick={() => setPreviousCategory(previousCategory === category ? null : category)}>{previousCategory === category ? '查看本轮结果' : '查看上次成功榜单'}</button></div>}
        <p className={styles.notice} role="status">{topicCount >= XHS_MIN_THEME_TARGET ? `已提供 ${topicCount} 个有真实笔记支撑的选题：${themeCount} 个达标热点、${candidateThemes.length} 个待验证选题。${currentUpdating ? '仍在继续核验与补搜。' : ''}` : currentUpdating && current === partial ? `已找到 ${topicCount} / ${XHS_MIN_THEME_TARGET} 个选题，继续核验与定向补搜。` : target?.status === 'shortfall' ? current!.run!.stopReason : `每次检索目标：至少 ${XHS_MIN_THEME_TARGET} 个选题；热点不足时用有真实来源的待验证选题补充。${current?.collectedAt && !target ? '当前为旧轮次结果，可重新归纳或检索。' : '来源仍不足或连接中断时会明确提示。'}`}</p>
        <HotspotSearchCoverage result={current} running={currentUpdating && current === partial}/>
        <details className={styles.sourceDetails}>
          <summary><span>排名与采集口径</span><span className={styles.collectionTime}>{current === partial ? "本轮开始" : "最近采集"} {displayTime(current?.collectedAt)}</span></summary>
          <p>{legacy ? "此分类为旧版累计互动榜单，尚未核验高互动门槛与不同作者证据。" : current ? describeXhsRules(appliedRules) : data?.ordering || XHS_ORDERING}</p>
          {!legacy && <p>本类入榜：主题总互动 ≥ {themeInteractionFloor(gate).toLocaleString()}，至少 {gate.minNotes} 篇相关笔记、{gate.minAuthors} 位不同作者。单篇无需先热门；单篇参考门槛为 {gate.minInteractions.toLocaleString()}。</p>}
          <p>候选笔记 {current?.candidateCount || 0} 篇 · 详情核验 {current?.collectionStats?.detailsAttempted ?? current?.notes.length ?? 0} 篇 · 可参与归纳 {current?.diagnostics?.eligibleNotes ?? "待核验"} 篇。达标热点保持全部门槛；待验证选题标明尚缺的笔记、作者或互动证据，不计入热点数量。</p>
          <p>主题结合标题、标签和正文归并；启用 AI 时辅助识别；归并次数可在规则管理中设置，0 表示不额外限制；每个主题展示互动最高的最多 {appliedRules.representatives} 篇代表笔记。互动为页面显示值，含“万”等取整数值，合计为近似值；并非当天新增互动。最近编辑时间不视为发布时间，无法确认发布的笔记会排除。</p>
          <p>{effectiveRules(configuredRules, category).autoUpdate === false ? "自动更新已关闭。" : data?.scheduler ? "每日自动更新。" : "打开页面检查更新。"}自动更新依赖本机服务、OpenClaw 和小红书登录态；休眠或离线期间无法采集，恢复后补更。网页采集不调用 AI；本类启用语义归并后会使用绑定配置。逐篇拆解仍由点击触发，已保存的结果直接复用。</p>
          <p>本次关键词：{current?.queries.join("、") || "等待采集"}。主题归并是工具规则判断，可结合代表笔记核对。</p>
          {current?.run && <p>已尝试 {current.run.searches} 组搜索 · 复用 {current.run.cacheHits} 篇 · AI 归并 {current.run.aiCalls} 次 · {current.run.stopReason}{current.run.firstResultMs !== null ? ` · 首批 ${Math.round(current.run.firstResultMs / 1000)} 秒` : ''}</p>}
          {current?.diagnostics && <><p>筛选明细：低于单篇参考门槛、仍可参与归纳 {current.diagnostics.lowInteraction} 篇 · 作者未核实 {current.diagnostics.unknownAuthors} 篇 · 未识别主题 {current.diagnostics.noSpecificTopic} 篇 · 同作者重复计分已排除 {current.diagnostics.authorDuplicates} 篇</p>{current.collectionStats && <p>发布时间不明 {current.collectionStats.unknownDate} 篇 · 超出时间窗口 {current.collectionStats.outsideWindow} 篇 · 不相关 {current.collectionStats.irrelevant} 篇 · 详情未完成 {current.collectionStats.unavailable} 篇 · 未进入详情核验 {current.collectionStats.uncheckedCandidates} 篇</p>}{current.diagnostics.rejectedThemes.map(t => <p key={t.title}>{t.title}：{t.reason}（{t.notes} 篇达标，{t.authors} 位作者）</p>)}</>}
          <p>{legacy ? "旧版按全部有效候选累加。" : "一篇可支持多个主题；各主题每位作者取最高分一篇，不跨主题相加作为全站总量。相同关注点且笔记重叠达阈值、没有足够新增作者时保留关联，不重复占榜。"}发布时间由可见原始发布日期核验（北京时间）。本榜依据累计互动，不代表正在升温。</p>
        </details>
        {Boolean(current?.run?.warnings.length) && <details className={styles.notice}><summary>本轮采集有 {current!.run!.warnings.length} 项提示 · 查看详情</summary>{current!.run!.warnings.map((warning,i)=><p key={i}>{warning}</p>)}</details>}
        {previousFailure && (historicalFailure
          ? <details className={styles.notice}><summary>查看上次更新的提示</summary><p>{previousFailure.error}</p></details>
          : <p className={styles.notice}>{previousFailure.error}</p>)}
        {Boolean(current?.themes.length) && <h3>已达标热点（{themeCount}）</h3>}
        {current?.themes.length ? <ol className={styles.hotList}>{current.themes.map(theme => <li className={styles.themeItem} data-topic-status="qualified" key={theme.id}>
          <div className={styles.themeHeading}><span className={styles.rank}>{String(theme.rank).padStart(2, "0")}</span><div><h3>{theme.title}</h3><p>{theme.kind === "specific" ? "具体主题 · " : theme.kind === "direction" ? "共同方向 · " : ""}约 {theme.heat.toLocaleString("zh-CN")} 热度分 · {theme.qualifiedNoteCount || theme.noteCount} 篇相关笔记{theme.authorCount ? ` · ${theme.authorCount} 位作者` : ""}</p></div></div>
          <div className={styles.representatives}>{theme.representatives.map(renderNoteCard)}</div>
          {theme.noteIds.length > theme.representatives.length && <details className={styles.singleSection}><summary>查看其余 {theme.noteIds.length - theme.representatives.length} 篇支撑笔记</summary><div className={styles.representatives}>{theme.noteIds.filter(id => !theme.representatives.includes(id)).map(renderNoteCard)}</div></details>}
          {Boolean(theme.relatedTopics?.length) && <details className={styles.singleSection}><summary>关联主题（{theme.relatedTopics!.length}）· 不重复占榜</summary>{theme.relatedTopics!.map(related => <div key={related.title}><strong>{related.title}</strong><p className={styles.footnote}>{related.reason} 共 {related.noteIds.length} 篇支撑笔记。</p></div>)}</details>}
        </li>)}</ol> : <div className={styles.empty}>{status === "loading" ? "正在读取热点…" : candidateThemes.length ? "暂无达到全部门槛的热点，可先查看下方待验证选题。" : currentUpdating ? "正在核验笔记…" : "暂无符合条件的主题，可更新或调整规则。"}</div>}
        {candidateThemes.length > 0 && <section aria-labelledby="candidate-topics-heading"><h3 id="candidate-topics-heading">待验证选题（{candidateThemes.length}）</h3><p className={styles.footnote}>有真实笔记支撑，尚未达到热门门槛。可用于选题参考，不代表已形成热点。</p><ol className={styles.hotList}>{candidateThemes.map(theme => <li className={styles.themeItem} data-topic-status="candidate" key={theme.id}>
          <div className={styles.themeHeading}><span className={styles.rank}>{String(theme.rank).padStart(2, "0")}</span><div><h3>{theme.title}</h3><p>待验证 · {theme.noteCount} 篇相关笔记 · {theme.authorCount} 位作者</p><p>{theme.verificationReasons.join('；')}</p></div></div>
          <div className={styles.representatives}>{theme.representatives.map(renderNoteCard)}</div>
          {theme.noteIds.length > theme.representatives.length && <details className={styles.singleSection}><summary>查看其余 {theme.noteIds.length - theme.representatives.length} 篇来源</summary><div className={styles.representatives}>{theme.noteIds.filter(id => !theme.representatives.includes(id)).map(renderNoteCard)}</div></details>}
        </li>)}</ol></section>}
        {Boolean(current?.singleNoteIds?.length) && <details className={styles.singleSection} open={themeCount < XHS_MIN_THEME_TARGET}><summary>单篇热门参考（{current!.singleNoteIds!.length}）</summary><p className={styles.footnote}>这些笔记达到单篇参考门槛，归纳后尚未形成整体互动和作者证据都达标的主题，不占主题名额。</p><div className={styles.representatives}>{current!.singleNoteIds!.map(renderNoteCard)}</div></details>}
      </section>
      <section className={`${styles.card} ${styles.analysisPanel} ${reader.panel}`} data-hotspot-scroll tabIndex={0} aria-labelledby="analysis-title">
        <div className={`${styles.cardHeading} ${reader.panelHeading}`} data-scroll-heading><h2 id="analysis-title" tabIndex={-1} ref={analysisHeading}><Sparkles size={15} aria-hidden="true"/>笔记分析拆解</h2></div>
        {!selectedNote ? <div className={styles.analysisEmpty}><p>选择一篇笔记，查看分析拆解。</p></div> : <>
        <header className={reader.source}>
          <div className={reader.sourceHeading}>
            {selectedNote.coverFile && <Image unoptimized className={reader.sourceCover} src={`/api/hotspots/cover/${selectedNote.coverFile}`} alt="原笔记首图" width={72} height={96}/>}
            <div className={reader.sourceContent}><p className={reader.sourceLabel}>小红书代表笔记</p><h3>{selectedNote.title}</h3><div className={reader.sourceByline}><span>{selectedNote.author || "作者未读取"}</span><a href={sourceLink(selectedNote.url)} target="_blank" rel="noopener noreferrer">查看原笔记<ExternalLink size={15} aria-hidden="true"/></a></div></div>
          </div>
          <dl className={reader.metrics}><div><dt>点赞</dt><dd>{selectedNote.likes.toLocaleString()}</dd></div><div><dt>收藏</dt><dd>{selectedNote.collects.toLocaleString()}</dd></div><div><dt>评论</dt><dd>{selectedNote.comments.toLocaleString()}</dd></div></dl>
          <details className={reader.sourceDetails}><summary>原笔记正文与采集信息<ChevronDown size={16} aria-hidden="true"/></summary><p>{selectedNote.body || "这篇笔记没有可读取的正文。"}</p><small>页面时间原文：{selectedNote.dateLabel}<br/>互动采集于 {displayTime(selectedNote.collectedAt)}；以上为页面显示的累计近似值。</small><NoteQuerySources note={selectedNote}/></details>
        </header>
        {!analysis && analysisError && <p className={reader.error} role="alert">{analysisError}</p>}
        {status === "analyzing" && <div className={analysis ? reader.loadingWithReport : reader.loading} role="status">{analysis ? <p><LoaderCircle size={18} className="spin" aria-hidden="true"/>正在更新拆解，原报告仍可阅读。</p> : <><h3><LoaderCircle size={20} className="spin" aria-hidden="true"/>正在拆解这篇笔记</h3><p>从人群与表达方式出发，整理写作模板和衍生选题。完成后会自动保存。</p></>}<AiUsageStatus task={aiTask}/></div>}
        {analysis ? <HotspotAnalysis key={selectedNote.id} note={selectedNote} report={analysis} current={cachedCurrent}
          renderTopicAction={(topic, index) => creationButton(`derived-${selectedNote.id}-${index}`, asHotspot(selectedNote), { hotspotId: selectedNote.id, topic, angle: `选题方向：${topic}\n结合自己的真实经历展开，具体事实需核实。`, headline: "", imageIdea: "", reason: "由笔记拆解衍生的选题" })}
          refreshAction={<><details open={!isIngestAnalysis(analysis) || !cachedCurrent || Boolean(analysisError) || undefined}><summary>更新这份拆解</summary><p>使用当前 AI 配置重新分析，成功后替换这份报告；失败会保留原结果。</p><AiUsageStatus task={aiTask}/><button type="button" className={reader.secondaryButton} disabled={status !== "idle" || externalBusy} onClick={() => void analyze(selectedNote, true)}>{status === "analyzing" ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <RefreshCw size={16} aria-hidden="true"/>}{status === "analyzing" ? "正在拆解…" : isIngestAnalysis(analysis) ? "重新拆解（调用 AI）" : "按新方法拆解（调用 AI）"}</button>{analysisError && <p className={reader.inlineError} role="alert">{analysisError}</p>}</details><span className={reader.refreshNotice} role="status">{analysisNotice}</span></>}/>
          : status !== "analyzing" && <div className={reader.loading}><h3>这次拆解还没有完成</h3><p>原笔记已保留，可以重试分析。</p><AiUsageStatus task={aiTask}/><button type="button" className={reader.secondaryButton} disabled={status !== "idle" || externalBusy} onClick={() => void analyze(selectedNote)}>重试分析</button></div>}
        </>}
      </section>
    </div>
  </main></div></AppShell>;
}

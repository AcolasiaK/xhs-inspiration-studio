"use client";

import { ArrowRight, BookOpen, CircleAlert, FolderOpen, HelpCircle, LoaderCircle, LockKeyhole, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SceneHeader } from "@/components/scene-header";
import { AppShell } from "./app-shell";
import { CreationActionDock } from "./creation-action-dock";
import { ImageUploader } from "./image-uploader";
import { RequirementForm } from "./requirement-form";
import { ResultPanel } from "./result-panel";
import { RewriteDialog } from "./rewrite-dialog";
import { PartialRewriteDialog } from "./partial-rewrite-dialog";
import { briefSchema, exampleBrief, type Brief, type ContentResult, type GenerationMode } from "@/lib/schema";
import { MAX_IMAGES } from "@/lib/constants";
import { prepareImage } from "@/lib/images";
import { applyValidatedGeneration, generationErrorMessage, runRegenerationChoice, submitGeneration } from "@/lib/generation-request";
import { isRequestId, measurePreservation, recordClientDiagnostic } from "@/lib/client-diagnostics";
import type { PublicConfig, StudioImage } from "@/lib/types";
import { useDraftWorkspace, type DraftWorkspace } from "@/lib/use-draft-workspace";
import { inputSnapshot, isDraftStale } from "@/lib/drafts";
import { applyRewriteIfCurrent } from "@/lib/rewrite-request";
import { partialFingerprint, applyPartialIfCurrent, type PartialChoice } from "@/lib/partial-client";
import { DraftToolbar } from "./draft-toolbar";
import { DraftDrawer } from "./draft-drawer";
import { WritingStylePicker } from "./writing-style-picker";
import { TravelResearchPanel } from "./travel-research-panel";
import { AiUsageStatus, useAiTask } from "./ai/usage-status";
import { isSameAiRevision, type AiSelection } from "@/lib/ai-profile-client";
import { applyResearchIfCurrent } from "@/lib/research-client";
import { HOTSPOT_TRANSFER_KEY, hotspotTransferSchema } from "@/lib/hotspot-transfer";

export function Studio({ config }: { config: PublicConfig }) {
  const workspace = useDraftWorkspace();
  const handledTransfer = useRef(false);
  const [transferError, setTransferError] = useState("");
  const [transferNotice, setTransferNotice] = useState("");
  const [transferAttempt, setTransferAttempt] = useState(0);
  useEffect(() => {
    if (!workspace.draft || handledTransfer.current) return;
    handledTransfer.current = true;
    async function importTopic() {
      let raw: string | null;
      try { raw = sessionStorage.getItem(HOTSPOT_TRANSFER_KEY); }
      catch { setTransferError("无法读取待导入的选题，当前草稿仍然保留。请检查浏览器存储权限。"); return; }
      if (!raw) return;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { value = null; }
      const parsed = hotspotTransferSchema.safeParse(value);
      if (!parsed.success) { setTransferError("选题信息不完整，当前草稿未被修改。请返回今日热点重新选择。"); return; }
      const saved = await workspace.createFromHotspot(parsed.data);
      if (!saved) { setTransferError("未能保存原草稿或创建选题草稿，原内容仍在；请重试保存后再导入。"); return; }
      try { sessionStorage.removeItem(HOTSPOT_TRANSFER_KEY); }
      catch { setTransferError("新选题草稿已创建，但浏览器未能清除临时跳转信息；请检查浏览器存储权限。"); return; }
      setTransferError(""); setTransferNotice("已保存原草稿，并为这个热点创建新草稿。请核实来源后继续创作。");
    }
    void importTopic();
  }, [workspace, transferAttempt]);
  if (!workspace.draft) return <AppShell disabled><main className="workspace-loading" role="status">{!workspace.storageError && <LoaderCircle className="spin" size={24} />}<h1>小红书灵感工作台</h1>{workspace.storageError ? <><p className="storage-error" role="alert">{workspace.storageError} 原有草稿未被覆盖。</p><button type="button" className="secondary-button" onClick={()=>window.location.reload()}>重新读取或登录</button></> : <p>正在读取{workspace.cloud ? "云端" : "本机"}草稿…</p>}</main></AppShell>;
  return <WorkspaceEditor key={workspace.draft.id} config={config} workspace={workspace}>{transferError && <div className="hotspot-transfer-alert" role="alert">{transferError}<button type="button" className="secondary-button" onClick={() => { handledTransfer.current = false; setTransferAttempt((n) => n + 1); }}>重试导入</button></div>}{transferNotice && <div className="hotspot-transfer-alert" role="status">{transferNotice}<button type="button" className="text-button" onClick={() => setTransferNotice("")}>关闭</button></div>}</WorkspaceEditor>;
}
function WorkspaceEditor({ config, workspace, children }: { config: PublicConfig; workspace: DraftWorkspace; children: ReactNode }) {
  const router = useRouter();
  const draft = workspace.draft!;
  const { images, brief, mode, generation, resultImages } = draft;
  const setImages = (change: (images: StudioImage[]) => StudioImage[]) => workspace.update((old) => ({ ...old, images: change(old.images) }));
  const setBrief = (value: Brief) => workspace.update((old) => ({ ...old, brief: value }));
  const setMode = (value: GenerationMode) => workspace.update((old) => ({ ...old, mode: value }));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [partialChoice, setPartialChoice] = useState<PartialChoice | null>(null);
  const [titleReview, setTitleReview] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading" | "processing" | "generating" | "success" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [liveCheck, setLiveCheck] = useState<"unverified" | "pending" | "success" | "failed">("unverified");
  const [liveDuration, setLiveDuration] = useState<number | null>(null);
  const aiTask = useAiTask();
  const [checkedSource, setCheckedSource] = useState<AiSelection | null>(null);
  const [preservePending, setPreservePending] = useState(false);
  const [backupFailureId, setBackupFailureId] = useState("");
  const working = useRef(false);
  const deciding = useRef(false);
  const mounted = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const guide = useRef<HTMLDialogElement>(null);
  const regenerateDialog = useRef<HTMLDialogElement>(null);
  const busy = preservePending || workspace.switching || ["uploading", "processing", "generating"].includes(status);
  const stale = isDraftStale(draft);
  const sameRevision = isSameAiRevision(checkedSource, aiTask.current);
  const currentCheck = sameRevision ? liveCheck : "unverified";
  const liveLabel = currentCheck === "success" ? "本页真实请求已成功" : currentCheck === "failed" ? "最近真实请求失败"
    : currentCheck === "pending" ? "正在验证真实请求" : "当前配置 · 待实测";

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestController.current?.abort(); }; }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 2500);
    return () => clearTimeout(timeout);
  }, [notice]);

  async function addImages(files: File[]) {
    if (working.current || workspace.switching || !files.length) return;
    if (images.length + files.length > MAX_IMAGES) { setError("最多可以放入 9 张图片，请减少数量后再试。"); return; }
    working.current = true;
    setStatus("uploading"); setError("");
    const next: StudioImage[] = [];
    try {
      for (const file of files) { next.push(await prepareImage(file)); if (!mounted.current) { next.forEach((image) => URL.revokeObjectURL(image.preview)); return; } }
      setImages((old) => [...old, ...next]); setStatus("idle");
    } catch (err) { next.forEach((image) => URL.revokeObjectURL(image.preview)); setError(err instanceof Error ? err.message : "图片读取失败，请重试。"); setStatus("error"); }
    finally { working.current = false; }
  }
  function moveImage(index: number, delta: number) {
    setImages((old) => { const next = [...old]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next; });
  }
  function fillExample() { setBrief({ ...exampleBrief }); setNotice("示例要求已填写，再上传一张照片就可以开始。"); setError(""); }

  async function generate(confirmed = false, existingRequestId?: string) {
    if (working.current || (deciding.current && !confirmed) || workspace.switching) return;
    setError("");
    if (!images.length) { setError("请先上传至少一张图片。"); return; }
    const parsed = briefSchema.safeParse(brief);
    if (!parsed.success) { setError("请填写笔记主题，并检查各项内容是否过长。"); document.getElementById("topic")?.focus(); return; }
    if (!confirmed && generation && draft.hasUserEdits) { setBackupFailureId(""); regenerateDialog.current?.showModal(); return; }
    const requestId = isRequestId(existingRequestId) ? existingRequestId : crypto.randomUUID();
    working.current = true;
    setStatus("processing"); setProgress("正在为上传准备图片…");
    const snapshot = [...images];
    const submittedInput = inputSnapshot(draft);
    const controller = new AbortController();
    requestController.current = controller;
    let requestStarted: number | undefined;
    const ai = mode === "live" ? aiTask.start() : null;
    try {
      const output = await submitGeneration({
        brief: parsed.data, mode, images: snapshot, controller, requestId, aiSource: ai?.id || "",
        onProgress: (done, total) => setProgress(`正在处理图片 ${done} / ${total}`),
        onRequestStarted: () => {
          setStatus("generating"); setProgress(mode === "demo" ? "正在准备固定演示样例…" : "正在根据图片和要求创作，请稍候…");
          requestStarted = performance.now();
          if (mode === "live") { setCheckedSource(ai); setLiveCheck("pending"); setLiveDuration(null); }
        },
      });
      if (!mounted.current || controller.signal.aborted) return;
      // 即便旧页面恰好在请求完成时卸载，也不能把旧请求写入另一个草稿。
      workspace.update((old) => applyValidatedGeneration(old, draft.id, output, mode, snapshot, submittedInput));
      if (mode === "live") { setLiveCheck("success"); setLiveDuration(output.metadata.durationMs); }
      setStatus("success");
      setNotice(mode === "demo" ? "演示样例已准备好，试试编辑和复制。" : "创作完成，可以开始编辑。 ");
      if (window.innerWidth < 900) document.getElementById("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      if (!mounted.current) return;
      if (mode === "live" && requestStarted !== undefined) { setLiveCheck("failed"); setLiveDuration(Math.round(performance.now() - requestStarted)); }
      setError(generationErrorMessage(err)); setStatus("error");
    } finally { working.current = false; requestController.current = null; if (mounted.current) { setProgress(""); aiTask.finish(); } }
  }

  async function chooseRegeneration(preserve: boolean) {
    const requestId = crypto.randomUUID();
    await runRegenerationChoice(deciding, preserve, async () => {
      setPreservePending(true);
      try {
        const saved = await measurePreservation(requestId, workspace.preserveCurrent);
        if (saved && mounted.current) { setBackupFailureId(""); setNotice("已在草稿箱保留一份当前修改。"); }
        if (!saved && mounted.current) setBackupFailureId(requestId);
        return saved;
      } catch {
        if (mounted.current) setBackupFailureId(requestId);
        return false;
      } finally {
        if (mounted.current) setPreservePending(false);
      }
    }, async () => {
      if (!preserve) recordClientDiagnostic({ requestId, phase: "save_copy", result: "skipped", elapsedMs: 0 });
      if (mounted.current) { regenerateDialog.current?.close(); await generate(true, requestId); }
    });
  }

  function editResult(result: ContentResult) { workspace.update((old) => ({ ...old, hasUserEdits: true, generation: old.generation ? { ...old.generation, result } : null })); }
  return <AppShell disabled={busy} navigateSafely={workspace.navigateSafely}><div className="studio-shell creation-studio workbench-page">
    <SceneHeader scene="collage" title="图文创作" description=""><div className="header-actions"><span className={`connection-indicator ${currentCheck === "success" ? "connected" : ""}`} role="status"><i />{liveLabel}</span><button className="history-button" type="button" disabled={busy} onClick={() => setDrawerOpen(true)}><FolderOpen size={16} />草稿箱</button><button className="help-button" type="button" onClick={() => guide.current?.showModal()}><HelpCircle size={16} />使用说明</button></div></SceneHeader>
    <div className="workbench-controls"><DraftToolbar workspace={workspace} disabled={busy} /></div>
    <main className="page-main workbench-main">
      {children}
      <div className={`workspace-grid ${generation ? "has-result" : "is-empty"}`}>
        <div className="input-column creation-pane" role="region" aria-label="图文创作输入" tabIndex={0}><form id="collage-creation-form" noValidate onSubmit={(event) => { event.preventDefault(); void generate(); }} className="input-card">
          <ImageUploader images={images} disabled={busy} onAdd={(files) => void addImages(files)} onRemove={(id) => setImages((old) => old.filter((image) => image.id !== id))} onMove={moveImage} />
          <RequirementForm brief={brief} onChange={setBrief} onExample={fillExample} disabled={busy} styleControl={<WritingStylePicker value={brief.writingStyle} disabled={busy} onChange={writingStyle => setBrief({ ...brief, writingStyle })} onManage={() => void workspace.navigateSafely(() => router.push("/personal/styles"))} />} />

        </form><details className="storage-help"><summary><LockKeyhole size={12} />草稿存储</summary><p>{workspace.cloud ? "图片和草稿保存在你的账号下，登录后可在其他设备继续创作；可在草稿箱删除，或导出文字留存。" : "图片和草稿自动保存到当前浏览器。清除站点数据可能丢失草稿，暂不支持跨设备同步；可在草稿箱删除，或导出文字留存。"}</p></details></div>
        <div className="creation-pane creation-output" role="region" aria-label="图文创作结果" tabIndex={0}><ResultPanel paragraphCaptions={generation?.mode === "live" && Boolean(draft.generatedInput?.brief.writingStyle)} generation={generation} images={resultImages} busy={busy} stale={stale} selectedTitleIndex={draft.selectedTitleIndex} titleReview={titleReview} researchControl={<TravelResearchPanel draft={draft} busy={busy} onApply={(fingerprint, research) => { let applied = false; workspace.update((old) => { const next = applyResearchIfCurrent(old, fingerprint, research); applied = next !== old; return next; }); return applied; }} />} onSelectTitle={(index) => { setTitleReview(false); workspace.update((old) => ({ ...old, selectedTitleIndex: index, hasUserEdits: true })); }} onChange={editResult} onRegenerate={() => void generate()} onRewrite={() => setRewriteOpen(true)} onPartial={setPartialChoice} onError={setError} /></div>
      </div>
    </main>
    <CreationActionDock label="图文生成操作">
      <div className="creation-action-context">
        <label className="creation-mode-select" htmlFor="collage-generation-mode">生成方式<select id="collage-generation-mode" value={mode} disabled={busy} onChange={event => { setMode(event.target.value as GenerationMode); setLiveCheck("unverified"); }}><option value="demo">演示模式</option><option value="live">真实生成</option></select></label>
        <div className="creation-action-status">{mode === "live" && <AiUsageStatus task={aiTask}/>}<p className="mode-description">{mode === "demo" ? "固定样例 · 不分析图片 · 不调用 AI" : "图片和要求将发送至所选 AI，产生 API 用量"}</p></div>
      </div>
      <div className="creation-action-buttons"><button type="submit" form="collage-creation-form" className="generate-button" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}<span>{status === "uploading" ? "正在读取图片" : status === "processing" ? "正在处理图片" : status === "generating" ? "正在生成" : mode === "demo" ? "生成演示样例" : "开始生成"}</span>{!busy && <ArrowRight size={17} />}</button></div>
      {progress && <div className="creation-action-feedback progress-message" role="status" aria-live="polite">{progress}</div>}
      {error && <div className="creation-action-feedback error-message" role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={14} /></button></div>}
    </CreationActionDock>
    {notice && <div className="toast" role="status"><Sparkles size={15} />{notice}</div>}
    <DraftDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} workspace={workspace} disabled={busy} />
    {rewriteOpen && generation && <RewriteDialog fingerprint={partialFingerprint(draft)} generation={generation} generatedInput={draft.generatedInput} images={resultImages} stale={stale} mode={mode} config={config} onClose={() => setRewriteOpen(false)} onApply={(original, rewritten, version, research, fingerprint) => {
      let applied = false;
      workspace.update((old) => { const next = partialFingerprint(old) === fingerprint ? applyRewriteIfCurrent(old, draft.id, original, version, rewritten, research) : old; applied = next !== old; return next; });
      if (applied) setNotice(`新正文已应用，正在自动保存到${workspace.cloud ? "云端" : "本机"}。`);
      return applied;
    }} />}
    {partialChoice && generation && <PartialRewriteDialog draft={draft} choice={partialChoice} stale={stale} config={config} onClose={() => setPartialChoice(null)} onApply={(fingerprint, choice, output, selected) => {
      let applied = false;
      workspace.update((old) => { const next = applyPartialIfCurrent(old, fingerprint, choice, output, selected); applied = next !== old; return next; });
      if (applied) { if (choice.target === "titles_all") setTitleReview(true); setNotice(choice.target === "titles_all" ? "标题已更新，暂选第 1 项，请重新选择。正在自动保存。" : `新内容已应用，正在自动保存到${workspace.cloud ? "云端" : "本机"}。`); }
      return applied;
    }} />}
    <dialog className="guide-dialog" ref={regenerateDialog} aria-labelledby="regenerate-title" onCancel={(event) => { if (deciding.current) event.preventDefault(); }}>
      <div className="guide-top"><span className="guide-icon"><Sparkles size={20} /></span><button type="button" className="close-button" aria-label="关闭重新生成提示" disabled={preservePending} onClick={() => regenerateDialog.current?.close()}><X size={19} /></button></div>
      <h2 id="regenerate-title">保留你修改过的内容？</h2>
      <p className="regenerate-description">可以先把当前内容保存为草稿副本，再生成新结果。也可以直接重新生成；只有生成成功才会替换现有结果，失败时仍保留。</p>
      {(workspace.storageError || backupFailureId) && <p className="storage-error" role="alert">{workspace.storageError || "保留副本失败。"} 当前内容仍在，请重试保存或取消。{backupFailureId && `（阶段：保留副本；本次编号：${backupFailureId}）`}</p>}
      <div className="regenerate-actions"><button type="button" className="generate-button" disabled={preservePending} onClick={() => void chooseRegeneration(true)}>{preservePending ? "正在保留副本…" : "保留修改并重新生成"}</button><button type="button" className="secondary-button" disabled={preservePending} onClick={() => void chooseRegeneration(false)}>不保留副本，重新生成</button><button type="button" className="text-button" disabled={preservePending} onClick={() => regenerateDialog.current?.close()}>取消，继续编辑</button></div>
    </dialog>
    <dialog className="guide-dialog" ref={guide} aria-labelledby="guide-title"><div className="guide-top"><span className="guide-icon"><BookOpen size={20} /></span><button type="button" className="close-button" aria-label="关闭使用说明" onClick={() => guide.current?.close()}><X size={19} /></button></div><h2 id="guide-title">让灵感变成一篇笔记</h2><ol><li><strong>上传照片</strong><p>选 1–9 张图片，按你希望的发布顺序排列。</p></li><li><strong>说说想法</strong><p>填写主题、语气和细节，也可以先点「填写示例」。</p></li><li><strong>生成、编辑、复制</strong><p>生成后，每一段文字都可以修改。复制按钮始终使用最新内容。</p></li></ol><div className="guide-status"><strong>{liveLabel}</strong><p>{currentCheck === "success" ? "本页已完成真实模型调用并通过结果校验；内容是否准确仍需你逐图确认。" : "在左下角 AI 设置中管理密钥与模型；图片理解需要先通过测试。"}</p>{sameRevision && liveDuration !== null && <p>最近一次真实请求：{currentCheck === "success" ? "成功" : "失败"}，耗时约 {(liveDuration / 1000).toFixed(1)} 秒。状态仅保留在当前页面。</p>}<p>演示模式展示固定咖啡主题文案，不调用 AI，不计入真实验证。</p></div><button type="button" className="generate-button" onClick={() => guide.current?.close()}>开始创作<ArrowRight size={16} /></button></dialog>
  </div></AppShell>;
}

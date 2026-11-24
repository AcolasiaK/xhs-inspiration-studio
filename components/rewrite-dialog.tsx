"use client";
/* eslint-disable @next/next/no-img-element -- The stored snapshot uses local object URLs. */

import { useEffect, useRef, useState } from "react";
import { AiUsageStatus, useAiTask } from "./ai/usage-status";
import { RewriteModal, RewriteSettings, rewriteDirectionLabel } from "./rewrite/modal";
import type { GenerationInput } from "@/lib/drafts";
import type { Generation, PublicConfig, StudioImage } from "@/lib/types";
import type { GenerationMode } from "@/lib/schema";
import { submitRewrite, type RewriteDirection } from "@/lib/rewrite-request";
import type { TravelResearch } from "@/lib/travel-research";

type Props = {
  generation: Generation; generatedInput: GenerationInput | null; images: StudioImage[];
  fingerprint: string; stale: boolean; mode: GenerationMode; config: PublicConfig;
  onApply: (original: string, rewritten: string, version: string, research: TravelResearch | null, fingerprint: string) => boolean; onClose: () => void;
};

export function RewriteDialog({ generation, generatedInput: inputProp, images: imagesProp, fingerprint, stale, mode, config, onApply, onClose }: Props) {
  void config; // Retain the existing component prop contract during migration.
  const aiTask = useAiTask();
  const [snapshot] = useState(() => ({generatedInput: inputProp, images: imagesProp, fingerprint}));
  const {generatedInput, images} = snapshot;
  const controller = useRef<AbortController | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const [original] = useState(generation.result.body);
  const [version] = useState(generation.meta.completedAt);
  const [research] = useState(() => generation.research ?? null);
  const [direction, setDirection] = useState<RewriteDirection>("natural");
  const [instruction, setInstruction] = useState("");
  const [rewritten, setRewritten] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const snapshotReady = Boolean(generatedInput && images.length && JSON.stringify(images.map((image) => image.id)) === JSON.stringify(generatedInput.imageIds));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  function close() { controller.current?.abort(); onClose(); }
  async function start() {
    if (working.current) return;
    setError("");
    if (mode !== "live") { setError("请先关闭此窗口，将生成模式切换为真实生成。演示模式不调用 AI。"); return; }
    if (!snapshotReady || !generatedInput) { setError("无法找到与原正文对应的完整图片和创作要求，请重新生成后重试。原文仍保留。"); return; }
    if (!original.trim()) { setError("当前正文为空，请先填写正文再重写。"); return; }
    working.current = true;
    const current = new AbortController(); controller.current = current;
    const aiSource = aiTask.start().id;
    setBusy(true); setRewritten(null); setProgress("正在准备原笔记对应的图片…");
    try {
      const body = await submitRewrite({ brief: generatedInput.brief, body: original, direction, instruction, images, research: research ?? undefined, controller: current, aiSource,
        onProgress: (done, total) => setProgress(`正在处理图片 ${done} / ${total}`),
        onRequestStarted: () => setProgress("正在重写正文，请稍候…") });
      if (!mounted.current || current.signal.aborted) return;
      setRewritten(body); setProgress("");
    } catch (err) {
      if (!mounted.current || current.signal.aborted) return;
      setError(err instanceof Error ? err.message : "重写失败，原正文仍保留。请重试。"); setProgress("");
    } finally { working.current = false; controller.current = null; if (mounted.current) { setBusy(false); aiTask.finish(); } }
  }
  function accept() {
    if (!rewritten?.trim() || rewritten.length > 6000) { setError("新正文不完整，原内容仍保留。"); return; }
    if (!onApply(original, rewritten, version, research, snapshot.fingerprint)) { setError("原正文、参考资料或草稿已发生变化，未覆盖最新内容。请关闭后重新发起重写。"); return; }
    onClose();
  }
  const brief = generatedInput?.brief;
  const basis = <><AiUsageStatus task={aiTask}/>
    <p>{`发送至 当前 AI 配置，产生 API 用量。`}使用生成时的要求及图片；复用 {research?.sources.length ?? 0} 条已保存资料，不自动联网。</p>
    {brief && <dl><dt>主题</dt><dd>{brief.topic || "未填写"}</dd><dt>语气 / 长度 / 受众</dt><dd>{brief.tone} / {brief.length === "short" ? "短" : brief.length === "medium" ? "中" : "长"} / {brief.audience || "未指定"}</dd><dt>发布目的</dt><dd>{brief.purpose}</dd><dt>补充要求</dt><dd>{brief.details || "无"}</dd><dt>常用写作要求</dt><dd>{brief.styleNotes || "无"}</dd><dt>必提 / 禁用</dt><dd>{brief.mustInclude || "无"} / {brief.forbidden || "无"}</dd><dt>Emoji</dt><dd>{brief.emoji ? "允许" : "不使用"}</dd></dl>}
    <div className="rw-images">{images.map((image,index)=><img key={image.id} src={image.preview} alt={`生成时的图片 ${index+1}`}/>)}</div>
  </>;
  return <RewriteModal label="正文" result={rewritten!==null} directionLabel={rewriteDirectionLabel(direction)} busy={busy} progress={progress} error={error} copyText={rewritten??""}
    onClose={close} onStart={()=>void start()} onEdit={()=>{setRewritten(null);setError("");}} onApply={accept} onCopyError={setError} startDisabled={mode!=="live"}
    warning={mode!=="live"?"演示模式不调用 AI，请切换为真实生成。":stale?"输入已改变；本次仍依据原结果生成时的要求和图片。":generation.mode==="demo"?"原结果是演示样例，请确认其与图片相符后重写。":null}
    settings={<RewriteSettings direction={direction} onDirection={setDirection} instruction={instruction} onInstruction={setInstruction} busy={busy} basis={basis}/>}
  ><p className="rw-text">{rewritten}</p></RewriteModal>;
}

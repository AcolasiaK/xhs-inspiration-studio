"use client";

import { useEffect, useRef, useState } from "react";
import type { Draft } from "@/lib/drafts";
import { cloudFetch } from "@/lib/cloud/client";
import { researchFingerprint } from "@/lib/research-client";
import { isSafeTravelSourceUrl, travelResearchSchema, type TravelResearch } from "@/lib/travel-research";

function beijingTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚无检索时间";
  return `${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value))}（北京时间）`;
}
export function TravelResearchPanel({ draft, busy, onApply }: { draft: Draft; busy: boolean; onApply: (fingerprint: string, research: TravelResearch) => boolean }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const generation = draft.generation, input = draft.generatedInput;
  if (!generation || !input?.brief.creationTypes.includes("travel")) return null;
  const place = input.brief.travelSearchPlace;
  const research = generation.research;

  async function refreshResearch() {
    if (busy || running.current || !place || !generation || generation.mode !== "live") return;
    running.current = true; setPending(true); setMessage("");
    const fingerprint = researchFingerprint(draft), abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 55_000);
    try {
      const response = await cloudFetch("/api/travel-research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ place, enabled: true }), signal: abort.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 401 ? "登录状态已失效，请重新登录；已有资料和文案均保留。" : response.status === 429 ? "更新资料太频繁，请稍后重试；已有资料和文案均保留。" : "更新资料暂时失败，已有资料和文案均保留。");
      const parsed = travelResearchSchema.safeParse(data?.research);
      if (!parsed.success) throw new Error("更新资料返回的数据不完整，已有资料和文案均保留。");
      if (!alive.current) return;
      if ((parsed.data.status !== "success" && parsed.data.status !== "partial") || parsed.data.sources.length === 0) { setMessage(`${parsed.data.notice || "未找到可用资料。"} 已有资料和文案均保留。`); return; }
      setMessage(onApply(fingerprint, parsed.data) ? "资料已更新，正在自动保存；当前文案没有改动。" : "草稿或生成内容已改变，这次资料未应用；已有内容均保留。");
    } catch (error) {
      if (alive.current) setMessage(abort.signal.aborted ? "更新资料已取消或超时，已有资料和文案均保留。" : error instanceof TypeError ? "网络连接失败，已有资料和文案均保留。" : error instanceof Error ? error.message : "更新资料失败，已有资料和文案均保留。");
    } finally { clearTimeout(timer); if (controller.current === abort) controller.current = null; running.current = false; if (alive.current) setPending(false); }
  }
  return <section className="result-section travel-research" aria-labelledby="travel-sources-title">
    <div className="result-section-heading"><h3 id="travel-sources-title">参考来源</h3><button type="button" className="secondary-button" disabled={busy || pending || !place || generation.mode !== "live"} onClick={() => void refreshResearch()}>{pending ? "正在更新资料…" : "更新资料"}</button></div>
    <p className="field-hint">资料对应这次生成时的地点{place ? `「${place}」` : "（未填写）"}。更新会将该地点发送给搜索服务；不会自动重写文案。</p>
    {generation.mode === "demo" && <p className="field-hint">演示样例没有进行真实检索；请使用真实生成获取资料。</p>}
    {!place && generation.mode === "live" && <p className="field-hint">本次生成未填写检索地点。请先在输入区填写地点并重新生成。</p>}
    {research ? <><p className="field-hint">检索时间：{beijingTime(research.retrievedAt)}。{research.notice}</p>{research.sources.length > 0 && <ul className="travel-source-list">{research.sources.filter((source) => isSafeTravelSourceUrl(source.url)).map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{source.source}{source.publishedAt ? ` · 发布于 ${beijingTime(source.publishedAt)}` : ""}</span></li>)}</ul>}</> : generation.mode === "live" && <p className="field-hint">这份结果没有保存检索资料。</p>}
    {message && <p className="style-feedback" role="status">{message}</p>}
  </section>;
}

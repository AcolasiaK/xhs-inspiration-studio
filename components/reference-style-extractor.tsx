"use client";

import { useEffect, useRef, useState } from "react";
import { cloudJobFetch } from "@/lib/cloud/jobs-client";
import { isCloudClient } from "@/lib/cloud/client";
import { aiSourceHeader, getAiSource } from "@/lib/ai-source";
import type { Brief } from "@/lib/schema";
import { customStyleSchema, stylePreferencesSchema, type CustomStyle, type StylePreferences } from "@/lib/styles";

/** The original reference is never copied into a saved template. */
export function ReferenceStyleExtractor({ brief, disabled, onSave }: { brief: Brief; disabled: boolean; onSave: (style: CustomStyle) => Promise<void> }) {
  const [preview, setPreview] = useState<{ preferences: StylePreferences; signature: string } | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const current = useRef("");
  const signature = JSON.stringify([brief.referenceText, brief.referenceAspects]);
  const visiblePreview = preview?.signature === signature ? preview.preferences : null;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { current.current = signature; }, [signature]);

  async function extract() {
    if (running.current || disabled || !brief.referenceText.trim()) return;
    running.current = true; setBusy(true); setExtracting(true); setMessage(""); setPreview(null);
    const snapshot = signature, abort = new AbortController(); controller.current = abort;
    const source = getAiSource();
    const timer = setTimeout(() => abort.abort(), isCloudClient() ? 600_000 : 105_000);
    try {
      const response = await cloudJobFetch("/api/style-extract", { method: "POST", headers: { "Content-Type": "application/json", ...aiSourceHeader(source) }, body: JSON.stringify({ referenceText: brief.referenceText, referenceAspects: brief.referenceAspects }), signal: abort.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.error?.message === "string" && data.error.message.length <= 500 ? data.error.message : "暂时无法提取写作特点，请稍后重试。");
      const parsed = stylePreferencesSchema.safeParse(data?.preferences);
      if (!parsed.success) throw new Error("提取结果不完整，未保存模板。请稍后重试。");
      if (!alive.current) return;
      if (snapshot !== current.current) { setMessage("参考文案已改变，本次结果未应用；请重新提取。"); return; }
      setPreview({ preferences: parsed.data, signature: snapshot }); setMessage("请检查并命名，确认后才会保存；参考原文不会保存到模板。");
    } catch (error) {
      if (alive.current) setMessage(abort.signal.aborted ? "提取已取消或等待超时，参考文案和已有模板均保留。" : error instanceof TypeError ? "网络连接失败，请检查网络后重试；参考文案和已有模板均保留。" : error instanceof Error ? error.message : "提取失败，参考文案和已有模板均保留。");
    } finally { clearTimeout(timer); if (controller.current === abort) controller.current = null; running.current = false; if (alive.current) { setBusy(false); setExtracting(false); } }
  }
  async function save() {
    if (!visiblePreview || !name.trim() || running.current || disabled || signature !== current.current) return;
    running.current = true; setBusy(true); setMessage("");
    try {
      const template = customStyleSchema.parse({ version: 1, id: crypto.randomUUID(), name: name.trim(), updatedAt: new Date().toISOString(), preferences: visiblePreview });
      await onSave(template);
      if (alive.current) { setPreview(null); setName(""); setMessage("已保存个人风格模板，可在上方风格模板中选择使用。"); }
    } catch { if (alive.current) setMessage("模板保存失败，预览仍保留，请重试。"); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="reference-extractor">
    <p className="field-help">不选择参考方向时会综合提取。{"使用当前配置的 API 用量"}，结果先预览再保存。</p>
    <button type="button" className="secondary-button" disabled={disabled || busy || !brief.referenceText.trim()} onClick={() => void extract()}>{busy ? "正在处理…" : "提取写作特点并预览"}</button>
    {extracting && <button type="button" className="text-button" onClick={() => controller.current?.abort()}>取消提取</button>}
    {visiblePreview && <div className="reference-preview"><h3>写作特点预览</h3><p>语气：{visiblePreview.tone} · 长度：{visiblePreview.length === "short" ? "短" : visiblePreview.length === "long" ? "长" : "中"} · Emoji：{visiblePreview.emoji ? "使用" : "不使用"}</p><p>受众：{visiblePreview.audience || "未指定"}；禁用词：{visiblePreview.forbidden || "无"}</p><label htmlFor="reference-style-notes">常用写作要求（可修改）</label><textarea id="reference-style-notes" value={visiblePreview.styleNotes} maxLength={1000} rows={3} onChange={(e) => setPreview({ signature, preferences: { ...visiblePreview, styleNotes: e.target.value } })} /><label htmlFor="reference-style-name">模板名称</label><input id="reference-style-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="例如：轻松旅行随笔" /><div className="style-actions"><button type="button" className="secondary-button" disabled={disabled || busy || !name.trim()} onClick={() => void save()}>确认保存个人模板</button><button type="button" className="text-button" disabled={busy} onClick={() => { setPreview(null); setName(""); setMessage("已取消，未保存模板。"); }}>取消</button></div></div>}
    {message && <p className="style-feedback" role="status">{message}</p>}
  </div>;
}

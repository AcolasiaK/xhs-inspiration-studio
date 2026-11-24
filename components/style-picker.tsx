"use client";

import { useState } from "react";
import type { Brief } from "@/lib/schema";
import { applyStyle, preferencesFromBrief, PRESET_STYLES, type CustomStyle } from "@/lib/styles";
import { storageMessage } from "@/lib/local-store";
import { useCloud } from "@/components/cloud/context";

type Props = { brief: Brief; onChange: (brief: Brief) => void; templates: CustomStyle[]; onSave: (value: CustomStyle) => Promise<void>; onDelete: (id: string) => Promise<void>; disabled: boolean };
export function StylePicker({ brief, onChange, templates, onSave, onDelete, disabled }: Props) {
  const { cloud } = useCloud();
  const [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<"new" | "update" | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const custom = templates.find((item) => item.id === selected);
  const chosen = [...PRESET_STYLES, ...templates].find((item) => item.id === selected);
  async function save() {
    if (!name.trim()) { setError("请为模板取个名字。"); return; }
    setBusy(true); setError("");
    try {
      const template: CustomStyle = { version: 1, id: editor === "update" && custom ? custom.id : crypto.randomUUID(), name: name.trim(), updatedAt: new Date().toISOString(), preferences: preferencesFromBrief(brief) };
      await onSave(template); setSelected(template.id); setEditor(null); setMessage(`风格模板已保存到${cloud ? "云端" : "本机"}，可在其他草稿中复用。`);
    } catch (err) { setError(storageMessage(err)); } finally { setBusy(false); }
  }
  return <div className="style-picker compact-style-picker">
    <div className="field"><label htmlFor="style-template">风格模板</label><select id="style-template" value={selected} disabled={disabled || busy} onChange={(e) => { setSelected(e.target.value); setConfirmDelete(false); setEditor(null); }}><option value="">选择一个风格…</option><optgroup label="预设风格">{PRESET_STYLES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>{templates.length > 0 && <optgroup label="我的风格">{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>}</select></div>
    <div className="style-actions"><button type="button" className="secondary-button" disabled={disabled || busy || !chosen} onClick={() => { if (chosen) { onChange(applyStyle(brief, chosen.preferences)); setMessage("已更新语气、受众、长度、Emoji、常用写作要求和禁用词。主题、图片、创作类型、本次要求、已有文案均保留。"); } }}>应用模板</button></div>
    <details className="style-template-management"><summary>保存与管理模板</summary><div className="style-actions"><button type="button" className="text-button" disabled={disabled || busy} onClick={() => { setName(""); setEditor("new"); setError(""); }}>保存为新模板</button>{custom && <><button type="button" className="text-button" disabled={disabled || busy} onClick={() => { setName(custom.name); setEditor("update"); setError(""); }}>更新此模板</button><button type="button" className="text-button" disabled={disabled || busy} onClick={() => setConfirmDelete(true)}>删除此模板</button></>}</div>
    {editor && <div className="template-editor"><label htmlFor="template-name">模板名称</label><input id="template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} disabled={busy} /><p>保存当前的六项创作偏好；本次主题和内容要求不进入模板。</p><button type="button" className="secondary-button" disabled={disabled || busy || !name.trim()} onClick={() => void save()}>{busy ? "正在保存模板…" : "确认保存模板"}</button><button type="button" className="text-button" disabled={busy} onClick={() => setEditor(null)}>取消</button></div>}
    {confirmDelete && custom && <div className="delete-confirm"><p>确定删除风格模板「{custom.name}」吗？已应用到草稿的偏好仍保留。</p><button type="button" className="danger-button" disabled={disabled || busy} onClick={async () => { setBusy(true); try { await onDelete(custom.id); setSelected(""); setConfirmDelete(false); setMessage("模板已删除，当前创作偏好保持不变。"); } catch (err) { setError(storageMessage(err)); } finally { setBusy(false); } }}>确认删除模板</button><button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>取消</button></div>}
    </details>
    {message && <p className="style-feedback" role="status">{message}</p>}{error && <p className="storage-error" role="alert">{error}</p>}
  </div>;
}

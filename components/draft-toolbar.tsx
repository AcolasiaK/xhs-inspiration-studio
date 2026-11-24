"use client";

import { Download, RotateCw } from "lucide-react";
import { useState } from "react";
import type { DraftWorkspace } from "@/lib/use-draft-workspace";
import { analyzeHashtags, textFilename } from "@/lib/format";
import { formatDraftExport } from "@/lib/drafts";

export function DraftToolbar({ workspace, disabled }: { workspace: DraftWorkspace; disabled: boolean }) {
  const { draft, saveStatus, storageError, readWarning } = workspace;
  const [exportError, setExportError] = useState("");
  const [exportNotice, setExportNotice] = useState("");
  const [allowBackup, setAllowBackup] = useState(false);
  if (!draft) return null;
  const labels = { loading: "正在读取草稿…", idle: "尚未保存", pending: "等待自动保存…", saving: "保存中…", saved: workspace.cloud ? "已保存到云端" : "已保存到本机", error: "保存失败" };
  function download(allowIncomplete = false) {
    if (!draft?.generation) return;
    setExportError(""); setExportNotice(""); setAllowBackup(false);
    const tags = analyzeHashtags(draft.generation.result.hashtags);
    if (!tags.valid && !allowIncomplete) {
      setExportError(`目前有 ${tags.count} 个有效话题，请先调整为 10 个。需要保留现有内容时，可选择导出不完整备份。`);
      setAllowBackup(true);
      return;
    }
    let url: string | undefined;
    let anchor: HTMLAnchorElement | undefined;
    try {
      const content = formatDraftExport(draft, allowIncomplete);
      url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" }));
      anchor = document.createElement("a");
      anchor.href = url; anchor.download = textFilename(draft.name); document.body.appendChild(anchor); anchor.click();
      const activeUrl = url;
      setTimeout(() => URL.revokeObjectURL(activeUrl), 1000);
      url = undefined;
      setExportNotice(allowIncomplete && !tags.valid ? "已发起不完整备份下载；备份中标明了话题需要修正。" : "已发起 TXT 下载，请检查浏览器下载列表。");
    } catch {
      if (url) URL.revokeObjectURL(url);
      setExportError("导出失败，当前内容仍在页面中，请检查浏览器下载权限后重试。");
    } finally { anchor?.remove(); }
  }
  return <div className="draft-toolbar">
    <div className="draft-toolbar-main"><div className="draft-name-field"><label htmlFor="draft-name">当前草稿</label><input id="draft-name" value={draft.name} maxLength={80} disabled={disabled} onChange={(e) => workspace.update((old) => ({ ...old, name: e.target.value }))} /></div>
      <span role="status" className={`save-state ${saveStatus}`} data-testid="save-state">{labels[saveStatus]}</span>
      <button type="button" className="secondary-button" onClick={() => download()} disabled={!draft.generation || disabled}><Download size={14} />导出文案</button></div>
    {exportNotice && <p className="storage-warning" role="status">{exportNotice}</p>}
    {exportError && <div className="storage-error" role="alert"><span>{exportError}</span>{allowBackup && <button type="button" className="secondary-button" disabled={disabled} onClick={() => download(true)}>导出不完整备份</button>}</div>}
    {readWarning && <p className="storage-warning" role="status">{readWarning}</p>}
    {storageError && <div className="storage-error" role="alert"><span>{storageError}</span><button type="button" className="secondary-button" disabled={disabled || saveStatus === "saving"} onClick={() => void workspace.save()}><RotateCw size={13} />重试保存</button></div>}
  </div>;
}

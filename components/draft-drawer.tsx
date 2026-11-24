"use client";
/* eslint-disable @next/next/no-img-element -- Local Blob previews own their object URLs. */

import { useEffect, useRef, useState } from "react";
import { Copy, FilePlus2, FolderOpen, Pencil, Trash2, X } from "lucide-react";
import type { DraftSummary } from "@/lib/drafts";
import type { DraftWorkspace } from "@/lib/use-draft-workspace";
import { useCloud } from "@/components/cloud/context";
import { CloudStorageError, getCloudThumbnail } from "@/lib/cloud/store";

function Thumbnail({ blob, name, thumbnailId, retry, onError }: { blob?: Blob; name: string; thumbnailId?: string; retry: number; onError: (message: string) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const { cloud, user } = useCloud();
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState<{id:string;blob:Blob} | null>(null);
  const source = blob ?? (loaded && loaded.id === thumbnailId ? loaded.blob : undefined);
  useEffect(() => {
    if (!source) return;
    const url = URL.createObjectURL(source);
    if (img.current) img.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [source]);
  useEffect(() => {
    if (!cloud || !user?.id || !thumbnailId || source || !placeholder.current) return;
    // Do not eagerly request hundreds of historical images when a drawer is closed.
    if (typeof IntersectionObserver === "undefined") {
      const timer = setTimeout(() => onError("当前浏览器不支持缩略图预览，可打开草稿查看图片。"), 0);
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "80px" });
    observer.observe(placeholder.current); return () => observer.disconnect();
  }, [cloud, user?.id, thumbnailId, source, onError]);
  useEffect(() => {
    if (!visible || !cloud || !user?.id || !thumbnailId || source) return;
    let current = true;
    void getCloudThumbnail(user.id, thumbnailId).then(value => { if (current) { setLoaded({id:thumbnailId,blob:value}); onError(""); } }).catch(error => {
      if (!current) return;
      const code = error instanceof CloudStorageError ? error.code : "";
      onError(["UNAUTHORIZED","LOGIN_REQUIRED","ACCOUNT_CHANGED","GATE_REQUIRED","PASSWORD_CHANGE_REQUIRED"].includes(code) ? "登录状态已变化，请刷新并重新登录。" : ["NOT_FOUND","INVALID_IMAGE"].includes(code) ? "缩略图无法读取，草稿内容未被覆盖。" : "缩略图暂时无法加载，请检查网络后重试。");
    });
    return () => { current = false; };
  }, [visible, cloud, user?.id, thumbnailId, source, retry, onError]);
  return source ? <img ref={img} alt={`${name}的第一张图片`} /> : <span ref={placeholder} className="draft-thumbnail-empty"><FolderOpen size={23} /></span>;
}
function DraftRow({ item, active, disabled, workspace, onOpened }: { item: DraftSummary; active: boolean; disabled: boolean; workspace: DraftWorkspace; onOpened: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.name);
  const [confirming, setConfirming] = useState(false);
  const [thumbnailError, setThumbnailError] = useState("");
  const [thumbnailRetry, setThumbnailRetry] = useState(0);
  return <article className={`draft-row ${active ? "active" : ""}`} data-testid="draft-row" aria-label={`草稿：${item.name}`}>
    <div className="draft-row-main"><div className="draft-thumbnail"><Thumbnail blob={item.thumbnail} name={item.name} thumbnailId={item.thumbnailId} retry={thumbnailRetry} onError={setThumbnailError} /></div><div className="draft-row-info">
      <h3>{item.name}</h3><p>{item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "日期不可读"}</p>
      <span className="result-badge">{item.damaged ? "记录不可读取" : item.contentMode === "demo" ? "演示样例" : item.contentMode === "live" ? "历史真实内容" : "尚未生成"}</span>{active && <span className="current-draft-label">当前</span>}{thumbnailError && <p role="status">{thumbnailError} <button type="button" className="text-button" onClick={()=>{setThumbnailError("");setThumbnailRetry(old=>old+1);}}>重试缩略图</button></p>}
    </div></div>
    {renaming && <div className="draft-rename"><label className="sr-only" htmlFor={`rename-${item.id}`}>新的草稿名称</label><input id={`rename-${item.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={disabled} /><button type="button" className="secondary-button" disabled={disabled || !name.trim()} onClick={async () => { if (await workspace.rename(item.id, name)) setRenaming(false); }}>保存名称</button><button type="button" className="text-button" onClick={() => setRenaming(false)}>取消</button></div>}
    {confirming ? <div className="delete-confirm"><p>确定删除「{item.name}」及其关联图片吗？此操作不能撤销，副本不会受影响。</p><button type="button" className="danger-button" disabled={disabled} onClick={async () => { if (await workspace.remove(item.id)) setConfirming(false); }}>确认删除「{item.name}」</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => setConfirming(false)}>取消删除</button></div>
      : <div className="draft-actions"><button type="button" className="secondary-button" disabled={disabled || item.damaged} onClick={async () => { if (await workspace.open(item.id)) onOpened(); }}>打开草稿</button><button type="button" aria-label={`重命名「${item.name}」`} disabled={disabled || item.damaged} onClick={() => { setName(item.name); setRenaming(true); }}><Pencil size={14} /></button><button type="button" aria-label={`复制「${item.name}」`} disabled={disabled || item.damaged} onClick={async () => { if (await workspace.duplicate(item.id)) onOpened(); }}><Copy size={14} /></button><button type="button" aria-label={`删除「${item.name}」`} disabled={disabled} onClick={() => setConfirming(true)}><Trash2 size={14} /></button></div>}
  </article>;
}
export function DraftDrawer({ open, onClose, workspace, disabled }: { open: boolean; onClose: () => void; workspace: DraftWorkspace; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const locked = disabled || workspace.switching;
  return <dialog ref={dialog} className="draft-drawer" aria-labelledby="drawer-title" onCancel={onClose} onClose={onClose}>
    <div className="drawer-heading"><div><span className="eyebrow">留住每一次灵感</span><h2 id="drawer-title">我的草稿箱</h2></div><button type="button" className="close-button" aria-label="关闭草稿箱" onClick={onClose}><X size={19} /></button></div>
    <p className="drawer-description">{workspace.cloud ? "草稿和图片保存在你的账号下，登录后可在其他设备继续编辑。" : "仅保存在当前设备、当前浏览器。清除站点数据可能丢失草稿；暂不支持跨设备同步。"}</p>
    <button type="button" className="generate-button" disabled={locked} onClick={async () => { if (await workspace.create()) onClose(); }}><FilePlus2 size={16} />新建空白草稿</button>
    {workspace.storageError && <p className="storage-error" role="alert">{workspace.storageError} 当前草稿未丢弃。</p>}
    <div className="draft-list">{workspace.summaries.length ? workspace.summaries.map((item) => <DraftRow key={item.id} item={item} active={workspace.draft?.id === item.id} disabled={locked} workspace={workspace} onOpened={onClose} />)
      : <div className="drawer-empty"><FolderOpen size={32} /><h3>还没有保存的草稿</h3><p>开始填写或上传图片，停止操作约一秒后就会自动保存。</p></div>}</div>
    <p className="drawer-footnote">切换前先保存当前修改。你可以导出 TXT 留存文案，导出不包含图片。</p>
  </dialog>;
}

"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PersonalWorkspace } from "@/lib/personal/use-workspace";
import type { PersonalSummary } from "@/lib/personal/drafts";
import { DEFAULT_PERSONAL_NAME, filterPersonalSummaries } from "@/lib/personal/draft-summary";

function DraftRow({ row, workspace, close }: { row: PersonalSummary; workspace: PersonalWorkspace; close: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(row.name);
  const [confirm, setConfirm] = useState(false);
  const nameId = useId();
  const title = row.name === DEFAULT_PERSONAL_NAME && row.suggestedName ? row.suggestedName : row.name;
  return <article className="personal-draft-item">
    <div className="personal-draft-heading"><h3>{title}</h3>{workspace.draft?.id === row.id && <span>正在编辑</span>}</div>
    <p className="personal-draft-excerpt" title={row.excerpt}>{row.damaged ? "记录不可读取，原数据保留。" : row.excerpt || "还没有填写素材"}</p>
    <p className="personal-draft-meta"><span>{row.style || "历史风格未记录"}</span><span>{row.stage || "阶段未记录"}</span></p>
    <time className="personal-draft-time" dateTime={row.updatedAt}>{row.updatedAt ? new Date(row.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "修改时间未知"}</time>
    {renaming ? <div className="personal-draft-edit">
      <label htmlFor={nameId}>草稿新名称</label><input id={nameId} autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)}/>
      <div className="personal-draft-actions"><button className="secondary-button" type="button" onClick={async () => { if (await workspace.rename(row.id, name)) setRenaming(false); }}>保存名称</button><button type="button" className="text-button" onClick={() => setRenaming(false)}>取消</button></div>
    </div> : confirm ? <div className="personal-draft-edit">
      <p role="alert">确认删除「{title}」？删除后无法恢复。</p>
      <div className="personal-draft-actions"><button className="secondary-button" type="button" onClick={() => void workspace.remove(row.id)}>确认删除</button><button className="text-button" type="button" onClick={() => setConfirm(false)}>取消</button></div>
    </div> : <div className="personal-draft-actions">
      <button className="secondary-button" type="button" disabled={row.damaged} onClick={async () => { if (await workspace.open(row.id)) close(); }}>打开</button>
      <details className="personal-draft-more"><summary aria-label={`更多操作：${title}`}>更多</summary><div>
        <button className="text-button" type="button" disabled={row.damaged} onClick={() => { setName(row.name); setRenaming(true); }}>重命名</button>
        <button className="text-button" type="button" disabled={row.damaged} onClick={async () => { if (await workspace.duplicate(row.id)) close(); }}>复制为新草稿</button>
        <button className="text-button" type="button" onClick={() => setConfirm(true)}>删除</button>
      </div></details>
    </div>}
  </article>;
}

export function PersonalDrawer({ workspace, onClose }: { workspace: PersonalWorkspace; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); previous?.focus({ preventScroll: true }); };
  }, []);
  const rows = filterPersonalSummaries(workspace.summaries, search);
  return <dialog ref={dialog} className="draft-drawer personal-drawer" aria-label="个人创作草稿箱" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDownCapture={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="drawer-heading"><h2>个人草稿箱</h2><button type="button" className="close-button" onClick={onClose} aria-label="关闭草稿箱"><X/></button></div>
    <p className="drawer-description">{workspace.cloud ? "保存在当前账号，按最近修改排列。" : "保存在当前浏览器，按最近修改排列。"}</p>
    <label className="personal-draft-search">搜索草稿<input type="search" value={search} placeholder="搜索名称或素材摘要" onChange={event => setSearch(event.target.value)}/></label>
    <fieldset disabled={workspace.switching}>
      <button type="button" className="secondary-button" onClick={async () => { if (await workspace.create()) onClose(); }}>新建空白草稿</button>
      {workspace.storageError && <p className="storage-error" role="alert">{workspace.storageError}</p>}
      {workspace.readWarning && <p className="storage-warning">{workspace.readWarning}</p>}
      <div className="personal-draft-list">{rows.map(row => <DraftRow key={row.id} row={row} workspace={workspace} close={onClose}/>)}</div>
      {!workspace.summaries.length ? <p className="personal-draft-empty">还没有保存的个人草稿，填写内容后会自动保存。</p> : !rows.length && <p className="personal-draft-empty" role="status">没有找到匹配的草稿，可换个关键词。</p>}
    </fieldset>
  </dialog>;
}

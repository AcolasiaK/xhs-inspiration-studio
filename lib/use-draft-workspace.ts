"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyStoredDraft, draftSummary, hydrateDraft, newDraft, serializeDraft, storedDraftSchema, type Draft, type DraftSummary, type StoredDraft } from "./drafts";
import { customStyleSchema, type CustomStyle } from "./styles";
import { localStore, storageMessage } from "./local-store";
import { useCloud } from "@/components/cloud/context";
import { isCorruptCloudRecord, makeCloudPhotoStore } from "./cloud/store";
import { hotspotBrief, type HotspotTransfer } from "./hotspot-transfer";

type SaveStatus = "loading" | "idle" | "pending" | "saving" | "saved" | "error";
export function useDraftWorkspace() {
  const { cloud, user } = useCloud();
  const store = useMemo(() => cloud ? makeCloudPhotoStore(user?.id ?? "") : localStore, [cloud, user?.id]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [summaries, setSummaries] = useState<DraftSummary[]>([]);
  const [templates, setTemplates] = useState<CustomStyle[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [storageError, setStorageError] = useState("");
  const [readWarning, setReadWarning] = useState("");
  const [switching, setSwitching] = useState(false);
  const latest = useRef<Draft | null>(null);
  const lastSaved = useRef<Draft | null>(null);
  const revision = useRef<number | null>(null);
  const ready = useRef(false);
  const transition = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const urls = useRef(new Set<string>());

  const remember = useCallback((next: Draft) => {
    [...next.images, ...next.resultImages].forEach((image) => urls.current.add(image.preview));
    latest.current = next;
    setDraft(next);
  }, []);
  const activate = useCallback((next: Draft, nextRevision: number | null) => {
    revision.current = nextRevision; lastSaved.current = next;
    remember(next); setStorageError(""); setSaveStatus(nextRevision === null ? "idle" : "saved");
  }, [remember]);
  const updateSummary = useCallback((stored: StoredDraft) => {
    setSummaries((old) => [draftSummary(stored), ...old.filter((item) => item.id !== stored.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const allocated = urls.current;
    async function initialize() {
      let initialized = false;
      try {
        const data = await store.readWorkspace();
        if (cancelled) return;
        const valid: StoredDraft[] = [], rows: DraftSummary[] = [];
        let damaged = "hiddenDamaged" in data && typeof data.hiddenDamaged === "number" ? data.hiddenDamaged : 0;
        const cloudSummaries = "summaries" in data && Array.isArray(data.summaries) ? data.summaries as DraftSummary[] : null;
        if (cloudSummaries) { rows.push(...cloudSummaries); damaged += cloudSummaries.filter(row=>row.damaged).length; }
        for (const value of data.drafts) {
          const parsed = storedDraftSchema.safeParse(value);
          if (parsed.success) { valid.push(parsed.data); if (!cloudSummaries) rows.push(draftSummary(parsed.data)); }
          else {
            damaged++;
            if (value && typeof value === "object" && "id" in value && typeof value.id === "string") rows.push({ id: value.id, name: "无法读取的草稿", updatedAt: "", contentMode: null, damaged: true });
          }
        }
        const savedTemplates = data.templates.flatMap((value) => { const parsed = customStyleSchema.safeParse(value); if (!parsed.success) damaged++; return parsed.success ? [parsed.data] : []; });
        let next: Draft | undefined;
        let selectedRevision: number | null = null;
        if (cloudSummaries) {
          const candidates = rows.filter(row => !row.damaged).sort((a,b) => a.id === data.activeId ? -1 : b.id === data.activeId ? 1 : b.updatedAt.localeCompare(a.updatedAt));
          for (const row of candidates) {
            let stored: StoredDraft;
            try { stored = await store.getDraft(row.id); }
            catch (error) { if (!isCorruptCloudRecord(error)) throw error; row.damaged = true; damaged++; continue; }
            try { next = await hydrateDraft(stored); selectedRevision = stored.revision; break; }
            catch { row.damaged = true; damaged++; }
          }
        } else {
          const stored = valid.find((item) => item.id === data.activeId) ?? valid.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (stored) { next = await hydrateDraft(stored); selectedRevision = stored.revision; }
        }
        next ??= newDraft();
        if (cancelled) { [...next.images, ...next.resultImages].forEach((image) => URL.revokeObjectURL(image.preview)); return; }
        setSummaries(rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); setTemplates(savedTemplates);
        if (damaged) setReadWarning(`${damaged} 条${cloud ? "云端" : "本地"}记录损坏或版本不兼容，已跳过，原数据未被覆盖。`);
        activate(next, selectedRevision); initialized = true;
      } catch (error) {
        if (cancelled) return;
        // A failed cloud read is not evidence of an empty account; never start or autosave a blank draft.
        if (!cloud) { activate(newDraft(), null); initialized = true; }
        setReadWarning(`未能恢复${cloud ? "云端" : "本机"}草稿，旧记录未被覆盖；当前页面内容不会覆盖旧稿。`);
        setStorageError(storageMessage(error)); setSaveStatus("error");
      } finally { if (!cancelled && initialized) ready.current = true; }
    }
    void initialize();
    return () => { cancelled = true; ready.current = false; allocated.forEach((url) => URL.revokeObjectURL(url)); allocated.clear(); };
  }, [activate, cloud, store]);

  useEffect(() => {
    const active = new Set([...(draft?.images ?? []), ...(draft?.resultImages ?? [])].map((image) => image.preview));
    for (const url of urls.current) if (!active.has(url)) { URL.revokeObjectURL(url); urls.current.delete(url); }
  }, [draft]);

  const update = useCallback((change: (current: Draft) => Draft) => {
    if (!latest.current || !ready.current || transition.current) return;
    const changed = change(latest.current);
    // 旧请求在切换草稿后返回时可能被拒绝；不要把未改变的草稿标记成待保存。
    if (changed === latest.current) return;
    const next = { ...changed, updatedAt: new Date().toISOString() };
    remember(next); setSaveStatus("pending");
  }, [remember]);

  const save = useCallback(async (): Promise<boolean> => {
    const operation = queue.current.catch(() => undefined).then(async () => {
      const snapshot = latest.current;
      if (!ready.current || !snapshot) return false;
      if (lastSaved.current === snapshot && revision.current !== null) return true;
      setSaveStatus("saving");
      try {
        const stored = await store.writeDraft(serializeDraft(snapshot, revision.current ?? 0), revision.current);
        revision.current = stored.revision; lastSaved.current = snapshot; updateSummary(stored);
        setStorageError(""); setSaveStatus(latest.current === snapshot ? "saved" : "pending");
        return true;
      } catch (error) { setStorageError(storageMessage(error)); setSaveStatus("error"); return false; }
    });
    queue.current = operation;
    return operation;
  }, [updateSummary, store]);

  useEffect(() => {
    if (!draft || !ready.current || lastSaved.current === draft) return;
    const timer = setTimeout(() => { void save(); }, 1000);
    return () => clearTimeout(timer);
  }, [draft, save]);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.visibilityState === "hidden" && latest.current !== lastSaved.current) void save(); };
    const guardUnload = (event: BeforeUnloadEvent) => { if (latest.current !== lastSaved.current || saveStatus === "error") { event.preventDefault(); event.returnValue = ""; } };
    document.addEventListener("visibilitychange", flushWhenHidden); window.addEventListener("beforeunload", guardUnload);
    return () => { document.removeEventListener("visibilitychange", flushWhenHidden); window.removeEventListener("beforeunload", guardUnload); };
  }, [save, saveStatus]);

  async function changeWorkspace(action: () => Promise<void>, flush = true) {
    if (transition.current || !ready.current) return false;
    transition.current = true; setSwitching(true);
    try { if (flush && !await save()) return false; await action(); return true; }
    catch (error) { setStorageError(storageMessage(error)); return false; }
    finally { transition.current = false; setSwitching(false); }
  }
  async function loadStored(stored: StoredDraft, persistActive: boolean) {
    const next = await hydrateDraft(stored);
    try { if (persistActive) await store.setActive(stored.id); }
    catch (error) { [...next.images, ...next.resultImages].forEach((image) => URL.revokeObjectURL(image.preview)); throw error; }
    activate(next, stored.revision);
  }
  return {
    draft, update, summaries, templates, saveStatus, storageError, readWarning, switching, save, cloud,
    open: (id: string) => changeWorkspace(async () => { await loadStored(await store.getDraft(id), true); }),
    create: () => changeWorkspace(async () => {
      const next = newDraft(); const stored = await store.writeDraft(serializeDraft(next, 0), null);
      updateSummary(stored); activate(next, stored.revision);
    }),
    createFromHotspot: (input: HotspotTransfer) => changeWorkspace(async () => {
      const next = newDraft();
      next.brief = hotspotBrief(input);
      next.name = next.brief.topic.slice(0, 80);
      // 写入新草稿和激活指针的事务完成后才切换，原草稿已经由 changeWorkspace 保存。
      const stored = await store.writeDraft(serializeDraft(next, 0), null);
      updateSummary(stored); activate(next, stored.revision);
    }),
    navigateSafely: (navigate: () => void) => changeWorkspace(async () => { navigate(); }),
    duplicate: (id: string) => changeWorkspace(async () => {
      const copy = copyStoredDraft(await store.getDraft(id));
      const stored = await store.writeDraft(copy, null); updateSummary(stored); await loadStored(stored, false);
    }),
    // Preserve a separate copy without changing the active draft or its access-token state.
    preserveCurrent: () => changeWorkspace(async () => {
      if (!latest.current) throw new Error("没有可保留的草稿。");
      // changeWorkspace 已先提交当前页面的编辑，且 transition 防止操作期间继续修改。
      const snapshot = serializeDraft(latest.current, revision.current ?? 0);
      const stored = await store.preserveSnapshot(snapshot);
      updateSummary(stored);
    }),
    rename: (id: string, name: string) => changeWorkspace(async () => {
      if (!name.trim()) throw new Error("请填写草稿名称。");
      const stored = await store.getDraft(id);
      const saved = await store.writeDraft({ ...stored, name: name.trim().slice(0, 80), updatedAt: new Date().toISOString() }, stored.revision, false);
      updateSummary(saved);
      if (latest.current?.id === id) activate({ ...latest.current, name: saved.name, updatedAt: saved.updatedAt }, saved.revision);
    }),
    remove: (id: string) => changeWorkspace(async () => {
      await store.deleteDraft(id); setSummaries((old) => old.filter((item) => item.id !== id));
      if (latest.current?.id === id) activate(newDraft(), null);
    }, latest.current?.id === id),
    async saveTemplate(template: CustomStyle) {
      await store.saveTemplate(template); setTemplates((old) => [...old.filter((item) => item.id !== template.id), template]);
    },
    async removeTemplate(id: string) { await store.deleteTemplate(id); setTemplates((old) => old.filter((item) => item.id !== id)); },
  };
}
export type DraftWorkspace = ReturnType<typeof useDraftWorkspace>;

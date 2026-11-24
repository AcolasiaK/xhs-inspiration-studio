import { copyStoredDraft, LOCAL_DATA_VERSION, storedDraftSchema, type StoredDraft } from "./drafts";
import { customStyleSchema, type CustomStyle } from "./styles";
import { ZodError } from "zod";

export const DATABASE_NAME = "xhs-inspiration-studio";
export const DATABASE_VERSION = 1;
const STORES = ["drafts", "templates", "settings"];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("当前浏览器无法使用本地存储。页面内容仍保留，请先导出文案。")); return; }
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const timer = setTimeout(() => { settled = true; reject(new Error("读取本机存储超时，请关闭其他工作台标签页后重试。")); }, 8000);
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => { clearTimeout(timer); settled = true; reject(request.error); };
    request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error("本机存储正在升级，请关闭其他工作台标签页后重试。")); };
  });
}

async function transact<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, fail: (error: Error) => void) => () => T): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let failure: Error | null = null;
      let result: () => T;
      tx.oncomplete = () => { try { resolve(result()); } catch (error) { reject(error); } };
      tx.onabort = () => reject(failure || tx.error || new Error("本地存储事务未完成，请重试。"));
      tx.onerror = () => { /* 由 onabort 统一处理；请求成功不等于事务已提交。 */ };
      try { result = work(tx, (error) => { failure = error; tx.abort(); }); }
      catch (error) { failure = error instanceof Error ? error : new Error("本地存储失败"); tx.abort(); }
    });
  } finally { db.close(); }
}

export function storageMessage(error: unknown): string {
  if (error instanceof ZodError) return "这份记录不兼容或已损坏，未覆盖原数据。请打开其他草稿，或导出当前文案留存。";
  if (error instanceof DOMException && error.name === "QuotaExceededError") return "本机存储空间不足，尚未保存。当前内容仍在，请导出文案，或在草稿箱删除其他草稿后重试。";
  if (error instanceof DOMException && ["SecurityError", "InvalidStateError", "UnknownError"].includes(error.name)) return "浏览器无法写入本地存储。当前内容仍在，请检查浏览器存储权限后重试，或先导出文案。";
  if (error instanceof DOMException && error.name === "VersionError") return "本地数据来自较新版本，请更新工具；旧数据未被覆盖。";
  return error instanceof Error && !(error instanceof DOMException) ? error.message : "本地保存失败，当前页面内容仍保留，请重试或导出文案。";
}

export const localStore = {
  async readWorkspace() {
    return transact(["drafts", "templates", "settings"], "readonly", (tx) => {
      let drafts: unknown[] = [], templates: unknown[] = [], activeId: string | undefined;
      const a = tx.objectStore("drafts").getAll(); a.onsuccess = () => { drafts = a.result; };
      const b = tx.objectStore("templates").getAll(); b.onsuccess = () => { templates = b.result; };
      const c = tx.objectStore("settings").get("active"); c.onsuccess = () => { activeId = c.result?.value; };
      return () => ({ drafts, templates, activeId });
    });
  },
  async getDraft(id: string) {
    return transact(["drafts"], "readonly", (tx) => {
      let value: unknown;
      const request = tx.objectStore("drafts").get(id); request.onsuccess = () => { value = request.result; };
      return () => storedDraftSchema.parse(value);
    });
  },
  async writeDraft(value: StoredDraft, expectedRevision: number | null, active = true) {
    const parsed = storedDraftSchema.parse(value);
    // Upgrade only the record being saved; keep legacy content and images unchanged.
    const draft = storedDraftSchema.parse({ ...parsed, version: LOCAL_DATA_VERSION,
      selectedTitleIndex: parsed.selectedTitleIndex ?? 0, hasUserEdits: parsed.hasUserEdits ?? Boolean(parsed.generation) });
    return transact(["drafts", "settings"], "readwrite", (tx, fail) => {
      const store = tx.objectStore("drafts");
      const request = store.get(draft.id);
      const saved = { ...draft, revision: (expectedRevision ?? 0) + 1 };
      request.onsuccess = () => {
        const current = request.result;
        if (expectedRevision === null ? current !== undefined : !current || current.revision !== expectedRevision || ![1, 2, LOCAL_DATA_VERSION].includes(current.version) || current.version > draft.version) {
          fail(new Error("这份草稿已被其他标签页修改或删除，未覆盖其他版本。请先导出当前文案，再重新打开页面。")); return;
        }
        try {
          store.put(saved);
          if (active) tx.objectStore("settings").put({ id: "active", value: draft.id });
        } catch (error) { fail(error instanceof Error ? error : new Error("本地保存失败，请重试。")); }
      };
      return () => saved;
    });
  },
  async preserveSnapshot(value: StoredDraft) {
    // 必须复制调用方当前页面的快照；另一标签页可能在保存后又修改了原草稿。
    const original = storedDraftSchema.parse(value);
    const copy = copyStoredDraft(original);
    copy.name = `${original.name.slice(0, 68)}（重新生成前）`;
    return localStore.writeDraft(copy, null, false);
  },
  async setActive(id: string) {
    return transact(["settings"], "readwrite", (tx) => { tx.objectStore("settings").put({ id: "active", value: id }); return () => undefined; });
  },
  async deleteDraft(id: string) {
    return transact(["drafts", "settings"], "readwrite", (tx) => {
      tx.objectStore("drafts").delete(id);
      const settings = tx.objectStore("settings");
      const request = settings.get("active");
      request.onsuccess = () => { if (request.result?.value === id) settings.delete("active"); };
      return () => undefined;
    });
  },
  async saveTemplate(value: CustomStyle) {
    const template = customStyleSchema.parse(value);
    return transact(["templates"], "readwrite", (tx) => { tx.objectStore("templates").put(template); return () => template; });
  },
  async deleteTemplate(id: string) {
    return transact(["templates"], "readwrite", (tx) => { tx.objectStore("templates").delete(id); return () => undefined; });
  },
};

import { aiStorageNamespace } from "./cloud/client";
// Only an opaque profile ID is persisted. Secrets and configuration remain on the server.
export type AiSource = string;
const key=()=> 'xhs-ai-profile-v1:'+aiStorageNamespace();
const EVENT='xhs-ai-profile-change';
const fallback=new Map<string,string>();
const defaults=new Map<string,string>();
export function setDefaultAiSource(id:string|null){defaults.set(aiStorageNamespace(),id||'none');if(typeof window!=='undefined')window.dispatchEvent(new Event(EVENT));}
export function getAiSource(): AiSource {
  if (typeof window === 'undefined') return '';
  const namespace = aiStorageNamespace();
  // An empty header uses the server default until the list has arrived. Only
  // an explicit "none" (or a loaded empty default) should suppress that default.
  const defaultId = defaults.get(namespace) ?? '';
  if (fallback.has(namespace)) return fallback.get(namespace) || defaultId;
  try { return window.localStorage.getItem(key()) || defaultId; }
  catch { return defaultId; }
}
export function setAiSource(id: AiSource, namespace = aiStorageNamespace()) {
  if (typeof window === 'undefined' || namespace !== aiStorageNamespace()) return;
  try {
    if (id) window.localStorage.setItem(key(), id);
    else window.localStorage.removeItem(key());
    fallback.delete(namespace);
  } catch { fallback.set(namespace, id); }
  try { window.localStorage.removeItem('xhs-ai-source-v1'); } catch {}
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeAiSource(listener:()=>void){window.addEventListener(EVENT,listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener(EVENT,listener);window.removeEventListener('storage',listener);};}
export function aiSourceHeader(source=getAiSource()):Record<string,string>{return source?{'X-AI-Profile':source}:{};}

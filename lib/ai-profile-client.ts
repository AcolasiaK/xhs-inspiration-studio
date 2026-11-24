import type { Probe, ProfileList, PublicProfile } from './ai-config';
import { aiStorageNamespace, cloudFetch } from './cloud/client';
import { setDefaultAiSource } from './ai-source';

export type AiProfileState = { data: ProfileList | null; loading: boolean; error: string };
export type AiSelection = {
  id: string;
  name: string;
  model: string;
  revision: string;
  issue: string;
};

type ProfileRevision = Pick<PublicProfile, 'id' | 'revision'>;
export function isSameAiRevision(previous: ProfileRevision | null, current: ProfileRevision) {
  return previous?.id === current.id && previous.revision === current.revision;
}

export function describeAiSelection(state: AiProfileState, selected: string): AiSelection {
  const id = selected || (state.data ? state.data.defaultId || 'none' : '');
  const profile = state.data?.profiles.find(item => item.id === id);
  const issue = state.error ? 'AI 配置读取失败，请重新读取或打开 AI 设置。'
    : !state.data ? '正在读取 AI 配置…'
    : id === 'none' ? '尚未选择 AI 配置，请到 AI 设置中选择。'
    : !profile ? '所选 AI 配置已删除或不可用，请重新选择。'
    : !profile.hasApiKey ? '所选配置尚未填写 API Key，请到 AI 设置中补充。'
    : '';
  return { id, name: profile?.name || '', model: profile?.model || '', revision: profile?.revision || '', issue };
}

export async function testAiProfileConnection(profile: Pick<PublicProfile, 'id' | 'revision'>, kind: 'text' | 'image', signal?: AbortSignal): Promise<Probe> {
  const response = await cloudFetch('/api/ai/profiles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ action: 'test', id: profile.id, revision: profile.revision, kind }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || '测试未完成，请检查工作台连接。');
  const probe = result?.probe;
  if (!probe || !['passed', 'failed', 'unsupported'].includes(probe.status) || typeof probe.message !== 'string') {
    throw new Error('工作台未返回有效的测试结果。');
  }
  return probe;
}

export function probeConfirmation(profile: Pick<PublicProfile, 'name' | 'model' | 'maxOutputTokens'>, kind: 'text' | 'image') {
  const sample = kind === 'image' ? '一张测试色块图' : '一条测试文字';
  return `使用“${profile.name} · ${profile.model}”发送${sample}。本次输出上限为 ${profile.maxOutputTokens} token，按服务实际用量计费。`;
}

/** Account-scoped public metadata only. Concurrent consumers share one read. */
export class AiProfileResource {
  private state: AiProfileState = { data: null, loading: false, error: '' };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private requestVersion = 0;
  private changes: BroadcastChannel | null = null;
  constructor(readonly namespace = aiStorageNamespace()) {}
  private refreshOnFocus = () => { if (this.namespace === aiStorageNamespace()) void this.load(); };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && typeof window !== 'undefined') {
      window.addEventListener('focus', this.refreshOnFocus);
      try {
        this.changes = new window.BroadcastChannel('xhs-ai-profiles:' + this.namespace);
        this.changes.onmessage = () => {
          if (this.namespace === aiStorageNamespace()) void this.reload();
        };
      } catch { /* Focus still refreshes when cross-tab messaging is unavailable. */ }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && typeof window !== 'undefined') {
        window.removeEventListener('focus', this.refreshOnFocus);
        this.changes?.close();
        this.changes = null;
      }
    };
  };
  private publish(state: AiProfileState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  reload = () => this.load(true);
  afterChange = () => {
    if (this.namespace !== aiStorageNamespace()) return Promise.resolve();
    this.changes?.postMessage('updated');
    return this.reload();
  };
  load = (force = false) => {
    if (this.namespace !== aiStorageNamespace()) return Promise.resolve();
    if (this.pending && !force) return this.pending;
    const version = ++this.requestVersion;
    const namespace = aiStorageNamespace();
    this.publish({ ...this.state, loading: true });
    this.pending = (async () => {
      try {
        const response = await cloudFetch('/api/ai/profiles');
        const data = await response.json();
        if (version !== this.requestVersion || namespace !== aiStorageNamespace()) return;
        if (!response.ok || !Array.isArray(data?.profiles)) throw new Error('无法读取配置');
        this.publish({ data: data as ProfileList, loading: false, error: '' });
        if (namespace === aiStorageNamespace()) setDefaultAiSource(data.defaultId);
      } catch {
        if (version === this.requestVersion && namespace === aiStorageNamespace()) this.publish({ ...this.state, loading: false, error: '无法读取 AI 配置，请检查工作台连接后重试。' });
      } finally { if (version === this.requestVersion) this.pending = null; }
    })();
    return this.pending;
  };
}

export function profileForm(profile: PublicProfile) {
  return {
    name: profile.name, provider: profile.provider, protocol: profile.protocol,
    baseUrl: profile.baseUrl, model: profile.model, apiKey: '', clearApiKey: false,
    timeoutSeconds: profile.timeoutSeconds, maxOutputTokens: profile.maxOutputTokens,
    jsonMode: profile.jsonMode,
  };
}

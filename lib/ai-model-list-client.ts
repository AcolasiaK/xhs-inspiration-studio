import { cloudFetch } from './cloud/client';
import type { ProfileInput, PublicProfile } from './ai-config';

export type ModelListQueryInput = {
  id?: string;
  revision?: string;
  profile: Pick<ProfileInput, 'provider' | 'baseUrl' | 'apiKey' | 'clearApiKey' | 'protocol' | 'timeoutSeconds'>;
};
export type ModelListState = {
  status: 'idle' | 'loading' | 'success' | 'empty' | 'error';
  models: string[];
  message: string;
  errorCode?: string;
};
const idle = (): ModelListState => ({ status: 'idle', models: [], message: '' });
const address = (url: string) => url.trim().replace(/\/+$/, '');
const manualFallbackCodes = new Set(['MODELS_FORBIDDEN', 'MODELS_UNSUPPORTED', 'MODELS_INCOMPATIBLE', 'MODELS_INVALID_RESPONSE']);

export function modelListHelp(state: ModelListState) {
  if (state.status === 'error' && !manualFallbackCodes.has(state.errorCode || '')) {
    return '请先处理上方错误再重试；正式生成也需要可用的服务连接。';
  }
  return '服务不提供模型列表或列表查询权限受限时，可手动填写模型 ID；生成能力需另行测试。';
}

export function canQueryModels(form: ProfileInput, saved: PublicProfile | null) {
  if (!form.baseUrl.trim() || form.clearApiKey) return false;
  if (form.apiKey.trim()) return true;
  return !!saved?.hasApiKey && saved.provider === form.provider && address(saved.baseUrl) === address(form.baseUrl);
}

/** Only the latest explicit query may publish results. Credentials never enter its state. */
export class ModelListQuery {
  private version = 0;
  private pending?: AbortController;
  private state = idle();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: ModelListState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  cancel = () => { this.version++; this.pending?.abort(); this.pending = undefined; };
  invalidate = () => { this.cancel(); this.publish(idle()); };

  async load(input: ModelListQueryInput, transport: typeof cloudFetch = cloudFetch) {
    this.cancel();
    const version = this.version;
    const controller = new AbortController();
    this.pending = controller;
    this.publish({ status: 'loading', models: [], message: '正在获取模型列表…' });
    const current = () => this.version === version && !controller.signal.aborted;
    try {
      const response = await transport('/api/ai/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ action: 'models', ...input }),
      });
      const data = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok) {
        const message = typeof data?.error?.message === 'string' ? data.error.message : '模型列表查询失败，请稍后重试。';
        const errorCode = typeof data?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(data.error.code) ? data.error.code : 'MODELS_QUERY_FAILED';
        const hint = manualFallbackCodes.has(errorCode) && !message.includes('手动填写') ? ' 可手动填写模型 ID 后保存，生成能力需另行测试。' : '';
        this.publish({ status: 'error', models: [], errorCode, message: message + hint });
        return;
      }
      if (!Array.isArray(data?.models) || !data.models.every((v: unknown) => typeof v === 'string')) {
        this.publish({ status: 'error', models: [], errorCode: 'MODELS_INVALID_RESPONSE', message: '模型列表返回格式不正确，可手动填写模型 ID 后保存，生成能力需另行测试。' });
        return;
      }
      const models = [...new Set<string>(data.models)];
      this.publish({ status: models.length ? 'success' : 'empty', models,
        message: models.length ? `已获取 ${models.length} 个模型，请搜索并选择，或手动填写。` : '服务返回了空模型列表，仍可手动填写模型 ID 后保存。' });
    } catch {
      if (current()) this.publish({ status: 'error', models: [], errorCode: 'MODELS_NETWORK', message: '模型列表请求未完成，请检查本机服务和网络连接后重试。' });
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }
}

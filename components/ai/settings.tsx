'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ModelListQuery, canQueryModels, modelListHelp } from '@/lib/ai-model-list-client';
import { emptyAiForm, needsAiRetest, sameAiForm } from '@/lib/ai-settings-state';
import { probeConfirmation, profileForm, testAiProfileConnection } from '@/lib/ai-profile-client';
import { ModelPicker } from './model-picker';
import { AiSelector } from './selector';
import { useAiProfiles } from './usage-status';
import { useAiSource } from '../use-ai-source';
import { AppShell } from '../app-shell';
import { VideoDialog } from '../video/dialog';
import { aiStorageNamespace, cloudFetch } from '@/lib/cloud/client';
import { useCloud } from '../cloud/context';
import { presets, type Probe, type ProfileInput, type PublicProfile } from '@/lib/ai-config';
import { getAiSource, setAiSource } from '@/lib/ai-source';
import './settings.css';

type Operation = { kind: 'save' | 'default' | 'delete' | 'text' | 'image'; id?: string };
type Confirmation = { title: string; message: string; accept: string; proceed: () => void };
const testTime = (at: string | null) => at ? new Date(at).toLocaleString('zh-CN') : '尚未测试';
function ProbeStatus({ label, probe, running, retest }: { label: string; probe: Probe; running: boolean; retest: boolean }) {
  return <p className="ai-probe" role={running ? 'status' : undefined}>
    <strong>{label}</strong><span>{running ? `正在测试${label}…` : retest ? '需要重新测试（先保存修改）' : probe.message}</span>
    <small>{!running && !retest ? testTime(probe.at) : ''}</small>
  </p>;
}

export function AiSettings() {
  const { cloud, user } = useCloud();
  return <AccountAiSettings key={cloud ? user?.id || 'signed-out' : 'local-owner'} />;
}

function AccountAiSettings() {
  const profiles = useAiProfiles();
  const data = profiles.data;
  const currentId = useAiSource();
  const [form, setForm] = useState(emptyAiForm);
  const [baseline, setBaseline] = useState(emptyAiForm);
  const [editing, setEditing] = useState<PublicProfile | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [modelQuery] = useState(() => new ModelListQuery());
  const modelList = useSyncExternalStore(modelQuery.subscribe, modelQuery.getSnapshot, modelQuery.getSnapshot);
  const working = useRef(false), mounted = useRef(true), allowLeave = useRef(false);
  const dirty = !sameAiForm(form, baseline);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const busy = Boolean(operation);
  const retest = needsAiRetest(form, editing);
  const currentAccount = () => mounted.current && profiles.namespace === aiStorageNamespace();

  useEffect(() => {
    mounted.current = true;
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current && !allowLeave.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unload);
    return () => { mounted.current = false; modelQuery.cancel(); window.removeEventListener('beforeunload', unload); };
  }, [modelQuery]);

  // A same-URL history buffer lets Back ask before Next unmounts the secret-bearing form.
  useEffect(() => {
    if (!dirty) return;
    const url = window.location.href;
    const marker = crypto.randomUUID();
    window.history.pushState({ ...window.history.state, aiEditGuard: marker }, '', url);
    let restoring = false, released = false;
    function back(event: PopStateEvent) {
      if (released) return;
      if (event.state?.aiEditGuard === marker) { restoring = false; return; }
      event.stopImmediatePropagation();
      if (!dirtyRef.current) { released = true; window.history.back(); return; }
      if (restoring) return;
      restoring = true;
      window.history.forward();
      setConfirmation({
        title: '放弃未保存的 AI 配置？', message: '未保存的表单和新填写密钥将被丢弃。已保存配置保留。', accept: '放弃修改并继续',
        proceed: () => { released = true; allowLeave.current = true; dirtyRef.current = false; window.history.go(-2); },
      });
    }
    window.addEventListener('popstate', back, true);
    return () => {
      window.removeEventListener('popstate', back, true);
      if (!released && window.location.href === url && window.history.state?.aiEditGuard === marker) window.history.back();
    };
  }, [dirty]);

  function discardGuard(proceed: () => void) {
    if (working.current) return;
    if (!dirty) { proceed(); return; }
    setConfirmation({ title: '放弃未保存的 AI 配置？', message: '未保存的表单和新填写密钥将被丢弃。已保存配置保留。', accept: '放弃修改并继续', proceed });
  }
  function openForm(profile: PublicProfile | null) {
    modelQuery.invalidate();
    setEditing(profile);
    const next = profile ? profileForm(profile) : emptyAiForm();
    setForm(next); setBaseline(next); setError(''); setNotice('');
  }
  function updateConnection(patch: Partial<ProfileInput>) {
    modelQuery.invalidate();
    setForm(current => ({ ...current, ...patch }));
  }
  function queryModels() {
    setError(''); setNotice('');
    void modelQuery.load({ id: editing?.id, revision: editing?.revision, profile: {
      provider: form.provider, baseUrl: form.baseUrl, apiKey: form.apiKey, clearApiKey: form.clearApiKey,
      protocol: form.protocol, timeoutSeconds: form.timeoutSeconds,
    } });
  }
  async function action(body: unknown) {
    const response = await cloudFetch('/api/ai/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error?.message || '操作未完成，请重试。');
    if (!result) throw new Error('工作台返回格式异常，请重试。');
    return result;
  }
  async function run(next: Operation, work: () => Promise<void>) {
    if (working.current || !currentAccount()) return;
    working.current = true; setOperation(next); setError(''); setNotice('');
    try { await work(); }
    catch (reason) {
      if (currentAccount()) {
        const step = { save: '保存配置', default: '设置默认配置', delete: '删除配置', text: '文字测试', image: '图片理解测试' }[next.kind];
        const detail = reason instanceof Error ? reason.message : '操作未完成。';
        setError(`${step}失败。${detail} 当前表单已保留，请检查提示后手动重试。`);
      }
    } finally { working.current = false; if (currentAccount()) setOperation(null); }
  }
  async function save() {
    modelQuery.cancel();
    const snapshot = { ...form };
    await run({ kind: 'save', id: editing?.id }, async () => {
      const result = await action({ action: 'save', id: editing?.id, revision: editing?.revision, profile: snapshot });
      if (!currentAccount()) return;
      openForm(result.profile);
      setNotice('配置已保存。可选择使用，或分别测试文字与图片能力。');
      await profiles.afterChange();
    });
  }
  function test(profile: PublicProfile, kind: 'text' | 'image') {
    setConfirmation({ title: kind === 'text' ? '测试文字生成' : '测试图片理解', message: probeConfirmation(profile, kind), accept: '开始测试', proceed: () => {
      void run({ kind, id: profile.id }, async () => {
        const probe = await testAiProfileConnection(profile, kind);
        if (!currentAccount()) return;
        const message = `${profile.name} · ${kind === 'text' ? '文字测试' : '图片理解测试'}：${probe.message}`;
        if (probe.status === 'passed') setNotice(message);
        else setError(message);
        await profiles.afterChange();
      });
    } });
  }
  function remove(profile: PublicProfile) {
    const proceed = () => setConfirmation({ title: '删除 AI 配置？', message: `删除“${profile.name}”后，若它是当前或默认配置，将清空选择。已有草稿保留。`, accept: '确认删除', proceed: () => {
      void run({ kind: 'delete', id: profile.id }, async () => {
        await action({ action: 'delete', id: profile.id });
        if (!currentAccount()) return;
        if (getAiSource() === profile.id) setAiSource('none', profiles.namespace);
        if (editing?.id === profile.id) openForm(null);
        await profiles.afterChange();
        if (currentAccount()) setNotice('配置已删除，请在需要时重新选择使用的配置。');
      });
    } });
    if (editing?.id === profile.id) discardGuard(proceed); else proceed();
  }

  return <AppShell disabled={busy} guardNavigation={proceed => discardGuard(() => { allowLeave.current = true; proceed(); })}>
    <main className="ai-settings">
      <header><h1>个人 AI 配置</h1><p>{data?.account || '个人设置'} · 密钥仅由后端保存。模型配置不包含联网检索服务。</p></header>
      <div className="ai-settings-current"><AiSelector disabled={busy}/></div>
      {notice && <p className="ai-notice" role="status">{notice}</p>}
      {(error || profiles.error) && <p role="alert" className="ai-error">{error || profiles.error}{profiles.error && <button type="button" onClick={() => void profiles.reload()}>重新读取配置</button>}</p>}
      <div className="ai-settings-grid">
        <section className="ai-card"><div className="ai-card-heading"><h2>我的配置</h2><button className="secondary-button" disabled={busy} onClick={() => discardGuard(() => openForm(null))}>新增配置</button></div>
          {!data && !profiles.error && <p>正在读取配置…</p>}
          {data?.profiles.length === 0 && <p>还没有 AI 配置。填写表单，保存后选择使用。</p>}
          {data?.profiles.map(profile => {
            const changed = editing?.id === profile.id && retest;
            return <article className="ai-profile" key={profile.id}>
              <div className="ai-profile-heading"><strong>{profile.name}</strong><div className="ai-badges"><span>已保存</span>{profile.id === currentId && <span>当前使用</span>}{profile.id === data.defaultId && <span>默认配置</span>}</div></div>
              <p>{profile.model}<br/>{profile.baseUrl}<br/>密钥：{profile.maskedApiKey || '未配置'}</p>
              <ProbeStatus label="文字" probe={profile.textTest} running={operation?.id === profile.id && operation.kind === 'text'} retest={changed}/>
              <ProbeStatus label="图片理解" probe={profile.imageTest} running={operation?.id === profile.id && operation.kind === 'image'} retest={changed}/>
              <div className="ai-actions">
                <button disabled={busy} onClick={() => { discardGuard(() => openForm(profile)); }}>编辑</button>
                <button disabled={busy || (profile.id === data.defaultId && profile.id === currentId)} onClick={() => void run({ kind: 'default', id: profile.id }, async () => {
                  await action({ action: 'default', id: profile.id });
                  if (!currentAccount()) return;
                  setAiSource(profile.id, profiles.namespace);
                  await profiles.afterChange();
                  if (currentAccount()) setNotice(`已将“${profile.name}”设为默认并使用，后续新任务使用此配置。`);
                })}>设为默认并使用</button>
                <button disabled={busy || changed} onClick={() => test(profile, 'text')}>测试文字</button>
                <button disabled={busy || changed} onClick={() => test(profile, 'image')}>测试图片理解</button>
                <button disabled={busy} onClick={() => remove(profile)}>删除</button>
              </div>
            </article>;
          })}
        </section>
        <section className="ai-card"><div className="ai-card-heading"><h2>{editing ? `编辑配置 · ${editing.name}` : '新增配置'}</h2><span className={dirty ? 'ai-unsaved' : 'ai-form-state'} role="status">{dirty ? '未保存' : editing ? '已保存' : '尚未填写'}</span></div>
          <form onSubmit={event => { event.preventDefault(); void save(); }}>
            <fieldset disabled={busy || !data} className="ai-form-fields">
              <label>配置名称<input required maxLength={60} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
              <label>服务类型<select value={form.provider} onChange={event => {
                const provider = event.target.value as ProfileInput['provider'];
                updateConnection({ provider, ...presets[provider], apiKey: '', clearApiKey: false });
              }}><option value="openai">OpenAI 官方</option><option value="deepseek">DeepSeek 官方</option><option value="custom">自定义／中转站</option></select></label>
              <label>API 基础地址<input required type="url" value={form.baseUrl} onChange={event => updateConnection({ baseUrl: event.target.value })}/></label>
              <p className="ai-help">填基础地址，可包含 /v1，不追加 /responses 或 /chat/completions。更换地址需重新输入对应密钥。</p>
              <label>API Key<input type="password" autoComplete="new-password" value={form.apiKey} placeholder={editing?.hasApiKey ? '已配置，留空保留原密钥' : '填写此服务的 API 密钥'} onChange={event => updateConnection({ apiKey: event.target.value, clearApiKey: false })}/></label>
              {editing?.hasApiKey && <label className="ai-check"><input type="checkbox" checked={!!form.clearApiKey} onChange={event => updateConnection({ clearApiKey: event.target.checked, apiKey: '' })}/>删除保存的密钥</label>}
              <ModelPicker state={modelList} value={form.model} canQuery={canQueryModels(form, editing)} onQuery={queryModels} onChange={model => setForm(current => ({ ...current, model }))}/>
              <p className="ai-help">{editing && !form.apiKey.trim() && (form.provider !== editing.provider || form.baseUrl.trim().replace(/\/+$/, '') !== editing.baseUrl) ? '地址或服务类型已更换，请重新填写对应密钥后获取模型。' : modelListHelp(modelList)}</p>
              {retest && <p className="ai-retest" role="status">连接或能力设置已修改，保存后需重新测试文字与图片理解。</p>}
              <details><summary>高级设置</summary>
                <label>接口格式<select value={form.protocol} onChange={event => updateConnection({ protocol: event.target.value as ProfileInput['protocol'] })}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></select></label>
                <label>结构化输出<select value={form.jsonMode} onChange={event => setForm({ ...form, jsonMode: event.target.value as ProfileInput['jsonMode'] })}><option value="schema">严格 JSON Schema</option><option value="object">JSON Object + 本地结构校验</option></select></label>
                <label>单次模型请求超时（秒）<input type="number" min={10} max={180} value={form.timeoutSeconds} onChange={event => updateConnection({ timeoutSeconds: Number(event.target.value) })}/></label>
                <label>输出 token 上限<input type="number" min={256} step={1} value={form.maxOutputTokens} onChange={event => setForm({ ...form, maxOutputTokens: Number(event.target.value) })}/></label>
                <p className="ai-help">按模型支持的范围填写。部分模型的推理也计入输出额度。修改名称、超时或输出上限会保留已通过的能力验证。</p>
                <p className="ai-help">仅支持以上两种接口格式，不额外发送温度等可选参数。</p>
              </details>
              <button className="generate-button" disabled={busy || !dirty} type="submit">{operation?.kind === 'save' ? '正在保存…' : '保存配置'}</button>
              <p className="ai-help">保存后可分别测试文字和图片能力。测试由你主动发起，可能产生少量 API 用量。</p>
            </fieldset>
          </form>
        </section>
      </div>
      {confirmation && <VideoDialog title={confirmation.title} onClose={() => setConfirmation(null)}>
        <p>{confirmation.message}</p><div className="ai-confirm-actions">
          <button type="button" className="secondary-button" onClick={() => setConfirmation(null)}>{confirmation.accept === '放弃修改并继续' ? '继续编辑' : '取消'}</button>
          <button type="button" className="generate-button" onClick={() => { const next = confirmation.proceed; setConfirmation(null); next(); }}>{confirmation.accept}</button>
        </div>
      </VideoDialog>}
    </main>
  </AppShell>;
}

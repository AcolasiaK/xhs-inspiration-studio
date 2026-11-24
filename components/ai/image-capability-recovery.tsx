'use client';

import { useEffect, useRef, useState } from 'react';
import { probeConfirmation, testAiProfileConnection } from '@/lib/ai-profile-client';
import { setAiSource } from '@/lib/ai-source';
import { aiStorageNamespace } from '@/lib/cloud/client';
import { useAiSource } from '../use-ai-source';
import { useAiProfiles } from './usage-status';

export function ImageCapabilityRecovery({ disabled, onRetry }: { disabled: boolean; onRetry: () => void }) {
  const { data, loading, error, reload, afterChange, namespace } = useAiProfiles();
  const selected = useAiSource();
  const current = data?.profiles.find(profile => profile.id === (selected || data.defaultId));
  const alternatives = data?.profiles.filter(profile =>
    profile.id !== current?.id && profile.hasApiKey && profile.imageTest.status === 'passed') ?? [];
  const controller = useRef<AbortController | null>(null);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ namespace: string; message: string } | null>(null);
  const notice = feedback?.namespace === namespace ? feedback.message : '';

  useEffect(() => () => {
    controller.current?.abort();
    controller.current = null;
  }, [namespace]);

  async function test() {
    if (!current?.hasApiKey || namespace !== aiStorageNamespace() || controller.current || !window.confirm(probeConfirmation(current, 'image'))) return;
    const request = new AbortController();
    controller.current = request;
    setTesting(true);
    setFeedback(null);
    try {
      const probe = await testAiProfileConnection(current, 'image', request.signal);
      if (!request.signal.aborted) setFeedback({ namespace, message: `${current.name} · ${probe.message}` });
    } catch (reason) {
      if (!request.signal.aborted) setFeedback({ namespace, message: reason instanceof Error ? reason.message : '测试未完成，请重试。' });
    } finally {
      if (!request.signal.aborted) {
        await afterChange();
        if (!request.signal.aborted) setTesting(false);
      }
      if (controller.current === request) controller.current = null;
    }
  }

  const busy = disabled || testing || loading;
  return <div>
    {current && <p className="personal-task-detail">当前配置为 {current.name} · {current.model}。</p>}
    <div className="personal-task-actions">
      {current?.hasApiKey && current.imageTest.status === 'passed' &&
        <button type="button" className="personal-feedback-button personal-feedback-primary" disabled={busy || Boolean(error)} onClick={onRetry}>重试生成笔记</button>}
      {current?.hasApiKey &&
        <button type="button" className="personal-feedback-button" disabled={busy || Boolean(error)} onClick={() => void test()}>{testing ? '正在测试图片理解…' : '测试当前配置的图片理解'}</button>}
      {alternatives.length > 0 && <label>切换到已验证的配置 <select value="" disabled={busy || Boolean(error)} onChange={event => {
        if (alternatives.some(profile => profile.id === event.target.value)) {
          setAiSource(event.target.value, namespace);
          setFeedback(null);
        }
      }}>
        <option value="">请选择</option>
        {alternatives.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
      </select></label>}
      <a href="/settings/ai" target="_blank" rel="noopener noreferrer">在新标签页打开 AI 设置</a>
      {error && <button type="button" className="personal-feedback-button" disabled={busy} onClick={() => void reload()}>重新读取配置</button>}
    </div>
    {(notice || error) && <p className="personal-task-detail" role="status">{[notice, error].filter(Boolean).join(' ')}</p>}
  </div>;
}

'use client';

import Link from 'next/link';
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getAiSource } from '@/lib/ai-source';
import { AiProfileResource, describeAiSelection, isSameAiRevision, type AiSelection } from '@/lib/ai-profile-client';
import { useCloud } from '../cloud/context';
import { useAiSource } from '../use-ai-source';
import { AppNavigationContext } from '../app-navigation';

const resources = new Map<string, AiProfileResource>();
export function useAiProfiles() {
  const { user, cloud } = useCloud();
  const resource = useMemo(() => {
    const key = cloud ? user?.id || "signed-out" : "local-owner";
    let value = resources.get(key);
    if (!value) { value = new AiProfileResource(key); resources.set(key, value); }
    return value;
  }, [user?.id, cloud]);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  useEffect(() => {
    void resource.load();
    const update = () => { void resource.reload(); };
    window.addEventListener('xhs-ai-profiles-updated', update);
    return () => window.removeEventListener('xhs-ai-profiles-updated', update);
  }, [resource]);
  return { ...state, reload: resource.reload, afterChange: resource.afterChange, namespace: resource.namespace };
}

export function useAiTask() {
  const profiles = useAiProfiles();
  const selected = useAiSource();
  const [active, setActive] = useState<AiSelection | null>(null);
  const current = describeAiSelection(profiles, selected);
  return {
    current, active, reload: profiles.reload, namespace: profiles.namespace,
    start() {
      const snapshot = describeAiSelection(profiles, getAiSource());
      setActive(snapshot);
      return snapshot;
    },
    finish() { setActive(null); },
  };
}

export function AiUsageStatus({ task }: { task: ReturnType<typeof useAiTask> }) {
  const navigation = useContext(AppNavigationContext);
  const shown = task.active || task.current;
  return <div className="ai-usage-status" role="status">
    <span>{shown.name
      ? `${task.active ? '本次请求使用' : '当前使用'}：${shown.name} · ${shown.model}`
      : task.active ? '本次请求未选定可用配置' : shown.issue}</span>
    {shown.name && shown.issue && <span>{shown.issue}</span>}
    {task.active && !isSameAiRevision(task.active, task.current) && <span>新选择用于下次请求。</span>}
    {!task.active && <Link href="/settings/ai" aria-disabled={navigation?.disabled || undefined} onNavigate={event => {
      if (navigation) { event.preventDefault(); navigation.navigate('/settings/ai'); }
    }}>AI 设置</Link>}
    {!task.active && /读取失败/.test(shown.issue) && <button type="button" onClick={() => void task.reload()}>重新读取</button>}
  </div>;
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudFetch } from '@/lib/cloud/client';
import { aiSourceHeader } from '@/lib/ai-source';
import { styleLearningRequestSchema, type StyleLearningRequest } from '@/lib/personal/style-learning';
import { styleJobSnapshotSchema, type StyleJobSettings, type StyleJobSnapshot, type StartStyleIntegration } from '@/lib/personal/style-learning-job';

const endpoint = '/api/personal/styles/learning-jobs';
class JobRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function readJob(url: string, init?: RequestInit) {
  const response = await cloudFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  if (!response.ok) throw new JobRequestError(value.error?.message || '暂时无法连接工作台，分析进度保留。', response.status);
  return value;
}

/** Polling is read-only: reconnecting or mounting never starts an AI request. */
export function useStyleLearningJob(enabled: boolean) {
  const [job, setJob] = useState<StyleJobSnapshot | null>(null);
  const [input, setInput] = useState<StyleLearningRequest | null>(null);
  const [available, setAvailable] = useState<StyleJobSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [pending, setPending] = useState(false);
  const mounted = useRef(false), acting = useRef(false), currentId = useRef('');
  const accept = useCallback((value: unknown) => {
    const next = styleJobSnapshotSchema.parse(value);
    if (!mounted.current || currentId.current !== next.id) return;
    setJob(old => old?.id === next.id && old.updatedAt > next.updatedAt ? old : next);
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readJob(endpoint).then(value => {
      if (!cancelled && !currentId.current) {
        const jobs = styleJobSnapshotSchema.array().parse(value.jobs);
        setAvailable(jobs.find(j => j.status === 'running') ?? jobs[0] ?? null);
      }
    }).catch(() => { /* Opening the editor must not replace editable content with a history error. */ });
    return () => { cancelled = true; };
  }, [enabled]);
  const refresh = useCallback(async () => {
    const id = currentId.current;
    if (!id) return;
    try {
      const value = await readJob(`${endpoint}/${id}`);
      if (mounted.current && currentId.current === id) { accept(value.job); setConnectionError(''); }
    } catch (error) {
      if (mounted.current && currentId.current === id) {
        if (error instanceof JobRequestError && error.status === 404) {
          currentId.current = ''; setConnectionError('');
        } else setConnectionError('暂时无法读取进度，后台任务不会因此重做。正在重新连接，也可稍后回来查看。');
      }
    }
  }, [accept]);
  useEffect(() => {
    if (!enabled || job?.status !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!cancelled) timer = setTimeout(poll, 1800); };
    timer = setTimeout(poll, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, job?.id, job?.status, refresh]);

  async function start(nextInput: StyleLearningRequest, settings: StyleJobSettings, profileId: string) {
    if (acting.current) return;
    acting.current = true; setPending(true); setConnectionError('');
    const id = crypto.randomUUID(); currentId.current = id;
    setInput(nextInput); setJob(null);
    try {
      let value;
      try { value = await readJob(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...aiSourceHeader(profileId) }, body: JSON.stringify({ id, input: nextInput, settings }) }); }
      catch (error) {
        // The start response may be lost after the server accepted the task. Lookup
        // the same id instead of submitting another chargeable request.
        try { value = await readJob(`${endpoint}/${id}`); } catch { throw error; }
      }
      if (mounted.current) { accept(value.job); setAvailable(null); }
    } catch (error) {
      if (mounted.current) {
        if (error instanceof JobRequestError && error.status < 500) { currentId.current = ''; setConnectionError(''); }
        else setConnectionError('未确认任务状态，请先点“重新连接查看进度”。如果服务已接收，已完成步骤仍会保留。');
      }
      throw error;
    } finally { acting.current = false; if (mounted.current) setPending(false); }
  }
  async function startIntegration(request: Omit<StartStyleIntegration, 'id'>, profileId: string) {
    if (acting.current) return;
    acting.current = true; setPending(true); setConnectionError('');
    const id = crypto.randomUUID(); currentId.current = id;
    setJob(null);
    try {
      let value;
      try {
        value = await readJob('/api/personal/styles/integrations', { method: 'POST', headers: { 'Content-Type': 'application/json', ...aiSourceHeader(profileId) }, body: JSON.stringify({ id, ...request }) });
      } catch (error) {
        // A lost response must never trigger a second paid synthesis.
        try { value = await readJob(`${endpoint}/${id}`); } catch { throw error; }
      }
      if (mounted.current) { accept(value.job); setAvailable(null); }
    } catch (error) {
      if (mounted.current) {
        if (error instanceof JobRequestError && error.status < 500) { currentId.current = ''; setConnectionError(''); }
        else setConnectionError('未确认综合任务状态，请重新连接查看进度，避免重复提交。');
      }
      throw error;
    } finally { acting.current = false; if (mounted.current) setPending(false); }
  }
  async function restore(id: string) {
    if (acting.current) return;
    acting.current = true; setPending(true);
    try {
      const value = await readJob(`${endpoint}/${id}?input=1`), nextInput = styleLearningRequestSchema.parse(value.input);
      if (mounted.current) {
        currentId.current = id; setInput(nextInput); accept(value.job); setAvailable(null); setConnectionError('');
      }
      return { input: nextInput, job: styleJobSnapshotSchema.parse(value.job) };
    } finally { acting.current = false; if (mounted.current) setPending(false); }
  }
  async function action(action: 'pause' | 'resume', settings?: StyleJobSettings) {
    if (!currentId.current || acting.current) return;
    acting.current = true; setPending(true);
    const id = currentId.current;
    try {
      const value = await readJob(`${endpoint}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(action === 'resume' ? { settings } : {}) }) });
      if (mounted.current && currentId.current === id) { accept(value.job); setConnectionError(''); }
    } catch (error) { await refresh(); throw error; }
    finally { acting.current = false; if (mounted.current) setPending(false); }
  }
  return { job, input, available, pending, connectionError, start, startIntegration, restore, action, refresh };
}

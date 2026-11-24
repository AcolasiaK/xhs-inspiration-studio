'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AiUsageStatus, useAiTask } from '../ai/usage-status';
import { cloudFetch } from '@/lib/cloud/client';
import { aiSourceHeader } from '@/lib/ai-source';
import { outputTokenLimitSchema } from '@/lib/ai-config';
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, MAX_STYLE_REFERENCES, compileLearnedRules, defaultLearnedSelection, normalizeXhsReferenceLink, referenceImagesSchema, styleAnalysisSchema, styleLearningReferencesSchema, styleLearningInputError, styleLearningRecoverySchema, type StyleLearningRecovery, type StyleAnalysis, type StyleReference, type StyleReferenceImage } from '@/lib/personal/style-learning';
import { compressImages, prepareImage } from '@/lib/images';
import { ruleContentSchema, ruleSections, type RuleContent, type RuleSection, type StyleRecord } from '@/lib/personal/style-rules';
import { DEFAULT_STYLE_STEP_TIMEOUT, styleJobSettingsSchema, styleImageBatches, type StyleJobSnapshot } from '@/lib/personal/style-learning-job';
import { compileIntegratedRules, resolvedIntegrationSections, type StyleIntegrationSnapshot } from '@/lib/personal/style-integration';
import type { LearningResolutions, LearningSelection } from '@/lib/personal/style-learning-memory';
import { useStyleLearningJob } from './use-style-learning-job';
import { StyleIntegrationReview } from './style-integration-review';

export type LearnedStyleTarget = { id: string; revision: number } | null;
export type LearnedStyleAdoption = { jobId: string; adoptionId: string; selection?: LearningSelection; resolutions: LearningResolutions };
type TrialKind = 'body' | 'title' | 'captions';
type Props = {
  styles: StyleRecord[]; disabled: boolean; cloud: boolean; active?: boolean;
  onBusy: (value: boolean) => void; onDirty: (value: boolean) => void;
  onApply: (content: RuleContent, target: LearnedStyleTarget, trialKind: TrialKind, adoption?: LearnedStyleAdoption) => Promise<boolean | undefined>;
  onRestoreTarget: (styleId: string) => void;
  onClose: () => void;
};
type IntegrationReview = { snapshot: StyleIntegrationSnapshot; learned: RuleContent; resolutions: LearningResolutions; hiddenExamples?: RuleContent['examples']; removedExampleIds?: string[] };
type Proposal = { content: RuleContent; target: LearnedStyleTarget; before?: RuleContent; trialKind: TrialKind; adoption?: LearnedStyleAdoption; integration?: IntegrationReview };
type ReferenceDraft = StyleReference & { mode: 'text' | 'link'; link: string; readLink: string };
const newReference = (id: string): ReferenceDraft => ({ id, title: '', text: '', images: [], url: '', mode: 'text', link: '', readLink: '' });
const titleFacets = { expression: '表达方式', language: '语言特点', appeal: '吸引力来源', relation: '与正文的关系' } as const;
const portraitFields = { body: '正文风格', captions: '逐图配文风格', imageText: '图文如何配合', transfer: '换一组素材时' } as const;
const trialFor = (scopes: RuleSection[]): TrialKind => scopes.every(scope => scope === 'title') ? 'title' : scopes.includes('captions') ? 'captions' : 'body';
function selectedAnalysis(analysis: StyleAnalysis, selection: LearningSelection): StyleAnalysis {
  return { ...analysis, traits: analysis.traits.map((trait, index) => ({ ...trait, rule: selection.find(item => item.index === index)?.rule ?? trait.rule })) };
}
function integrationProposal(job: StyleJobSnapshot, references: StyleReference[]): Proposal {
  const integration = job.integration;
  if (!integration?.proposal || !job.analysis) throw new Error('综合方案尚未完整返回，请重新连接查看进度。');
  const analysis = selectedAnalysis(job.analysis, integration.selection);
  const learned = compileLearnedRules(analysis, integration.selection.map(item => item.index), undefined, references);
  return { content: compileIntegratedRules(integration.proposal, integration.baseline, learned, [], false), target: { id: integration.target.styleId, revision: integration.target.revision }, before: structuredClone(integration.baseline), trialKind: trialFor(integration.selection.map(item => analysis.traits[item.index].scope)),
    adoption: { jobId: job.id, adoptionId: crypto.randomUUID(), resolutions: [] }, integration: { snapshot: integration, learned, resolutions: [] } };
}

/** Change only this conflict's new examples; manual edits and removals remain authoritative. */
export function reconcileIntegrationExamples(current: RuleContent, integration: IntegrationReview, scope: RuleSection, resolutions: LearningResolutions) {
  const allowed = compileIntegratedRules(integration.snapshot.proposal!, integration.snapshot.baseline, integration.learned, resolutions, false).examples;
  const baseIds = new Set(integration.snapshot.baseline.examples.map(example => example.id));
  const learnedIds = new Set(integration.learned.examples.map(example => example.id));
  const isNewHere = (example: RuleContent['examples'][number]) => example.scope === scope && learnedIds.has(example.id) && !baseIds.has(example.id);
  const candidates = allowed.filter(isNewHere), allowedIds = new Set(candidates.map(example => example.id));
  const hidden = new Map((integration.hiddenExamples ?? []).map(example => [example.id, example]));
  const examples = current.examples.filter(example => {
    if (!isNewHere(example) || allowedIds.has(example.id)) return true;
    hidden.set(example.id, example); // Keep the user's edited text when hiding a new example.
    return false;
  });
  for (const candidate of candidates) {
    if (examples.length >= 8) break;
    if (integration.removedExampleIds?.includes(candidate.id)) continue;
    const example = hidden.get(candidate.id) ?? candidate;
    if (!examples.some(existing => existing.id === example.id || existing.scope === example.scope && existing.output === example.output)) examples.push(example);
  }
  return { examples, hiddenExamples: [...hidden.values()] };
}

export function StyleLearning({ styles, disabled, cloud, active = true, onBusy, onDirty, onApply, onRestoreTarget, onClose }: Props) {
  const aiTask = useAiTask();
  const jobs = useStyleLearningJob(active && !cloud);
  const { job, input: jobInput } = jobs;
  const jobTargetVersion = job?.integration ? styles.find(style => style.id === job.integration!.target.styleId)?.versions.find(version => version.snapshot.versionId === job.integration!.target.versionId)?.snapshot.version : undefined;
  const localBusy = jobs.pending || job?.status === 'running';
  const [waitMinutes, setWaitMinutes] = useState(String(DEFAULT_STYLE_STEP_TIMEOUT / 60));
  const [resumeMinutes, setResumeMinutes] = useState(String(DEFAULT_STYLE_STEP_TIMEOUT / 60));
  const [resumeTokens, setResumeTokens] = useState('');
  const handledJob = useRef(''), shownFailure = useRef('');
  const [drafts, setDrafts] = useState<ReferenceDraft[]>([newReference('primary')]);
  const [activeId, setActiveId] = useState('primary');
  const current = drafts.find(r => r.id === activeId) ?? drafts[0];
  const references = useMemo(() => drafts.map(({ id, title, text, images, url }) => ({ id, title, text, images, url })), [drafts]);
  const [preferences, setPreferences] = useState(''), [analysis, setAnalysis] = useState<StyleAnalysis | null>(null);
  const [analyzed, setAnalyzed] = useState<{ signature: string; references: StyleReference[] }>({ signature: '', references: [] }), [selected, setSelected] = useState<number[]>([]);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [target, setTarget] = useState('new'), [proposal, setProposal] = useState<Proposal | null>(null);
  // The learning target is independent of the parent's editor, which may fall
  // back to the first style after a list refresh. Never redirect a chosen target.
  const record = styles.find(style => style.id === target) ?? null;
  const content = record?.versions.find(version => version.snapshot.versionId === record.draftVersionId)?.snapshot.content;
  const [working, setWorking] = useState<'read' | 'analyze' | 'save' | 'images' | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState<(StyleLearningRecovery & { signature: string; profileId: string; profileRevision: string; partialFromEarlierAttempt: boolean }) | null>(null);
  const [outputLimit, setOutputLimit] = useState(''), [retryLimit, setRetryLimit] = useState('');
  const controller = useRef<AbortController | null>(null), running = useRef(false), alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null), resultHeading = useRef<HTMLHeadingElement>(null), errorMessage = useRef<HTMLParagraphElement>(null);
  const recoveryPanel = useRef<HTMLDetailsElement>(null), sourcePanel = useRef<HTMLDetailsElement>(null);
  const signature = useMemo(() => JSON.stringify([references, preferences]), [references, preferences]);
  const pendingLink = drafts.some(r => r.mode === 'link' && r.link.trim() !== '' && r.link !== r.readLink);
  const fresh = analysis && analyzed.signature === signature && !pendingLink;
  const conflict = proposal?.target && (record?.id !== proposal.target.id || record.revision !== proposal.target.revision || Boolean(proposal.integration && record.draftVersionId !== proposal.integration.snapshot.target.versionId));
  const selectedRules = useMemo<LearningSelection>(() => selected.slice().sort((a, b) => a - b).flatMap(index => analysis?.traits[index] ? [{ index, rule: analysis.traits[index].rule.trim() }] : []), [selected, analysis]);
  const unresolvedConflicts = proposal?.integration?.snapshot.proposal?.conflicts.filter(item => !proposal.integration!.resolutions.some(choice => choice.conflictId === item.id)).length ?? 0;
  const totalImages = references.reduce((n, r) => n + r.images.length, 0);
  const locked = disabled || Boolean(working) || localBusy || Boolean(jobs.connectionError);
  const normalizedReferences = useMemo(() => styleLearningReferencesSchema.safeParse(references), [references]);
  const matchesReferences = Boolean(jobInput && normalizedReferences.success && JSON.stringify([jobInput.references, jobInput.preferences.trim()]) === JSON.stringify([normalizedReferences.data, preferences.trim()]) && !pendingLink);
  const matchesJob = matchesReferences && (!job?.integration || (target === job.integration.target.styleId && record?.id === job.integration.target.styleId && record.revision === job.integration.target.revision && record.draftVersionId === job.integration.target.versionId && JSON.stringify(selectedRules) === JSON.stringify(job.integration.selection.slice().sort((a, b) => a.index - b.index))));
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { onBusy(Boolean(working) || localBusy); }, [working, localBusy, onBusy]);
  useEffect(() => {
    if (!job || !jobInput) return;
    if (job.status === 'completed' && job.analysis && matchesJob && handledJob.current !== job.id) {
      // Apply one accepted background result on the next frame. If the source or
      // target changes before then, cleanup prevents a stale result replacing edits.
      const frame = requestAnimationFrame(() => {
        if (!alive.current) return;
        handledJob.current = job.id;
        if (job.integration) {
          try { setProposal(integrationProposal(job, jobInput.references)); setNotice('综合方案已完成。请核对整套规则和变化，明确处理冲突后再认可保存。'); }
          catch (error) { setError(error instanceof Error ? error.message : '综合方案无法整理，原有规则未改变。'); }
        } else {
          setAnalysis(job.analysis!); setAnalyzed({ signature, references: jobInput.references }); setSelected(defaultLearnedSelection(job.analysis!)); setAnalysisJobId(job.id); setProposal(null);
          setNotice('风格已提炼。候选特点默认不勾选，请选择你希望长期保留的表达方式。');
        }
        setRecovery(null); onDirty(true);
        requestAnimationFrame(() => (resultHeading.current ?? heading.current)?.focus());
      });
      return () => cancelAnimationFrame(frame);
    }
    if ((job.status === 'failed' || job.status === 'paused') && shownFailure.current !== job.updatedAt) {
      shownFailure.current = job.updatedAt;
      setResumeMinutes(String(job.error?.code === 'TIMEOUT' ? Math.min(1440, job.settings.timeoutSeconds / 30) : job.settings.timeoutSeconds / 60));
      setResumeTokens(String(job.recovery?.suggestedTokens ?? job.settings.maxOutputTokens ?? ''));
    }
  }, [job, jobInput, matchesJob, signature, onDirty]);
  function showError(message: string) {
    setError(message);
    if (message) requestAnimationFrame(() => { errorMessage.current?.focus({ preventScroll: true }); errorMessage.current?.scrollIntoView({ block: 'center' }); });
  }
  function changed() { onDirty(true); setProposal(null); showError(''); setNotice(''); }
  function updateCurrent(patch: Partial<ReferenceDraft>) { setDrafts(old => old.map(r => r.id === current.id ? { ...r, ...patch } : r)); }
  function focusResult() { requestAnimationFrame(() => (resultHeading.current ?? heading.current)?.focus()); }
  function checkImages(images: StyleReferenceImage[]) {
    const all = references.filter(r => r.id !== current.id).flatMap(r => r.images).concat(images);
    if (all.length > MAX_REFERENCE_IMAGES) throw new Error(`本轮参考图片合计最多 ${MAX_REFERENCE_IMAGES} 张，请先移除不需要的图片。`);
    if (all.reduce((sum, i) => sum + i.dataUrl.length, 0) > MAX_REFERENCE_IMAGE_BYTES) throw new Error('参考图片总量较大，请减少图片后再试。');
  }
  async function addImages(files: File[]) {
    if (!files.length || running.current || disabled) return;
    if (files.length + totalImages > MAX_REFERENCE_IMAGES) { showError(`本轮参考图片合计最多 ${MAX_REFERENCE_IMAGES} 张。`); return; }
    running.current = true; setWorking('images'); showError('');
    try {
      const added: StyleReferenceImage[] = [];
      for (const file of files) {
        const image = await prepareImage(file);
        try {
          const [blob] = await compressImages([image], () => undefined);
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败，请重试。')); reader.readAsDataURL(blob);
          });
          added.push({ id: image.id, dataUrl, caption: '' });
        } finally { URL.revokeObjectURL(image.preview); }
      }
      const images = referenceImagesSchema.parse([...current.images, ...added]); checkImages(images);
      if (alive.current) { changed(); updateCurrent({ images }); }
    } catch (e) { if (alive.current) showError(e instanceof Error ? e.message : '图片读取失败，已有参考图保留。'); }
    finally { running.current = false; if (alive.current) { setWorking(null); } }
  }
  async function request(kind: 'read' | 'analyze', retryTokens?: number) {
    if (running.current || disabled || localBusy) return;
    let validatedReferences = references;
    const maxOutputTokens = kind === 'analyze' ? retryTokens ?? (outputLimit.trim() ? Number(outputLimit) : undefined) : undefined;
    if (maxOutputTokens !== undefined && !outputTokenLimitSchema.safeParse(maxOutputTokens).success) { showError('本次输出上限请填写不小于 256 的整数。'); return; }
    if (kind === 'read') {
      try { normalizeXhsReferenceLink(current.link); } catch (e) { showError((e as Error).message); return; }
      if ((current.title.trim() || current.text.trim() || current.images.length) && !window.confirm('读取成功后会替换这篇参考的标题、正文和配图，继续读取吗？')) return;
    } else {
      const parsed = styleLearningReferencesSchema.safeParse(references);
      if (!parsed.success) { showError(styleLearningInputError(parsed.error)); return; }
      if (pendingLink) { showError('有新链接尚未读取，请先读取，或切换为粘贴文案。'); return; }
      validatedReferences = parsed.data;
    }
    // Local analysis is a persistent task; only the short start/status requests
    // belong to the page. Closing this page does not abort paid work in flight.
    if (kind === 'analyze' && !cloud) {
      const settings = styleJobSettingsSchema.safeParse({ timeoutSeconds: Number(waitMinutes) * 60, maxOutputTokens });
      if (!settings.success) { showError('每步等待时间请填写 10 秒到 24 小时之间的时长，输出上限需为不小于 256 的整数。'); return; }
      const keepPrevious = analysis && analyzed.references.every(old => validatedReferences.some(ref => ref.id === old.id && JSON.stringify(ref) === JSON.stringify(old)));
      running.current = true; showError(''); setNotice('');
      const selection = aiTask.start();
      try {
        await jobs.start({ references: validatedReferences, preferences, ...(keepPrevious ? { previous: analysis } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }, settings.data, selection.id);
        setRecovery(null); setProposal(null); onDirty(true);
      } catch (e) { showError(e instanceof TypeError || (e instanceof Error && e.name === 'TimeoutError') ? '暂时未能确认任务状态，参考内容保留。请重新连接查看进度。' : e instanceof Error ? e.message : '任务启动未确认，请先重新连接查看进度。'); }
      finally { running.current = false; aiTask.finish(); }
      return;
    }
    const abort = new AbortController(); controller.current = abort;
    running.current = true; setWorking(kind); showError(''); setNotice('');
    const selection = kind === 'analyze' ? aiTask.start() : undefined;
    const source = selection?.id;
    // Carry calibration forward only when every previously analyzed sample is still intact.
    const keepPrevious = analysis && analyzed.references.every(old => validatedReferences.some(ref => ref.id === old.id && JSON.stringify(ref) === JSON.stringify(old)));
    try {
      const response = await cloudFetch(`/api/personal/styles/${kind === 'read' ? 'reference' : 'analyze'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(source ? aiSourceHeader(source) : {}) },
        body: JSON.stringify(kind === 'read' ? { link: current.link } : { references: validatedReferences, preferences, ...(keepPrevious ? { previous: analysis } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}) }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(kind === 'read' ? 245000 : 195000)]),
      });
      const value = await response.json();
      abort.signal.throwIfAborted();
      if (!alive.current) return;
      if (!response.ok) {
        const recoverable = styleLearningRecoverySchema.safeParse(value.recovery);
        if (kind === 'analyze' && recoverable.success) {
          setRecovery(old => ({ ...recoverable.data, partial: recoverable.data.partial.length ? recoverable.data.partial : old?.partial ?? [], partialFromEarlierAttempt: !recoverable.data.partial.length && Boolean(old?.partial.length), signature, profileId: selection!.id, profileRevision: selection!.revision }));
          setRetryLimit(String(recoverable.data.suggestedTokens)); setProposal(null); onDirty(true);
          requestAnimationFrame(() => { if (recoveryPanel.current) { recoveryPanel.current.open = true; recoveryPanel.current.querySelector('summary')?.focus(); recoveryPanel.current.scrollIntoView({ block: 'start' }); } });
          return;
        }
        throw new Error(value.error?.message || '处理失败，当前输入和结果保留。');
      }
      if (kind === 'read') {
        const images = referenceImagesSchema.parse(value.images ?? []); checkImages(images);
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        const text = typeof value.text === 'string' ? value.text.trim() : '';
        const body = title && text.startsWith(title + '\n') ? text.slice(title.length).trim() : text;
        const ref = { id: current.id, title, text: body, images, url: typeof value.url === 'string' ? value.url : '' };
        const parsed = styleLearningReferencesSchema.safeParse([...references.filter(r => r.id !== current.id && (r.title.trim() || r.text.trim() || r.images.length)), ref]);
        if (!parsed.success) throw new Error(styleLearningInputError(parsed.error));
        updateCurrent({ ...ref, readLink: current.link }); setProposal(null); onDirty(true);
        const warnings = Array.isArray(value.warnings) ? value.warnings.filter((s: unknown) => typeof s === 'string').join(' ') : '';
        setNotice(`已读取标题、正文${images.length ? `和 ${images.length} 张配图` : ''}，核对后可一起提炼。${warnings ? ' ' + warnings : ''}`);
      } else {
        const next = styleAnalysisSchema.parse(value.analysis);
        setAnalysis(next); setAnalyzed({ signature, references: validatedReferences }); setSelected(defaultLearnedSelection(next)); setAnalysisJobId(null); setProposal(null); setRecovery(null); onDirty(true);
        setNotice('风格已提炼。候选特点默认不勾选，请选择你希望长期保留的表达方式。'); focusResult();
      }
    } catch (e) {
      if (alive.current) showError(abort.signal.aborted ? '已取消，当前输入和上次结果保留。' : e instanceof Error && e.name === 'TimeoutError' ? '等待超时，当前输入和上次结果保留，请稍后重试。' : e instanceof Error ? e.message : '处理失败，当前内容保留。');
    } finally {
      controller.current = null; running.current = false;
      if (alive.current) { setWorking(null); if (kind === 'analyze') aiTask.finish(); }
    }
  }
  async function restoreJob(id: string) {
    if (running.current || jobs.pending) return;
    if (references.some(r => r.title || r.text || r.images.length) && !window.confirm('恢复会切换为这个任务保存的参考、补充要求与目标，当前未保存的候选和取舍会被替换，继续吗？')) return;
    try {
      const restored = await jobs.restore(id);
      if (!restored) return;
      const { input, job: restoredJob } = restored;
      handledJob.current = '';
      setDrafts(input.references.map(ref => ({ ...ref, mode: 'text', link: ref.url, readLink: ref.url })));
      setActiveId(input.references[0].id); setPreferences(input.preferences); setProposal(null);
      if (restoredJob.integration && restoredJob.analysis) {
        const integration = restoredJob.integration;
        setTarget(integration.target.styleId); onRestoreTarget(integration.target.styleId);
        setAnalysis(selectedAnalysis(restoredJob.analysis, integration.selection)); setSelected(integration.selection.map(item => item.index)); setAnalysisJobId(integration.sourceJobId);
        setAnalyzed({ signature: JSON.stringify([input.references, input.preferences]), references: input.references });
        if (restoredJob.status === 'completed' && integration.proposal) { setProposal(integrationProposal(restoredJob, input.references)); handledJob.current = restoredJob.id; }
      } else { setTarget('new'); setAnalysisJobId(null); }
      onDirty(true); showError(''); setNotice('已找回本机任务。查看进度不调用 AI；继续未完成步骤需要点击确认。');
    } catch (e) { showError(e instanceof Error ? e.message : '任务读取失败，请重试。'); }
  }
  async function resumeJob() {
    if (!job || !matchesJob || jobs.pending) return;
    const settings = styleJobSettingsSchema.safeParse({ timeoutSeconds: Number(resumeMinutes) * 60, maxOutputTokens: resumeTokens.trim() ? Number(resumeTokens) : job.settings.maxOutputTokens });
    if (!settings.success) { showError('请检查本次等待时间和输出上限。等待时间应为 10 秒到 24 小时，输出上限至少 256。'); return; }
    try { showError(''); await jobs.action('resume', settings.data); setWaitMinutes(resumeMinutes); setOutputLimit(String(settings.data.maxOutputTokens ?? '')); }
    catch (e) { showError(e instanceof Error ? e.message : '未确认是否继续，请先重新连接查看进度。'); }
  }
  async function pauseJob() {
    try { await jobs.action('pause'); }
    catch (e) { showError(e instanceof Error ? e.message : '暂停请求未确认，请重新连接查看进度。'); }
  }
  async function integrate() {
    if (running.current || disabled || localBusy || !fresh || !analysis || !record) return;
    if (cloud || !analysisJobId) { showError('结合已有风格需要本机可恢复的完整分析。请先在本机完成或找回本轮分析；旧结果仍可新建风格。'); return; }
    const settings = styleJobSettingsSchema.safeParse({ timeoutSeconds: Number(waitMinutes) * 60, maxOutputTokens: outputLimit.trim() ? Number(outputLimit) : undefined });
    if (!settings.success) { showError('请检查本次等待时间和输出上限。'); return; }
    running.current = true; showError(''); setNotice('');
    const aiSelection = aiTask.start();
    try {
      await jobs.startIntegration({ sourceJobId: analysisJobId, target: { styleId: record.id, revision: record.revision, versionId: record.draftVersionId }, selection: selectedRules, settings: settings.data }, aiSelection.id);
      setProposal(null); setRecovery(null); onDirty(true);
    } catch (error) { showError(error instanceof Error ? error.message : '综合任务未确认，请重新连接查看进度。'); }
    finally { running.current = false; aiTask.finish(); }
  }
  function convert() {
    if (!fresh || !analysis || disabled) return;
    try {
      if (target !== 'new') {
        if (!record) { showError('所选风格已删除或不可用，请重新选择要综合的风格。参考与分析仍保留。'); return; }
        if (job?.integration?.proposal && job.status === 'completed' && matchesJob) { setProposal(integrationProposal(job, analyzed.references)); focusResult(); }
        else void integrate();
        return;
      }
      const next = compileLearnedRules(analysis, selected, undefined, analyzed.references);
      const scopes = selected.map(i => analysis.traits[i]?.scope);
      setProposal({ content: next, target: null, trialKind: trialFor(scopes), ...(analysisJobId && !cloud ? { adoption: { jobId: analysisJobId, adoptionId: crypto.randomUUID(), selection: selectedRules, resolutions: [] } } : {}) });
      showError(''); setNotice('规则已整理，可直接修改。保存后进入试生成，尚不启用。'); onDirty(true); focusResult();
    } catch (e) { showError((e as Error).message); }
  }
  function resolveConflict(conflictId: string, optionId: string) {
    if (!proposal?.integration || !proposal.adoption || locked) return;
    const integration = proposal.integration, plan = integration.snapshot.proposal!;
    const item = plan.conflicts.find(conflict => conflict.id === conflictId), option = item?.options.find(option => option.id === optionId);
    if (!item || !option) return;
    const expected = resolvedIntegrationSections(plan, integration.resolutions, false)[item.scope];
    if (proposal.content.sections[item.scope] !== expected && !window.confirm(`「${ruleSections[item.scope]}」已有手动修改。改选会用这个选项的完整规则替换该栏目，继续吗？`)) return;
    const resolutions = [...integration.resolutions.filter(choice => choice.conflictId !== conflictId), { conflictId, optionId }];
    const reconciled = reconcileIntegrationExamples(proposal.content, integration, item.scope, resolutions);
    setProposal({ ...proposal, content: { ...proposal.content, examples: reconciled.examples, sections: { ...proposal.content.sections, [item.scope]: option.text } }, integration: { ...integration, resolutions, hiddenExamples: reconciled.hiddenExamples }, adoption: { ...proposal.adoption, resolutions } });
    onDirty(true); showError('');
  }
  function removeExample(id: string) {
    if (!proposal || locked) return;
    setProposal({ ...proposal, content: { ...proposal.content, examples: proposal.content.examples.filter(example => example.id !== id) }, ...(proposal.integration ? { integration: { ...proposal.integration, removedExampleIds: [...new Set([...(proposal.integration.removedExampleIds ?? []), id])] } } : {}) });
    onDirty(true);
  }
  async function save() {
    if (!proposal || running.current || disabled || conflict || unresolvedConflicts) return;
    if (proposal.integration) {
      try { compileIntegratedRules(proposal.integration.snapshot.proposal!, proposal.integration.snapshot.baseline, proposal.integration.learned, proposal.integration.resolutions); }
      catch (error) { showError(error instanceof Error ? error.message : '请先完成冲突取舍。'); return; }
    }
    const parsed = ruleContentSchema.safeParse(proposal.content);
    if (!parsed.success) { showError('请检查风格名称与规则长度，规则和示例合计最多 24000 字符。'); return; }
    running.current = true; setWorking('save'); showError('');
    try {
      if (await onApply(parsed.data, proposal.target, proposal.trialKind, proposal.adoption)) { onDirty(false); setNotice('规则已保存为草稿，可继续调整后再次试生成。'); setProposal(null); }
      else showError('规则尚未保存，预览保留。请查看页面提示并重试。');
    } catch (e) { showError(e instanceof Error ? e.message : '保存失败，规则预览保留。'); }
    finally { running.current = false; if (alive.current) { setWorking(null); } }
  }
  function updateTrait(index: number, rule: string) {
    if (!analysis) return;
    changed(); setAnalysis({ ...analysis, traits: analysis.traits.map((t, i) => i === index ? { ...t, rule } : t) });
  }
  function referenceLabel(id: string) { const index = analyzed.references.findIndex(r => r.id === id); return `参考 ${index + 1}${analyzed.references[index]?.title ? ` · ${analyzed.references[index].title}` : ''}`; }
  return <section className="style-learning" aria-label="从笔记学习风格">
    <div className="style-learning-heading"><div><p className="style-learning-step">{proposal ? '03 / 审阅规则草稿' : analysis ? '02 / 风格画像与校准' : '01 / 提供参考'}</p><h2 ref={heading} tabIndex={-1}>{proposal?.integration ? '审阅重新综合后的整套规则' : proposal ? '把喜欢的风格变成规则' : '从笔记学习风格'}</h2></div><button type="button" className="text-button" disabled={locked} onClick={onClose}>返回规则管理</button></div>
    {error && <p ref={errorMessage} tabIndex={-1} className="storage-error" role="alert">{error}</p>}
    {notice && <p className="style-learning-notice" role="status">{notice}</p>}
    {!cloud && jobs.available && !job && <div className="style-learning-notice" role="status"><p>本机保留了一次{jobs.available.status === 'completed' ? '已完成' : '未完成'}的分析：{jobs.available.completedSteps} / {jobs.available.totalSteps} 步。</p><button type="button" className="secondary-button" disabled={locked} onClick={() => void restoreJob(jobs.available!.id)}>找回上次分析与参考</button><p className="field-hint">找回和查看不会调用 AI。</p></div>}
    {!cloud && jobs.connectionError && <div className="storage-warning" role="status"><p>{jobs.connectionError}</p><button type="button" className="secondary-button" disabled={jobs.pending} onClick={() => { showError(''); void jobs.refresh(); }}>重新连接查看进度</button></div>}
    {!cloud && job && <section className="style-learning-recovery" aria-label="分步分析进度">
      <h3>{job.integration ? job.status === 'running' ? '正在结合已有风格重新综合' : job.status === 'completed' ? '规则综合已完成' : '综合进度已保存，要继续吗？' : job.status === 'running' ? '正在分步提炼风格' : job.status === 'completed' ? '分步分析已完成' : '分析进度已保存，要继续吗？'}</h3>
      {job.integration && <p>本次目标：「{job.integration.baseline.name}」的已绑定草稿{jobTargetVersion ? ` v${jobTargetVersion}` : ''}。{job.integration.historySourceCount ? `已关联 ${job.integration.historySourceCount} 篇历史来源。` : '旧风格未关联历史原文，本轮先结合已有规则和示例。'}</p>}
      <p role="status">已完成 <strong>{job.completedSteps} / {job.totalSteps}</strong> 步 · {job.stageLabel}</p>
      <progress aria-label="分步分析进度" value={job.completedSteps} max={job.totalSteps}/>
      <p className="field-hint">本次使用：{job.profile.name}。每步最多等待 {job.settings.timeoutSeconds / 60} 分钟{job.settings.maxOutputTokens ? `，输出上限 ${job.settings.maxOutputTokens.toLocaleString('en-US')} token` : ''}。已完成步骤保存在本机，刷新后可找回。</p>
      {job.status === 'running' ? <><p>可以等待完成，或暂停并保留进度。关闭页面后后台仍会继续本次分析，直到完成、失败或主动暂停。</p><button type="button" className="secondary-button" disabled={jobs.pending} onClick={() => void pauseJob()}>暂停分析，保留进度</button></> : job.status !== 'completed' ? <>
        <p role="alert">{job.error?.message || '分析已暂停，已完成的图片观察和参考内容保留。'}</p>
        <p>{job.integration ? '继续时只重试本次规则综合，不重复分析参考图片。' : '继续时只重试未完成的步骤，已成功的图片不重复分析。'}确认后会产生剩余步骤的 API 用量。</p>
        {matchesJob ? <><div className="style-learning-source-fields"><label className="field">继续时每步最多等待（分钟）<input type="number" min={1} max={1440} step={1} value={resumeMinutes} disabled={jobs.pending} onChange={e => setResumeMinutes(e.target.value)}/></label><label className="field">继续时输出 token 上限<input type="number" min={256} step={1} value={resumeTokens} disabled={jobs.pending} onChange={e => setResumeTokens(e.target.value)} placeholder="沿用本任务已确认的上限"/></label></div><div className="style-learning-actions"><button type="button" className="generate-button" disabled={jobs.pending || Boolean(jobs.connectionError)} onClick={() => void resumeJob()}>确认继续未完成步骤</button><button type="button" className="text-button" disabled={jobs.pending} onClick={onClose}>暂不继续，保留进度</button></div></> : <><p className="field-hint">{job.integration ? '参考、所选写法或目标草稿已变化。可恢复查看该任务；若目标版本已更新，需要基于新草稿重新综合。' : '编辑区内容已变化。继续旧任务前，请先恢复它保存的参考；也可以用当前内容开始新分析。'}</p><button type="button" className="secondary-button" disabled={locked} onClick={() => void restoreJob(job.id)}>恢复这个任务的参考</button></>}
        {job.recovery?.partial.length ? <details className="style-learning-partial"><summary>本次保留的片段 · 未校验，不能直接作为规则</summary>{job.recovery.partial.map(item => <article key={item.label}><h4>{item.label}</h4><p>{item.text}</p></article>)}</details> : null}
      </> : !matchesJob && <><p>{job.integration ? '该方案绑定先前的参考、所选写法和目标草稿。恢复后可查看；目标已更新时不能直接保存。' : '该结果对应先前的参考。恢复会先请你确认，再切换编辑区内容。'}</p><button type="button" className="secondary-button" disabled={locked} onClick={() => void restoreJob(job.id)}>恢复参考并查看结果</button></>}
    </section>}
    {recovery && <details ref={recoveryPanel} className="style-learning-recovery" open aria-label="本次分析如何继续">
      <summary>本次分析尚未完成，内容已保留</summary>
      <h3>{recovery.reason === 'exhausted' ? '输出空间不够，要提高本次上限后重试吗？' : '服务不接受这个输出上限，要调整后重试吗？'}</h3>
      <p>本次上限为 <strong>{recovery.limit.toLocaleString('en-US')} token</strong>。{recovery.reason === 'exhausted' ? '模型生成到上限后停止，推理也可能占用这部分空间。参考图文和上次完整结果都还在。' : '应用没有另设低上限，但具体可用范围仍由当前模型服务决定。'}</p>
      <p className="field-hint">确认后会重新完整分析，可能增加 API 用量；新的上限只用于这一次，不修改保存的 AI 配置。</p>
      {(recovery.signature !== signature || recovery.profileId !== aiTask.current.id || recovery.profileRevision !== aiTask.current.revision) && <p className="storage-warning">参考、反馈或 AI 配置已改变，重试将使用当前页面内容与当前配置。</p>}
      <label className="field">重试的输出 token 上限<input type="number" min={256} step={1} value={retryLimit} disabled={locked} onChange={e => setRetryLimit(e.target.value)}/></label>
      <div className="style-learning-actions"><button type="button" className="generate-button" disabled={locked} onClick={() => void request('analyze', Number(retryLimit))}>{working === 'analyze' ? '正在重新分析…' : `同意以 ${Number(retryLimit).toLocaleString('en-US')} token 重新分析`}</button>
        <button type="button" className="secondary-button" disabled={locked} onClick={() => { if (sourcePanel.current) { sourcePanel.current.open = true; sourcePanel.current.querySelector('summary')?.focus(); sourcePanel.current.scrollIntoView({ block: 'start' }); } }}>先调整参考</button>
        <button type="button" className="text-button" disabled={locked} onClick={() => { if (recoveryPanel.current) { recoveryPanel.current.open = false; recoveryPanel.current.querySelector('summary')?.focus(); } }}>暂不重试，保留内容</button>
        {working === 'analyze' && <button type="button" className="secondary-button" onClick={() => controller.current?.abort()}>取消本次重试</button>}
      </div>
      {recovery.partial.length > 0 ? <details className="style-learning-partial"><summary>{recovery.partialFromEarlierAttempt ? '查看先前尝试保留的片段' : '查看本次已返回的片段'} · 尚未校验，不能直接作为规则</summary>{recovery.partial.map(item => <article key={item.label}><h4>{item.label}</h4><p>{item.text}</p></article>)}</details> : <p className="field-hint">这次还没有返回可展示的完整分析段落。</p>}
    </details>}
    {!proposal ? <>
      <details ref={sourcePanel} className="style-learning-source" open={!analysis || undefined}>
        <summary>{analysis ? `查看或追加参考 · ${drafts.length} 篇` : '提供你喜欢的笔记'}</summary>
        <p className="field-hint">一篇也能开始，追加同类笔记可帮助辨认共性。标题、正文和图上配文一起提炼，供不同素材复用。</p>
        <div className="style-learning-reference-tabs" role="group" aria-label="参考笔记">
          {drafts.map((ref, index) => <button type="button" key={ref.id} aria-pressed={ref.id === current.id} title={ref.title || `参考 ${index + 1}`} disabled={locked} onClick={() => setActiveId(ref.id)}>参考 {index + 1}{ref.title ? ` · ${ref.title}` : ''}</button>)}
          <button type="button" disabled={locked || drafts.length >= MAX_STYLE_REFERENCES} onClick={() => { changed(); const ref = newReference(crypto.randomUUID()); setDrafts([...drafts, ref]); setActiveId(ref.id); }}>＋ 追加参考</button>
        </div>
        <div className="style-learning-mode" role="group" aria-label="参考输入方式"><button type="button" aria-pressed={current.mode === 'text'} disabled={locked} onClick={() => updateCurrent({ mode: 'text' })}>粘贴文案</button><button type="button" aria-pressed={current.mode === 'link'} disabled={locked} onClick={() => updateCurrent({ mode: 'link' })}>提供链接</button>{drafts.length > 1 && <button type="button" className="text-button" disabled={locked} onClick={() => { changed(); const next = drafts.filter(r => r.id !== current.id); setDrafts(next); setActiveId(next[0].id); }}>移除这篇参考</button>}</div>
        {current.mode === 'link' && <div className="style-learning-link"><label className="field">小红书笔记链接<textarea rows={2} maxLength={3000} value={current.link} disabled={locked} onChange={e => { changed(); updateCurrent({ link: e.target.value }); }} placeholder="支持笔记链接或含 xhslink 的分享文字"/></label><button type="button" className="secondary-button" disabled={locked || !current.link.trim() || cloud} onClick={() => void request('read')}>{working === 'read' ? '正在读取文案与配图…' : '读取文案与配图'}</button><p className="field-hint">{cloud ? '请在本机工作台读取链接，此处可以粘贴文案和上传图片。' : '通过已登录的 OpenClaw 浏览器逐图读取，不调用 AI。图集较多时需要稍等。'}</p></div>}
        {pendingLink && <p className="field-hint">有新链接尚未读取。请先读取，或将对应参考切换为粘贴文案。</p>}
        <div className="style-learning-source-fields"><label className="field">参考标题<input maxLength={300} disabled={locked} value={current.title} onChange={e => { changed(); updateCurrent({ title: e.target.value }); }} placeholder="单独填写笔记标题，用于提炼标题风格"/></label>
        <label className="field">参考正文<textarea rows={7} maxLength={12000} disabled={locked} value={current.text} onChange={e => { changed(); updateCurrent({ text: e.target.value }); }} placeholder="粘贴正文。也可以只提供标题或图片，缺少的部分不会凭空推断。"/></label></div>
        {current.url && <p className="field-hint">来源：<a href={current.url} target="_blank" rel="noreferrer">已读取的小红书笔记</a> · 请核对标题与正文</p>}
        <div className="style-learning-images">
          <div className="style-learning-image-toolbar"><h3>本篇配图{current.images.length ? ` · ${current.images.length} 张` : ''}</h3><label className="secondary-button style-learning-upload">{working === 'images' ? '正在处理图片…' : '上传图片或截图'}<input type="file" aria-label="上传参考图片" accept="image/jpeg,image/png,image/webp" multiple disabled={locked || totalImages >= MAX_REFERENCE_IMAGES} onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void addImages(files); }}/></label></div>
          <p className="field-hint">分析图中文字、逐图节奏及与正文的配合。本轮最多 {MAX_STYLE_REFERENCES} 篇参考、合计 {MAX_REFERENCE_IMAGES} 张图片（已选 {totalImages} 张）。</p>
          {current.images.length > 0 && <div className="style-learning-image-grid">{current.images.map((image, index) => <article className="style-learning-reference-image" key={image.id}>
            <div className="style-learning-image-label"><span>参考图 {index + 1}</span><button type="button" className="text-button" aria-label={`移除参考图 ${index + 1}`} disabled={locked} onClick={() => { changed(); updateCurrent({ images: current.images.filter(i => i.id !== image.id) }); }}>移除</button></div>
            <Image src={image.dataUrl} alt={`参考图 ${index + 1}`} width={320} height={240} unoptimized />
            <label className="field">图 {index + 1} 文字补充（选填）<textarea rows={2} maxLength={2000} disabled={locked} value={image.caption} placeholder="可填写图上配文，或补充看不清的文字" onChange={e => { changed(); updateCurrent({ images: current.images.map(i => i.id === image.id ? { ...i, caption: e.target.value } : i) }); }}/></label>
          </article>)}</div>}
        </div>
      </details>
      {analysis && <div className="style-learning-analysis">
        <section className="style-learning-portrait" aria-label="风格画像">
          <p className="style-learning-step">风格画像 · 依据 {analyzed.references.length} 篇参考</p><h2 ref={resultHeading} tabIndex={-1}>{analysis.name}</h2><p className="style-learning-summary">{analysis.summary}</p>
          {!fresh && <p className="storage-warning">参考或调整要求已改变，请重新提炼后转为规则。上次分析仍保留。</p>}
          <div className="style-learning-temperament"><h3>整体气质</h3><p>{analysis.portrait.temperament}</p></div>
          <article className="style-learning-title-portrait"><h3>标题风格</h3>{analysis.portrait.titles.available ? <dl>{Object.entries(titleFacets).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{analysis.portrait.titles[key as keyof typeof titleFacets]}</dd></div>)}</dl> : <p>尚未提供笔记标题。补充参考标题后，可以单独提炼表达方式、语言特点、吸引力及与正文的关系。</p>}</article>
          <div className="style-learning-portrait-grid">{Object.entries(portraitFields).map(([key, label]) => <article key={key}><h3>{label}</h3><p>{analysis.portrait[key as keyof typeof portraitFields]}</p></article>)}</div>
        </section>
        {analysis.differences.length > 0 && <section className="style-learning-differences" aria-label="参考间的差异"><h3>这些差异需要取舍</h3><p className="field-hint">差异不会自动变成规则，可在下方说明你倾向哪种方向。</p>{analysis.differences.map((item, index) => <article key={index}><h4>{item.aspect}</h4><p>{item.description}</p><p>{item.suggestion}</p><small>{item.referenceIds.map(referenceLabel).join(' / ')}</small></article>)}</section>}
        <div className="style-learning-selection-heading"><div><h3>选择想保留的风格特点</h3><p className="field-hint">建议保持表达机制，具体写法随素材变化。单篇支持的候选特点需要你确认。</p></div><div className="style-learning-actions"><button type="button" className="text-button" disabled={locked} onClick={() => { changed(); setSelected(analysis.traits.map((_, i) => i)); }}>认可全部</button><button type="button" className="text-button" disabled={locked || !selected.length} onClick={() => { changed(); setSelected([]); }}>清空选择</button></div></div>
        {(Object.entries(ruleSections) as [RuleSection, string][]).map(([scope, label]) => analysis.traits.some(t => t.scope === scope) && <section className="style-learning-trait-group" key={scope} aria-label={`${label}特点`}><h4>{label}</h4><div className="style-learning-traits">{analysis.traits.map((trait, index) => trait.scope === scope && <article className="style-learning-trait" key={index}>
          <label className="style-learning-choice"><input type="checkbox" checked={selected.includes(index)} disabled={locked} onChange={e => { changed(); setSelected(e.target.checked ? [...selected, index] : selected.filter(i => i !== index)); }}/><span>{trait.label}</span></label>
          <div className="style-learning-badges"><span>{trait.mode === 'core' ? '建议保持' : '随素材调整'}</span><span>{trait.support === 'recurring' ? '多篇共性' : '候选 · 待确认'}</span></div>
          <p>{trait.observation}</p><label className="field">可执行规则<textarea rows={3} maxLength={700} disabled={locked} value={trait.rule} onChange={e => updateTrait(index, e.target.value)}/></label><details><summary>查看原文与图片依据</summary>{trait.evidence.map((evidence, i) => <div key={i}><p className="field-hint">{referenceLabel(evidence.referenceId)}{evidence.imageIds.length > 0 && ` · ${evidence.imageIds.map(id => `图 ${(analyzed.references.find(r => r.id === evidence.referenceId)?.images.findIndex(image => image.id === id) ?? -1) + 1}`).join('、')}`}</p><blockquote>{evidence.quote}</blockquote></div>)}</details>
        </article>)}</div></section>)}
        {analysis.imageAnalyses.length > 0 && <details className="style-learning-evidence"><summary>查看逐图分析依据 · {analysis.imageAnalyses.length} 张</summary><div className="style-learning-image-grid">{analysis.imageAnalyses.map(item => {
          const ref = analyzed.references.find(r => r.id === item.referenceId), imageIndex = ref?.images.findIndex(i => i.id === item.imageId) ?? -1;
          const image = ref?.images[imageIndex];
          return <article className="style-learning-image-analysis" key={`${item.referenceId}/${item.imageId}`}><h4>{referenceLabel(item.referenceId)} · 图 {imageIndex + 1}</h4>{image && <Image src={image.dataUrl} alt={`拆解参考图 ${imageIndex + 1}`} width={320} height={240} unoptimized />}<p>{item.visualDescription}</p><p><strong>图文配合：</strong>{item.captionAnalysis}</p><p><strong>图组作用：</strong>{item.role}</p><details><summary>识别到的图中文字</summary><blockquote>{item.visibleText || '未识别到可读文字。'}</blockquote></details>{item.limitations && <p className="field-hint">{item.limitations}</p>}</article>;
        })}</div></details>}
        {analysis.cautions.length > 0 && <details className="style-learning-boundary"><summary>适用范围与分析边界</summary><ul>{analysis.cautions.map((s, i) => <li key={i}>{s}</li>)}</ul></details>}
      </div>}
      <label className="field">{analysis ? '调整这类风格' : '想学习什么（选填）'}<textarea rows={3} maxLength={2000} disabled={locked} value={preferences} onChange={e => { changed(); setPreferences(e.target.value); }} placeholder="例如：保留画面感，标题更克制，正文少一点哲理，配文再短一些。"/></label>
      <AiUsageStatus task={aiTask}/>
      <details className="style-learning-output-settings"><summary>本次输出与等待设置（选填）</summary><label className="field">本次输出 token 上限<input type="number" min={256} step={1} disabled={locked} value={outputLimit} placeholder="留空沿用当前 AI 配置" onChange={e => setOutputLimit(e.target.value)}/></label>{!cloud && <label className="field">每步最多等待（分钟）<input type="number" min={1} max={1440} step={1} disabled={locked} value={waitMinutes} onChange={e => setWaitMinutes(e.target.value)}/></label>}<p className="field-hint">只用于本次分析或重新综合，不修改全局 AI 配置。服务达到输出上限或等待超时后，保留进度并由你决定是否继续。</p></details>
      {!cloud && <p className="field-hint">本次共 {styleImageBatches({ references }).length + 1} 步：{totalImages ? '每 2 张图片单独观察，再综合标题、正文与配文提炼风格。' : '综合标题与正文提炼风格。'}每步调用一次 AI，成功后保存进度；失败不会自动重试。</p>}
      <div className="style-learning-actions"><button type="button" className={analysis ? 'secondary-button' : 'generate-button'} disabled={locked || pendingLink || !references.some(r => r.title.trim().length >= 2 || r.text.trim().length >= 20 || r.images.length)} onClick={() => void request('analyze')}>{localBusy ? '正在分步提炼风格…' : working === 'analyze' ? '正在提炼风格…' : analysis ? '按反馈更新风格（调用 AI）' : '提炼风格（调用 AI）'}</button>
        {(working === 'read' || working === 'analyze') && <button type="button" className="secondary-button" onClick={() => controller.current?.abort()}>取消{working === 'read' ? '读取' : '分析'}</button>}
      </div>
      {analysis && <><div className="style-learning-convert"><label className="field">规则用于<select value={target} disabled={locked} onChange={e => { const id = e.target.value; changed(); setTarget(id); if (id !== 'new') onRestoreTarget(id); }}><option value="new">新建风格草稿</option>{target !== 'new' && !record && <option value={target} disabled>原目标已删除或不可用，请重新选择</option>}{styles.map(style => {
          const version = style.versions.find(version => version.snapshot.versionId === style.draftVersionId);
          return <option key={style.id} value={style.id}>重新综合「{version?.snapshot.content.name || '未命名风格'}」 · 草稿 v{version?.snapshot.version}</option>;
        })}</select></label><button type="button" className="generate-button" disabled={locked || !fresh || !selected.length || target !== 'new' && (cloud || !analysisJobId || !record)} onClick={convert}>{target !== 'new' ? job?.integration?.proposal && job.status === 'completed' && matchesJob ? '查看本次综合方案（不调用 AI）' : '结合已有风格重新综合（1 次 AI）' : `认可所选风格，转成规则（${selected.length}）`}</button></div>
        {target !== 'new' ? <p className="field-hint">{!record ? '所选风格已删除或不可用，请重新选择。参考、分析和已选写法仍保留，不会自动合并到其他风格。' : cloud || !analysisJobId ? '结合已有风格需要本机可恢复的完整分析。请先在本机完成或找回分析；当前结果仍可新建风格。' : `将以「${content?.name}」当前草稿为基础，结合已保存来源与本轮所选 ${selected.length} 项写法重新综合。先查看整套候选、变化理由和冲突，再认可保存；不会直接追加或启用。`}</p> : <p className="field-hint">会保留所选栏目的表达画像、写法机制和少量参考片段，帮助生成时保持相近的语气与节奏。下一步可编辑或移除；未选栏目不自动补充。</p>}</>}
      <p className="field-hint">参考作者的经历不会作为你的素材。含图片时使用当前配置的图片理解能力；提炼、按反馈更新及重新综合会使用 API 用量；保存草稿不调用 AI。</p>
    </> : <>
      <p className="field-hint">{proposal.target ? '下方是重新综合后的整套候选规则。原草稿与当前启用版本仍保持原样；请核对变化和冲突后再认可保存。' : '这些规则将保存为新风格草稿。可以修改名称和各栏目，再用自己的素材试写。'}</p>
      {conflict && <p className="storage-warning" role="alert">原风格已在其他页面更新。请返回分析，按最新规则重新整理；当前预览仍可复制。</p>}
      {proposal.integration && <StyleIntegrationReview integration={proposal.integration.snapshot} resolutions={proposal.integration.resolutions} disabled={locked} onResolve={resolveConflict}/>}
      {proposal.integration && <h3>完整候选规则 · 可继续编辑</h3>}
      <fieldset className="style-learning-rule-fields" disabled={locked}><label className="field">风格名称<input maxLength={60} value={proposal.content.name} onChange={e => { onDirty(true); setProposal({ ...proposal, content: { ...proposal.content, name: e.target.value } }); }}/></label>
        {(Object.entries(ruleSections) as [RuleSection, string][]).map(([key, label]) => <div key={key}><label className="field">{label}<textarea rows={key === 'body' || key === 'captions' ? 5 : 3} maxLength={key === 'body' || key === 'captions' ? 6000 : 3000} value={proposal.content.sections[key]} onChange={e => { onDirty(true); setProposal({ ...proposal, content: { ...proposal.content, sections: { ...proposal.content.sections, [key]: e.target.value } } }); }}/></label>{proposal.before && proposal.content.sections[key] !== proposal.before.sections[key] && <details><summary>查看原规则</summary><pre>{proposal.before.sections[key] || '原栏目为空'}</pre></details>}</div>)}
        {proposal.content.examples.length > 0 && <details className="style-learning-evidence"><summary>随规则保存的参考片段 · {proposal.content.examples.length} 条</summary><p className="field-hint">这些片段让模型看见具体语气、句式与停顿，只学习表达方式，不复用其中的经历或原句。已有示例保留，合计最多 8 条。</p>{proposal.content.examples.map((example, index) => <article key={example.id}><h3>{ruleSections[example.scope]} · 示例 {index + 1}</h3><p className="field-hint">{example.background}</p><label className="field">参考片段<textarea rows={4} maxLength={4000} value={example.output} onChange={e => { onDirty(true); setProposal({ ...proposal, content: { ...proposal.content, examples: proposal.content.examples.map(item => item.id === example.id ? { ...item, output: e.target.value } : item) } }); }}/></label><p>{example.reason}</p><button type="button" className="text-button" onClick={() => removeExample(example.id)}>移除这个参考片段</button></article>)}</details>}
        <label className="field">先试生成<select value={proposal.trialKind} onChange={e => setProposal({ ...proposal, trialKind: e.target.value as TrialKind })}><option value="title">标题</option><option value="body">正文</option><option value="captions">逐图配文</option></select></label>
      </fieldset>
      {unresolvedConflicts > 0 && <p className="storage-warning" role="status">还有 {unresolvedConflicts} 项冲突未选择处理方式，完成取舍后才能认可保存。</p>}
      <div className="style-learning-actions"><button type="button" className="secondary-button" disabled={locked} onClick={() => setProposal(null)}>返回风格画像</button><button type="button" className="generate-button" disabled={locked || Boolean(conflict) || unresolvedConflicts > 0} onClick={() => void save()}>{working === 'save' ? '正在保存…' : proposal.integration ? '认可整套规则并保存草稿' : '保存草稿并去试生成'}</button></div>
      <p className="field-hint">保存不调用 AI，也不会自动启用。进入测试区后，提供自己的素材，再选择标题、正文或逐图配文试生成。</p>
    </>}
  </section>;
}

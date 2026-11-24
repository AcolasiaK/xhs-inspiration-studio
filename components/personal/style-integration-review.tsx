'use client';

import { ruleSections } from '@/lib/personal/style-rules';
import type { StyleIntegrationSnapshot } from '@/lib/personal/style-integration';
import type { LearningResolutions } from '@/lib/personal/style-learning-memory';

const changeLabels = { keep: '保留', revise: '调整', merge: '合并', add: '新增', remove: '删除' } as const;
type Props = { integration: StyleIntegrationSnapshot; resolutions: LearningResolutions; disabled: boolean; onResolve: (conflictId: string, optionId: string) => void };

export function StyleIntegrationReview({ integration, resolutions, disabled, onResolve }: Props) {
  const proposal = integration.proposal;
  if (!proposal) return null;
  const unresolved = proposal.conflicts.filter(conflict => !resolutions.some(choice => choice.conflictId === conflict.id));
  return <section aria-label="综合方案变化与冲突" className="style-learning-analysis">
    <h3>这次怎样重新综合</h3><p>{proposal.summary}</p>
    <p className="field-hint">{integration.historySourceCount > 0 ? `同时参考了 ${integration.historySourceCount} 篇已关联的历史来源、本次新参考与现有规则。` : '旧风格尚未关联历史原文：本轮依据现有规则与示例，再结合新参考重新综合。新来源会在认可保存后累积。'}</p>
    <section className="style-learning-differences" aria-label="规则变化说明"><h3>保留、调整、合并、新增与删除</h3>{proposal.changes.map((change, index) => <details key={index} open={change.kind !== 'keep'}>
      <summary>{ruleSections[change.scope]} · {changeLabels[change.kind]}</summary>
      <p>{change.reason}</p>
      {change.before && <><strong>原有写法</strong><pre>{change.before}</pre></>}
      {change.after && <><strong>建议写法</strong><pre>{change.after}</pre></>}
      {change.sourceIds.length > 0 && <p className="field-hint">依据 {change.sourceIds.length} 份已关联来源。</p>}
    </details>)}</section>
    {proposal.conflicts.length > 0 && <section className="style-learning-differences" aria-label="需要明确取舍的冲突"><h3>这些冲突需要你取舍{unresolved.length ? ` · 还有 ${unresolved.length} 项` : ' · 已全部选择'}</h3><p>每个选项是该栏目的完整规则。选择后，下方完整候选会同步更新，也可继续手动编辑；保存以你最后确认的文字为准。未选择的冲突不能保存。</p>{proposal.conflicts.map(conflict => <fieldset className="style-learning-rule-fields style-learning-trait" disabled={disabled} key={conflict.id}>
      <legend>{ruleSections[conflict.scope]} · {conflict.question}</legend><p>{conflict.reason}</p>
      {conflict.options.map(option => <div key={option.id}><label className="style-learning-choice"><input type="radio" name={`style-conflict-${conflict.id}`} checked={resolutions.some(choice => choice.conflictId === conflict.id && choice.optionId === option.id)} onChange={() => onResolve(conflict.id, option.id)}/><span>{option.label}</span></label><pre>{option.text || '此选项清空该栏目。'}</pre></div>)}
    </fieldset>)}</section>}
    {proposal.cautions.length > 0 && <section className="style-learning-boundary"><h3>综合时保留的边界</h3><ul>{proposal.cautions.map((caution, index) => <li key={index}>{caution}</li>)}</ul></section>}
  </section>;
}

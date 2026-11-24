import type { XhsCategoryResult, XhsKeywordCoverage, XhsNote } from '@/lib/xhs-hotspots';
import { XHS_SORTS } from '@/lib/xhs-hotspot-rules';
import styles from '@/app/hotspots/coverage.module.css';

const phaseLabels = { basic: '轮流基础搜索', expand: '按新增价值追加', grouping: '整理主题', finished: '本轮已结束' } as const;
function statusLabel(item: XhsKeywordCoverage, running: boolean) {
  if (item.status === 'searching') return running ? item.basicCovered ? '追加搜索中' : '首轮搜索中' : item.basicCovered ? '已基础覆盖 · 追加中断' : '搜索中断';
  if (item.status === 'partial') return item.basicCovered ? '已基础覆盖 · 部分未完成' : '尚未完成基础覆盖';
  if (item.status === 'interrupted') return item.basicCovered ? '已基础覆盖 · 搜索中断' : '搜索中断';
  return { pending: '待搜索', covered: '已基础覆盖', empty: '已确认无结果' }[item.status];
}
function duration(value: number) {
  const seconds = Math.max(0, Math.round(value / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function HotspotSearchCoverage({ result, running }: { result?: XhsCategoryResult; running: boolean }) {
  const coverage = result?.run?.coverage;
  if (!coverage) return <p className={styles.unrecorded}>{result?.collectedAt || result?.attemptedAt || result?.notes.length ? '关键词覆盖情况未记录；下次检索后可查看每个词的进度。' : '关键词覆盖 · 等待首次检索'}</p>;
  const missing = coverage.keywords.filter(item => !item.basicCovered);
  const phase = running ? phaseLabels[coverage.phase] : coverage.phase === 'finished' ? phaseLabels.finished : '本轮未完成';
  return <details className={styles.coverage}>
    <summary><span>关键词基础覆盖 <strong>{coverage.completed} / {coverage.total}</strong></span><span className={styles.phase}>{phase}</span></summary>
    <div className={styles.body}>
      <p className={styles.explanation}>基础覆盖表示已检查一批结果，或确认确实无结果；后续仍可轮换排序和追加检索。</p>
      {missing.length > 0 && <p className={styles.missing}>{running ? '尚未完成基础覆盖' : '本轮未覆盖完整'}：{missing.map(item => item.query).join('、')}</p>}
      <ul className={styles.keywords}>
        {coverage.keywords.map(item => <li key={item.query}>
          <div className={styles.keywordHeading}><strong>{item.query}</strong><span className={styles.state} data-covered={item.basicCovered}>{statusLabel(item, running)}</span></div>
          <dl className={styles.metrics}>
            <div><dt>候选</dt><dd>{item.candidates}</dd></div>
            <div><dt>核验尝试</dt><dd>{item.inspected}</dd></div>
            <div><dt>新增有效笔记</dt><dd>{item.newNotes}</dd></div>
            <div><dt>新增作者</dt><dd>{item.newAuthors}</dd></div>
          </dl>
          <p className={styles.detail}>已尝试 {item.searches} 次 · 用时 {duration(item.elapsedMs)}{item.sorts.length > 0 ? ` · ${item.sorts.map(sort => XHS_SORTS[sort]).join('、')}` : ''}</p>
          {item.reason && <p className={styles.reason}>{item.reason}</p>}
        </li>)}
      </ul>
      <p className={styles.explanation}>同一篇笔记跨词命中只核验、计数一次；“新增”归于首次发现它的关键词。</p>
    </div>
  </details>;
}

export function NoteQuerySources({ note }: { note: XhsNote }) {
  const queries = [...new Set([note.query, ...(note.matchedQueries || [])].filter(Boolean))];
  if (!queries.length) return null;
  return <details className={styles.noteSources}>
    <summary>检索来源 · {note.matchedQueries ? `${queries.length} 个命中词` : '历史记录'}</summary>
    <p className={styles.sourceValue}>{note.matchedQueries ? '首次发现词' : '已记录搜索词'}：{note.query || '未记录'}</p>
    {note.matchedQueries ? <p className={styles.sourceValue}>全部命中词：{queries.join('、')}</p> : <p className={styles.sourceValue}>这份历史结果未记录全部命中词。</p>}
  </details>;
}

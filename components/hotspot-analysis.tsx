"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Check, Download } from 'lucide-react';
import { CopyButton } from './copy-button';
import { isIngestAnalysis, type XhsAnalysis, type XhsNote } from '@/lib/xhs-hotspots';
import { xhsAnalysisFilename, xhsAnalysisMarkdown } from '@/lib/xhs-analysis-markdown';
import { hotspotScrollPanel, scrollHotspotSection } from '@/lib/hotspot-scroll';
import styles from '@/app/hotspots/analysis.module.css';

type Props = {
  note: XhsNote;
  report: XhsAnalysis;
  current: boolean;
  renderTopicAction: (topic: string, index: number) => ReactNode;
  refreshAction: ReactNode;
};

export function HotspotAnalysis({ note, report, current, renderTopicAction, refreshAction }: Props) {
  const [error, setError] = useState('');
  const [active, setActive] = useState('overview');
  const [exported, setExported] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState(0);
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const article = useRef<HTMLElement>(null);
  const id = useId().replace(/:/g, '');
  const anchor = (section: string) => `${id}-${section}`;
  const modern = isIngestAnalysis(report), content = report.content;
  const markdown = xhsAnalysisMarkdown(note, report);
  const sections = [
    ['overview', '核心洞察'],
    ...(modern ? [['audience', '人群与动机']] : []),
    ['writing', '标题与结构'],
    ...(modern ? [['template', '写作模板'], ['topics', '衍生选题']] : []),
    ['evidence', '观察与边界'],
  ];

  useEffect(() => {
    let frame = 0;
    const panel = article.current?.closest<HTMLElement>('[data-hotspot-scroll]');
    const nav = article.current?.querySelector<HTMLElement>('[data-scroll-nav]');
    const update = () => {
      frame = 0;
      const markers = article.current?.querySelectorAll<HTMLElement>('[data-section]');
      const scrollPanel = hotspotScrollPanel(article.current);
      const threshold = scrollPanel
        ? scrollPanel.getBoundingClientRect().top + (parseFloat(getComputedStyle(scrollPanel).scrollPaddingTop) || 24) + 8
        : Math.min(180, window.innerHeight * .2);
      let current = 'overview';
      markers?.forEach(marker => {
        if (marker.getBoundingClientRect().top <= threshold) current = marker.dataset.section!;
      });
      setActive(current);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const measure = () => {
      if (panel && nav) {
        const title = panel.querySelector<HTMLElement>('[data-scroll-heading]');
        panel.style.setProperty('--hotspot-scroll-offset', `${(title?.offsetHeight || 0) + nav.offsetHeight + 16}px`);
      }
      schedule();
    };
    const observer = new ResizeObserver(measure);
    if (panel) observer.observe(panel);
    if (nav) observer.observe(nav);
    measure();
    schedule();
    panel?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); panel?.style.removeProperty('--hotspot-scroll-offset'); panel?.removeEventListener('scroll', schedule); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, [modern, report.generatedAt]);
  useEffect(() => () => { if (exportTimer.current) clearTimeout(exportTimer.current); }, []);

  function navigate(section: string) {
    if (sections.some(([key]) => key === section)) setActive(section);
    const target = document.getElementById(anchor(section));
    target?.focus({ preventScroll: true });
    if (target) scrollHotspotSection(target);
  }
  function download() {
    try {
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = xhsAnalysisFilename(note.title); link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setExported(true);
      if (exportTimer.current) clearTimeout(exportTimer.current);
      exportTimer.current = setTimeout(() => setExported(false), 2000);
    } catch { setError('导出未完成，可以复制全文后保存为 Markdown。'); }
  }

  return <article ref={article} className={styles.report} aria-label="笔记拆解报告">
    <div className={styles.toolbar}>
      <div className={styles.saved}><Check size={16} aria-hidden="true"/><span>{current ? '拆解已保存' : '笔记已变化，当前为历史拆解'}</span></div>
      <div className={styles.tools}>
        <CopyButton text={markdown} label="复制全文" className={styles.quietButton} onError={setError}/>
        <button type="button" className={styles.quietButton} onClick={download} aria-label="导出 Markdown" title="下载 Markdown 文件"><Download size={18} aria-hidden="true"/><span aria-live="polite">{exported ? '已导出' : '导出报告'}</span></button>
      </div>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.layout}>
      <nav className={styles.contents} data-scroll-nav aria-label="拆解目录">{sections.map(([key, label]) => <a key={key} href={`#${anchor(key)}`} aria-current={active === key ? 'location' : undefined} onClick={event => { event.preventDefault(); navigate(key); }}>{label}{key === 'topics' && <span>5</span>}</a>)}</nav>
      <div className={styles.document}>
        {!current && <p className={styles.notice}>原笔记的采集内容已变化。以下仍是上次保存的拆解，可在文末重新分析。</p>}
        {!modern && <div className={styles.legacy}><strong>这是一份历史拆解</strong><p>原结果完整保留。按新方法拆解后，将增加人群分析、写作模板和 5 条衍生选题。</p><a href={`#${anchor('refresh')}`} onClick={event => { event.preventDefault(); navigate('refresh'); }}>前往更新拆解<ArrowDown size={15} aria-hidden="true"/></a></div>}
        <section data-section="overview" className={styles.overview}>
          <h3 id={anchor('overview')} tabIndex={-1}>核心洞察</h3>
          <p className={styles.lead}>{content.summary}</p>
        </section>
        {modern && <section data-section="audience" className={styles.section}>
          <h3 id={anchor('audience')} tabIndex={-1}>人群与动机</h3>
          <dl className={styles.lenses}>{([
            ['目标人群', '写给谁看', report.content.audience],
            ['使用场景', '什么时候需要', report.content.scene],
            ['核心需求', '解决什么问题', report.content.painPoint],
            ['情绪价值', '带来什么感受', report.content.emotion],
          ] as const).map(([label, question, value]) => <div key={label}><dt>{label}<span>{question}</span></dt><dd>{value}</dd></div>)}</dl>
        </section>}
        <section data-section="writing" className={styles.section}>
          <h3 id={anchor('writing')} tabIndex={-1}>标题与结构</h3>
          {modern && <div className={styles.hook}><h4>标题钩子<span>{report.content.titleHook.type}</span></h4><p>{report.content.titleHook.why}</p></div>}
          <h4>标题与开头</h4><p className={styles.prose}>{content.titleAndHook}</p>
          <h4 className={styles.structureHeading}>正文如何展开</h4>
          <ol className={styles.structure}>{content.structure.map((item, i) => <li key={i}><span aria-hidden="true">{i + 1}</span><p>{item}</p></li>)}</ol>
        </section>
        {modern && <>
          <section data-section="template" className={styles.section}>
            <div className={styles.heading}><h3 id={anchor('template')} tabIndex={-1}>写作模板</h3><CopyButton text={report.content.reusableTemplate} label="复制模板" className={styles.secondaryButton} onError={setError}/></div>
            <p className={styles.description}>保留写作方法，把内容换成自己的真实经历。</p>
            <div className={styles.template}><p>{report.content.reusableTemplate}</p></div>
            <p className={styles.hint}>使用前替换占位内容，并核实时间、费用与地点等信息。</p>
          </section>
          <section data-section="topics" className={styles.section}>
            <div className={styles.heading}><h3 id={anchor('topics')} tabIndex={-1}>衍生选题<span className={styles.count}>5</span></h3></div>
            <p className={styles.description}>选择一个创作方向，再使用下方的统一入口开始创作。</p>
            <fieldset className={styles.topicChoices}><legend className={styles.srOnly}>选择衍生选题</legend>{report.content.derivedTopics.map((topic, i) => <label key={i} className={styles.topicChoice}><input type="radio" name={`${id}-topic`} value={i} checked={selectedTopic === i} onChange={() => setSelectedTopic(i)}/><span>{topic}</span></label>)}</fieldset>
            <div className={styles.topicActions}><CopyButton text={report.content.derivedTopics[selectedTopic]} label="复制选题" className={styles.quietButton} onError={setError}/>{renderTopicAction(report.content.derivedTopics[selectedTopic], selectedTopic)}</div>
          </section>
        </>}
        <section data-section="evidence" className={styles.section}>
          <h3 id={anchor('evidence')} tabIndex={-1}>观察与边界</h3>
          <div className={styles.evidence}><h4>封面呈现<span>{report.coverObserved ? '已读取首图' : '未读取画面'}</span></h4><p>{content.cover}</p><h4>互动特点</h4><p>{content.engagement}</p><h4>值得借鉴的方法</h4><ul>{content.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul></div>
          <details className={styles.cautions}><summary>使用前留意<span>{content.cautions.length} 条提醒</span></summary><ul>{content.cautions.map((t, i) => <li key={i}>{t}</li>)}</ul></details>
          <p className={styles.hint}>拆解是基于采集内容的 AI 判断。累计互动不能证明传播原因，参考作者的经历也不能直接写成自己的经历。</p>
        </section>
        <footer className={styles.footer}>
          <p>生成于 <time dateTime={report.generatedAt}>{new Date(report.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time></p>
          <p>拆解方法：{modern ? 'xiaohongshu-ingest' : '历史版本'}<span className={styles.separator}> / </span>{report.model}</p>
          <div id={anchor('refresh')} tabIndex={-1} className={styles.refresh}>{refreshAction}</div>
        </footer>
      </div>
    </div>
  </article>;
}

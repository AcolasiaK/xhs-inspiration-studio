import { isIngestAnalysis, type XhsAnalysis, type XhsNote } from './xhs-hotspots';
// Keep third-party text literal in exported Markdown, including image/link syntax.
const literal = (s: string) => s.replace(/[\\`*_{}\[\]<>!#|~]/g, '\\$&');
export function xhsAnalysisMarkdown(note: XhsNote, report: XhsAnalysis): string {
  const c = report.content, source = `https://www.xiaohongshu.com/explore/${note.id}`;
  const lines = ['---', `title: ${JSON.stringify('笔记拆解 - ' + note.title)}`, 'platform: xiaohongshu', 'type: note_analysis', 'note_type: unknown', `source: ${JSON.stringify(source)}`, `author: ${JSON.stringify(note.author)}`, `published_at: ${JSON.stringify(note.publishedAt)}`, `collected_at: ${JSON.stringify(note.collectedAt)}`, `analyzed_at: ${JSON.stringify(report.generatedAt)}`, `method: ${JSON.stringify(isIngestAnalysis(report) ? 'xiaohongshu-ingest/1.0.0' : 'legacy')}`, `tags: ${JSON.stringify(note.tags)}`, '---', '', `# ${literal(note.title)}`, '', '## 核心结论', '', literal(c.summary), ''];
  if (report.fingerprint !== note.fingerprint) lines.push('这份拆解对应此前的笔记快照；下方来源正文为当前采集版本，可能与分析时的材料不同。', '');
  if (isIngestAnalysis(report)) {
    const v = report.content;
    lines.push('## 人群与需求', '', `- 目标人群：${literal(v.audience)}`, `- 使用场景：${literal(v.scene)}`, `- 核心需求：${literal(v.painPoint)}`, `- 情绪价值：${literal(v.emotion)}`, '', '## 标题钩子', '', `类型：${literal(v.titleHook.type)}`, '', literal(v.titleHook.why), '');
  }
  lines.push('## 标题与开头', '', literal(c.titleAndHook), '', '## 正文结构', '', ...c.structure.map((s, i) => `${i + 1}. ${literal(s)}`), '');
  if (isIngestAnalysis(report)) lines.push('## 可复用模板', '', literal(report.content.reusableTemplate), '', '## 衍生选题', '', ...report.content.derivedTopics.map(t => `- [ ] ${literal(t)}`), '');
  lines.push('## 封面呈现', '', literal(c.cover), '', '## 互动观察', '', `采集时可见互动：赞 ${note.likes} / 藏 ${note.collects} / 评 ${note.comments}；累计值可能取整。`, '', literal(c.engagement), '', '## 借鉴方法', '', ...c.takeaways.map(t => `- ${literal(t)}`), '', '## 使用边界', '', ...c.cautions.map(t => `- ${literal(t)}`), '', '## 来源快照', '', source, '', '仅包含采集到的正文与标签；未采集完整图组或视频文字稿。', '', ...note.body.split('\n').map(s => `> ${literal(s)}`), '');
  return lines.join('\n');
}
export function xhsAnalysisFilename(title: string) {
  return `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim().slice(0, 60) || '小红书笔记'}-拆解.md`;
}

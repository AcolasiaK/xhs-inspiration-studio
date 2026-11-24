import * as React from "react";
import { isSafeTravelReferenceUrl, type TravelResearch } from "@/lib/travel-research";

const fallbackNotice: Record<TravelResearch["status"], string> = {
  disabled: "本次未联网检索。",
  missing_place: "未能确定可检索的主题或地点；可以补充关键词，或在没有联网资料的情况下继续。",
  not_configured: "联网检索尚未配置可用服务；可以在没有联网资料的情况下继续。",
  success: "检索资料仅作背景参考，易变信息仍需核实。",
  partial: "仅取得部分参考资料，缺失的信息仍需自行核实。",
  no_results: "没有找到可用参考来源；可以更换关键词，或在没有联网资料的情况下继续。",
  error: "本次检索未完成；已有输入和内容保留，可以在没有联网资料的情况下继续。",
};

function researchTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  try {
    return `${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value))}（北京时间）`;
  } catch { return null; }
}

/** Read-only references, deliberately outside all publishable/copyable result fields. */
export function ResearchInfo({ research, title, compact = false }: { research: TravelResearch | null; title: string; compact?: boolean }) {
  if (!research || research.status === "disabled") {
    if (compact) return <aside className="personal-research personal-research-disabled" aria-label={title}><details className="personal-research-disclosure"><summary>参考来源（0 条）<span className="personal-research-state">{research?"未联网":"未记录"}</span></summary><p className="personal-research-notice">{research?"本次未联网检索；外部事实仍需自行核实。":"这份提示词没有保存检索来源，不能据此确认外部事实。"}</p></details></aside>;
    if (!research) return null;
    return <aside className="personal-research personal-research-disabled" aria-label={title}><p>本次未联网检索；外部事实仍需自行核实。</p></aside>;
  }

  const sources = research.sources.filter(isSafeTravelReferenceUrl);
  const hasRouteExperiences = sources.some(source => source.kind);
  const excluded = research.sources.length - sources.length;
  const notice = research.notice.trim() || fallbackNotice[research.status];
  const warningParts = research.status === "success" ? [] : [notice];
  if (research.potentialConflict) warningParts.push("来源之间可能存在冲突，请核实后再使用，不能把冲突内容写成确定事实。");
  if (research.status === "success" && sources.length === 0) warningParts.push("这次没有可展示的可靠来源，不能据此确认外部事实。");
  if (excluded > 0) warningParts.push(`有 ${excluded} 条链接不符合来源安全规则，已停止展示。`);
  const hasDetails = compact || research.status === "success" || sources.length > 0 || Boolean(research.provider || research.query || research.retrievedAt || excluded);
  const summary = compact || sources.length > 0 ? `参考来源（${sources.length} 条）` : "检索详情";
  const retrievedAt = researchTime(research.retrievedAt);

  return <aside className="personal-research" aria-label={title}>
    {warningParts.length > 0 && <p className="personal-research-warning" role="status">{warningParts.join(" ")}</p>}
    {hasDetails && <details className="personal-research-disclosure">
      <summary aria-label={`${title}：${summary}`}><span>{summary}</span>{research.status === "success" && sources.length > 0 && !research.potentialConflict && !excluded && <span className="personal-research-complete">已检索</span>}</summary>
      <div className="personal-research-content">
        <p className="personal-research-context">{title}</p>
        <p className="personal-research-notice">{notice}</p>
        <dl className="personal-research-meta">
          {research.provider && <><dt>检索方式</dt><dd>{research.provider === "browser" ? "本机浏览器搜索" : research.provider === "chatgpt" ? "本机 ChatGPT 订阅搜索" : "博查搜索"}</dd></>}
          {research.query && <><dt>关键词</dt><dd>{research.query}</dd></>}
          <dt>检索时间</dt><dd>{retrievedAt ?? (research.retrievedAt ? "检索时间无法读取" : "未记录检索时间")}</dd>
        </dl>
        {sources.length > 0 && <ul className="personal-research-list">{sources.map(source => {
          const publishedAt = researchTime(source.publishedAt);
          let publisher = source.source + (hasRouteExperiences ? " · 公共资料" : "");
          let excerptLabel = research.summaryKind === "search_summary" ? "检索整理摘要" : "搜索摘要";
          if (source.kind === "travel_guide") {
            publisher = `${source.source} · 非官方游览经验`;
            excerptLabel = "攻略摘要";
          } else if (source.kind === "xiaohongshu") {
            const interaction = [
              source.likes !== undefined ? `点赞 ${source.likes}` : null,
              source.collects !== undefined ? `收藏 ${source.collects}` : null,
            ].filter(Boolean).join(" · ");
            publisher = "小红书 · 游览经验" + (interaction ? ` · ${interaction}` : "");
            excerptLabel = "笔记摘录";
          }
          return <li key={source.url}>
            <a className="personal-research-link" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
            <p className="personal-research-publisher">{publisher}</p>
            <p className="personal-research-url">{source.url}</p>
            <p className="personal-research-date">{publishedAt ? `来源发布时间：${publishedAt}` : source.publishedAt ? "来源发布时间无法读取，易变信息仍需核实。" : "来源未提供可核实的发布时间，易变信息仍需确认。"}</p>
            {source.snippet && <details className="personal-research-snippet"><summary>查看{excerptLabel}</summary><p>{source.snippet}</p></details>}
          </li>;
        })}</ul>}
      </div>
    </details>}
  </aside>;
}

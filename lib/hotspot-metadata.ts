/** Shared display metadata only; no credentials or server configuration. */
export const HOTSPOT_SOURCE_KEY = 'baidu-creator-relevance-v3';
export const HOTSPOT_SOURCE = '百度热搜';
export const HOTSPOT_BOARD = 'https://top.baidu.com/board?tab=realtime';
export const HOTSPOT_ORDERING = '本工具按创作适配度整理：综合标题与摘要的场景、体验、时效与可核实性；直接相关优先，其后纳入城市、消费、文化休闲等可延伸话题。同档兼顾方向多样性、去除近重复，百度原排名仅作次要参考。最多 10 条，不用无关新闻补数；方向与入选原因是本工具判断，不是小红书热度。';
export const HOTSPOT_VERIFICATION = '榜单词条与摘要仅供选题参考，未关联可核实的权威报道。社会事件、政策、健康等事实请先核实，不把热搜词当作事实结论。';
export function hotspotSourceMetadata(sourceKey: string | undefined, hasItems: boolean) {
  const legacy = hasItems && sourceKey !== HOTSPOT_SOURCE_KEY;
  return {
    ordering: legacy ? '旧来源 / 旧筛选规则缓存：保留原来源和顺序，尚未按当前账号方向重新整理。' : HOTSPOT_ORDERING,
    sourceNotice: legacy ? '当前显示切换来源前或旧筛选规则的上次数据（原来源见各条目），尚未按旅行、日常与情绪方向更新。' : null,
  };
}
export function hotspotLinkLabel(item: { source: string; url: string }) {
  return item.source === HOTSPOT_SOURCE
    ? item.url === HOTSPOT_BOARD ? '查看百度榜单' : '查看百度相关结果'
    : '查看原始来源';
}

export function hotspotSelectionNotice(sourceCount?: number, itemCount?: number): string | null {
  if (sourceCount === undefined || itemCount === undefined) return null;
  return itemCount < 10 ? `已读取 ${sourceCount} 条来源话题，按账号方向筛选后保留 ${itemCount} 条；未用无关内容补足 10 条。` : null;
}

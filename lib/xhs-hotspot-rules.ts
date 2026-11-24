import { z } from 'zod';
const term = z.string().trim().min(1).max(80).refine(s => s.replace(/[\s*]/g, '').length > 0, '关键词不能只有空格或星号');
const terms = z.array(term).max(100);
const rule = z.object({ name: z.string().trim().min(1).max(40), terms: terms.min(1) });
export const xhsCategoryIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).refine(s => !['constructor', 'prototype', '__proto__'].includes(s), '分类编号无效');
export const XHS_SORTS = { likes: '最多点赞', collects: '最多收藏', comments: '最多评论', latest: '最新' } as const;
/** A new search is complete only after this many evidence-qualified themes. */
export const XHS_MIN_THEME_TARGET = 5;
export const executionSchema = z.object({
 searchSorts: z.array(z.enum(['likes', 'collects', 'comments', 'latest'])).min(1).max(4),
 candidateBudget: z.number().int().min(20).max(600), detailBudget: z.number().int().min(10).max(200),
 windowDays: z.number().int().min(1).max(30), topicLimit: z.number().int().min(1).max(20), representatives: z.number().int().min(1).max(5),
 cardsPerQuery: z.number().int().min(5).max(60), scrollsPerQuery: z.number().int().min(0).max(12),
 autoUpdate: z.boolean(), retryMinutes: z.number().int().min(5).max(180),
 maxMinutes: z.number().int().min(1).max(90), noNewRounds: z.number().int().min(1).max(5), cacheMinutes: z.number().int().min(0).max(1440),
 weights: z.object({ likes: z.number().int().min(0).max(10), collects: z.number().int().min(0).max(10), comments: z.number().int().min(0).max(10) }),
 excludeTerms: terms, genericTags: terms, broadTopics: terms, destinations: z.array(rule).max(100),
});
export const categorySettingsSchema = executionSchema.partial();
export const xhsCategoryRuleSchema = z.object({
 name: z.string().trim().min(1).max(30).optional(), enabled: z.boolean().optional(), archived: z.boolean().optional(), order: z.number().int().min(0).max(1000).optional(),
 demand: z.string().max(4000).optional(), requireDestination: z.boolean().optional(),
 minInteractions: z.number().int().min(1).max(1_000_000_000).default(1000), minNotes: z.number().int().min(2).max(20).default(2), minAuthors: z.number().int().min(2).max(20).default(2),
 minThemeInteractions: z.number().int().min(1).max(20_000_000_000).optional(), overlapPercent: z.number().int().min(50).max(100).optional(),
 queries: z.array(term).min(1).max(10), includeTerms: terms.min(1), topics: z.array(rule).max(60),
 settings: categorySettingsSchema.optional(),
 // Zero means no additional per-run call cap; collection scope/deadline still bound the work.
 semantic: z.object({ enabled: z.boolean(), profileId: z.string().max(100), maxCalls: z.number().int().min(0) }).optional(),
 lockedFields: z.array(z.string().max(80)).max(60).optional(),
});
export type XhsCategoryRule = z.infer<typeof xhsCategoryRuleSchema>;
export const xhsRulesSchema = executionSchema.extend({
 searchSorts: executionSchema.shape.searchSorts.default(['likes', 'collects']),
 candidateBudget: executionSchema.shape.candidateBudget.default(400), detailBudget: executionSchema.shape.detailBudget.default(60),
 maxMinutes: executionSchema.shape.maxMinutes.optional(), noNewRounds: executionSchema.shape.noNewRounds.optional(), cacheMinutes: executionSchema.shape.cacheMinutes.optional(),
 broadTopics: terms.default(['独居生活', '周末生活', '朋友圈', '生活中的小感受', '生活记录', '日常分享', '生活碎片']),
 categories: z.record(xhsCategoryIdSchema, xhsCategoryRuleSchema),
}).superRefine((v, ctx) => {
 const entries = Object.entries(v.categories);
 if (!entries.length || entries.length > 30) ctx.addIssue({ code: 'custom', path: ['categories'], message: '请保留 1–30 个分类（含归档）' });
 if (new TextEncoder().encode(JSON.stringify(v)).length > 500_000) ctx.addIssue({ code: 'custom', path: [], message: '规则总量过大，请精简关键词（最多 500 KB）' });
 for (const [key, c] of entries) {
  const e = { ...v, ...c.settings };
  const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: ['categories', key, field], message });
  if (new Set(e.searchSorts).size !== e.searchSorts.length) issue('searchSorts', '搜索排序方式不能重复');
  if (e.weights.likes + e.weights.collects + e.weights.comments <= 0) issue('weights', '至少一个互动权重大于 0');
  if (e.detailBudget > e.candidateBudget) issue('detailBudget', '详情核验上限不能超过候选总预算');
  if (c.queries.length * e.searchSorts.length > e.detailBudget) issue('detailBudget', '详情预算至少覆盖每个关键词的每一种排序，请增加预算或减少关键词');
  if (new Set(c.queries).size !== c.queries.length) issue('queries', '搜索关键词不能重复');
  if (new Set(c.topics.map(r => r.name)).size !== c.topics.length) issue('topics', '同类主题名称不能重复，请合并触发词');
  if (new Set(e.destinations.map(r => r.name)).size !== e.destinations.length) issue('destinations', '目的地名称不能重复，请合并触发词');
 }
});
export type XhsRules = z.infer<typeof xhsRulesSchema>;
export type XhsRule = XhsRules['destinations'][number];
export type XhsRulesVersion = { revision: string; updatedAt: string | null; rules: XhsRules };
export const xhsRulesVersionSchema = z.object({ revision: z.string().min(1).max(80), updatedAt: z.string().datetime().nullable(), rules: xhsRulesSchema });
export const DEFAULT_XHS_RULES: XhsRules = {
  "windowDays": 7,
  "topicLimit": 10,
  "representatives": 3,
  "cardsPerQuery": 40,
  "scrollsPerQuery": 1,
  "autoUpdate": true,
  "retryMinutes": 30,
  "weights": {
    "likes": 1,
    "collects": 1,
    "comments": 1
  },
  "excludeTerms": [
    "明星婚讯",
    "明星婚礼",
    "娱乐八卦",
    "股票",
    "炒股",
    "彩票",
    "博彩",
    "引流",
    "加微",
    "代购",
    "私信领",
    "诈骗",
    "遇难",
    "身亡",
    "战争"
  ],
  "genericTags": [
    "旅行",
    "旅游",
    "日常",
    "日常分享",
    "生活",
    "生活记录",
    "生活碎片",
    "婚礼",
    "备婚",
    "小红书",
    "笔记",
    "热门",
    "发现",
    "plog",
    "vlog",
    "笔记灵感",
    "图文",
    "记录生活",
    "旅行日记",
    "旅游攻略"
  ],
  "categories": {
    "travel": {
      "queries": [
        "旅行",
        "周末旅行",
        "小众旅行",
        "旅游攻略",
        "城市漫步"
      ],
      "includeTerms": [
        "旅行",
        "旅游",
        "自驾",
        "徒步",
        "赏秋",
        "赏花",
        "景区",
        "景点",
        "路线",
        "旅拍",
        "民宿",
        "酒店",
        "游记",
        "出游",
        "城市漫步",
        "citywalk",
        "周边游",
        "看海",
        "登山",
        "目的地",
        "海岛",
        "签证",
        "免签",
        "机票",
        "高铁"
      ],
      "topics": [
        {
          "name": "赏秋",
          "terms": [
            "赏秋",
            "红叶",
            "银杏",
            "枫叶",
            "秋色",
            "秋天",
            "秋景"
          ]
        },
        {
          "name": "冬日赏雪",
          "terms": [
            "赏雪",
            "雪景",
            "滑雪",
            "雾凇",
            "冬天",
            "冬日"
          ]
        },
        {
          "name": "徒步路线",
          "terms": [
            "徒步",
            "登山",
            "爬山"
          ]
        },
        {
          "name": "海边度假",
          "terms": [
            "看海",
            "海岛",
            "海边",
            "沙滩",
            "海滩"
          ]
        },
        {
          "name": "城市漫步",
          "terms": [
            "citywalk",
            "城市漫步",
            "城市漫游",
            "街区"
          ]
        },
        {
          "name": "亲子出游",
          "terms": [
            "亲子",
            "带娃",
            "遛娃"
          ]
        },
        {
          "name": "自驾旅行",
          "terms": [
            "自驾",
            "公路旅行"
          ]
        },
        {
          "name": "住宿体验",
          "terms": [
            "民宿",
            "酒店",
            "住宿"
          ]
        },
        {
          "name": "独自旅行",
          "terms": [
            "独旅",
            "独自旅行",
            "一个人旅行"
          ]
        },
        {
          "name": "旅行攻略",
          "terms": [
            "攻略",
            "路线",
            "行程",
            "自由行"
          ]
        }
      ],
      "minInteractions": 1000,
      "minNotes": 2,
      "minAuthors": 2
    },
    "wedding": {
      "queries": [
        "婚礼",
        "备婚",
        "婚礼布置",
        "婚纱",
        "婚礼流程"
      ],
      "includeTerms": [
        "婚礼",
        "备婚",
        "新娘",
        "婚纱",
        "婚宴",
        "伴娘",
        "喜糖",
        "结婚照",
        "婚庆",
        "婚车",
        "嫁妆",
        "订婚",
        "领证"
      ],
      "topics": [
        {
          "name": "农村婚礼",
          "terms": [
            "农村",
            "回老家",
            "家乡婚礼"
          ]
        },
        {
          "name": "婚礼布置",
          "terms": [
            "水晶婚礼",
            "光影*婚礼",
            "婚礼*光影",
            "布置",
            "花艺",
            "配色",
            "迎宾",
            "仪式区"
          ]
        },
        {
          "name": "小预算婚礼",
          "terms": [
            "低预算",
            "小预算",
            "省钱",
            "极简婚礼",
            "预算*万",
            "万*预算"
          ]
        },
        {
          "name": "户外婚礼",
          "terms": [
            "户外",
            "草坪",
            "森林",
            "花园婚礼"
          ]
        },
        {
          "name": "中式婚礼",
          "terms": [
            "中式",
            "新中式",
            "宋制",
            "明制",
            "秀禾",
            "龙凤褂"
          ]
        },
        {
          "name": "婚纱与造型",
          "terms": [
            "婚纱",
            "礼服",
            "妆容",
            "造型",
            "头纱",
            "新娘妆"
          ]
        },
        {
          "name": "婚礼摄影",
          "terms": [
            "婚纱照",
            "婚礼摄影",
            "婚礼跟拍",
            "婚照",
            "婚礼照片"
          ]
        },
        {
          "name": "婚礼流程",
          "terms": [
            "流程",
            "接亲",
            "堵门",
            "仪式",
            "誓言",
            "致辞",
            "firstlook"
          ]
        },
        {
          "name": "备婚清单",
          "terms": [
            "备婚",
            "清单",
            "筹备"
          ]
        },
        {
          "name": "婚礼小物",
          "terms": [
            "喜糖",
            "伴手礼",
            "请柬",
            "喜帖",
            "喜字",
            "红包"
          ]
        },
        {
          "name": "订婚领证",
          "terms": [
            "订婚",
            "领证",
            "登记"
          ]
        },
        {
          "name": "婚宴与场地",
          "terms": [
            "婚宴",
            "婚礼酒店",
            "婚礼场地",
            "酒店婚礼"
          ]
        },
        {
          "name": "小型婚礼",
          "terms": [
            "小型",
            "家宴",
            "小而美",
            "几十人"
          ]
        }
      ],
      "minInteractions": 1000,
      "minNotes": 2,
      "minAuthors": 2
    },
    "daily": {
      "queries": [
        "日常分享",
        "生活记录",
        "独居生活",
        "周末日常",
        "生活碎片"
      ],
      "includeTerms": [
        "日常",
        "生活",
        "独居",
        "下班",
        "居家",
        "做饭",
        "周末",
        "生活碎片",
        "plog",
        "vlog",
        "通勤",
        "收纳",
        "阅读",
        "咖啡",
        "手作",
        "养宠",
        "散步",
        "记录"
      ],
      "topics": [
        {
          "name": "独居做饭与备餐",
          "terms": [
            "一人食",
            "独居*做饭",
            "独居*备餐",
            "一个人*做饭"
          ]
        },
        {
          "name": "小户型收纳",
          "terms": [
            "小户型*收纳",
            "独居*收纳",
            "收纳*小家"
          ]
        },
        {
          "name": "周末逛展",
          "terms": [
            "逛展",
            "看展",
            "美术馆"
          ]
        },
        {
          "name": "生活手账",
          "terms": [
            "手账",
            "手帐"
          ]
        },
        {
          "name": "居家清洁",
          "terms": [
            "大扫除",
            "清洁*小家",
            "家务*清单"
          ]
        },
        {
          "name": "下班后的生活",
          "terms": [
            "下班*生活",
            "下班*做饭",
            "下班*运动"
          ]
        },
        {
          "name": "独居生活",
          "terms": [
            "独居",
            "一个人住",
            "一人居"
          ]
        },
        {
          "name": "居家布置",
          "terms": [
            "家居",
            "布置",
            "房间",
            "软装",
            "小家",
            "租房改造"
          ]
        },
        {
          "name": "整理与收纳",
          "terms": [
            "收纳",
            "整理",
            "断舍离",
            "清洁"
          ]
        },
        {
          "name": "日常做饭",
          "terms": [
            "做饭",
            "下厨",
            "早餐",
            "午餐",
            "晚餐",
            "便当",
            "一人食",
            "家常菜"
          ]
        },
        {
          "name": "咖啡与探店",
          "terms": [
            "咖啡",
            "探店",
            "面包店",
            "甜品",
            "奶茶"
          ]
        },
        {
          "name": "阅读与书店",
          "terms": [
            "阅读",
            "读书",
            "书店",
            "书单"
          ]
        },
        {
          "name": "运动日常",
          "terms": [
            "运动",
            "健身",
            "跑步",
            "瑜伽",
            "骑行"
          ]
        },
        {
          "name": "养宠日常",
          "terms": [
            "养猫",
            "养狗",
            "宠物",
            "猫咪",
            "小狗",
            "遛狗"
          ]
        },
        {
          "name": "手作兴趣",
          "terms": [
            "手作",
            "手工",
            "拼豆",
            "编织",
            "画画",
            "陶艺"
          ]
        },
        {
          "name": "周末生活",
          "terms": [
            "周末",
            "休息日",
            "休假"
          ]
        },
        {
          "name": "生活中的小感受",
          "terms": [
            "情绪",
            "感受",
            "独处",
            "慢生活",
            "松弛",
            "幸福",
            "治愈"
          ]
        },
        {
          "name": "日常穿搭",
          "terms": [
            "穿搭",
            "ootd",
            "换季",
            "衣橱"
          ]
        }
      ],
      "minInteractions": 1000,
      "minNotes": 2,
      "minAuthors": 2
    }
  },
  "destinations": [
    {
      "name": "皖南",
      "terms": [
        "皖南",
        "宏村",
        "卢村",
        "西溪南",
        "黄山"
      ]
    },
    {
      "name": "川西",
      "terms": [
        "川西",
        "稻城",
        "亚丁",
        "四姑娘山",
        "新都桥"
      ]
    },
    {
      "name": "大理",
      "terms": [
        "大理",
        "洱海"
      ]
    },
    {
      "name": "丽江",
      "terms": [
        "丽江",
        "玉龙雪山"
      ]
    },
    {
      "name": "雨崩",
      "terms": [
        "雨崩"
      ]
    },
    {
      "name": "阿勒泰",
      "terms": [
        "阿勒泰",
        "禾木",
        "喀纳斯"
      ]
    },
    {
      "name": "九寨沟",
      "terms": [
        "九寨沟"
      ]
    },
    {
      "name": "长白山",
      "terms": [
        "长白山"
      ]
    },
    {
      "name": "北京",
      "terms": [
        "北京"
      ]
    },
    {
      "name": "上海",
      "terms": [
        "上海"
      ]
    },
    {
      "name": "杭州",
      "terms": [
        "杭州",
        "西湖"
      ]
    },
    {
      "name": "苏州",
      "terms": [
        "苏州"
      ]
    },
    {
      "name": "南京",
      "terms": [
        "南京"
      ]
    },
    {
      "name": "成都",
      "terms": [
        "成都",
        "都江堰"
      ]
    },
    {
      "name": "重庆",
      "terms": [
        "重庆"
      ]
    },
    {
      "name": "深圳",
      "terms": [
        "深圳"
      ]
    },
    {
      "name": "广州",
      "terms": [
        "广州"
      ]
    },
    {
      "name": "香港",
      "terms": [
        "香港"
      ]
    },
    {
      "name": "澳门",
      "terms": [
        "澳门"
      ]
    },
    {
      "name": "青岛",
      "terms": [
        "青岛"
      ]
    },
    {
      "name": "大连",
      "terms": [
        "大连"
      ]
    },
    {
      "name": "西藏",
      "terms": [
        "西藏",
        "拉萨",
        "纳木措",
        "林芝"
      ]
    },
    {
      "name": "新疆",
      "terms": [
        "新疆",
        "伊犁",
        "乌鲁木齐"
      ]
    },
    {
      "name": "海南",
      "terms": [
        "三亚",
        "万宁",
        "海南"
      ]
    },
    {
      "name": "云南",
      "terms": [
        "云南",
        "昆明"
      ]
    },
    {
      "name": "日本",
      "terms": [
        "日本",
        "东京",
        "大阪",
        "京都"
      ]
    },
    {
      "name": "泰国",
      "terms": [
        "泰国",
        "曼谷",
        "清迈"
      ]
    },
    {
      "name": "韩国",
      "terms": [
        "韩国",
        "首尔",
        "济州"
      ]
    },
    {
      "name": "欧洲",
      "terms": [
        "欧洲",
        "瑞士",
        "意大利",
        "法国"
      ]
    },
    {
      "name": "湖州",
      "terms": [
        "湖州",
        "太湖溇港"
      ]
    },
    {
      "name": "莆田",
      "terms": [
        "莆田"
      ]
    },
    {
      "name": "济南",
      "terms": [
        "济南"
      ]
    },
    {
      "name": "天水",
      "terms": [
        "天水"
      ]
    },
    {
      "name": "景德镇",
      "terms": [
        "景德镇"
      ]
    },
    {
      "name": "哈尔滨",
      "terms": [
        "哈尔滨",
        "尔滨"
      ]
    }
  ],
  "searchSorts": [
    "likes",
    "collects"
  ],
  "candidateBudget": 400,
  "detailBudget": 60,
  "broadTopics": [
    "独居生活",
    "周末生活",
    "朋友圈",
    "生活中的小感受",
    "生活记录",
    "日常分享",
    "生活碎片"
  ]
};
export function describeXhsRules(r: XhsRules): string {
 return `近 ${r.windowDays} 天确认发布的笔记，先按主要内容归纳具体主题与共同方向，再判断主题整体热度；一篇可支持多个主题。主题热度分 = 点赞 × ${r.weights.likes} ＋ 收藏 × ${r.weights.collects} ＋ 评论 × ${r.weights.comments}，同主题每位作者取最高分笔记，每类最多 ${r.topicLimit} 个主题、每主题最多 ${r.representatives} 篇代表笔记。仅覆盖实际采集范围，不是官方全站热榜。`;
}
// Literal matching with a simple ordered wildcard. Never execute user-supplied regular expressions.
export function termMatches(text: string, pattern: string): boolean {
 const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
 const value = normalize(text); let index = 0;
 for (const part of normalize(pattern).split('*').filter(Boolean)) { const found = value.indexOf(part, index); if (found < 0) return false; index = found + part.length; }
 return true;
}
export function anyTerm(text: string, terms: string[]) { return terms.some(term => termMatches(text, term)); }

/** Keep validation messages understandable in the same language as the form. */
export function formatXhsRuleIssues(issues: readonly z.core.$ZodIssue[]): string {
 const labels: Record<string, string> = { searchSorts: '搜索排序', candidateBudget: '候选总预算', detailBudget: '详情核验预算', broadTopics: '宽泛主题', minInteractions: '单篇热门参考最低互动', minThemeInteractions: '主题最低总互动', overlapPercent: '主题重叠阈值', minNotes: '主题最少相关笔记', minAuthors: '主题最少作者', windowDays: '发布时间窗口', topicLimit: '主题数量', representatives: '代表笔记', cardsPerQuery: '候选上限', scrollsPerQuery: '滚动次数', autoUpdate: '自动更新', retryMinutes: '重试间隔', weights: '互动权重', likes: '点赞', collects: '收藏', comments: '评论', categories: '分类', travel: '旅行', wedding: '婚礼', daily: '日常分享', queries: '搜索词', includeTerms: '相关词', topics: '主题归并', name: '名称', terms: '触发词', excludeTerms: '排除词', genericTags: '泛标签', destinations: '目的地' };
 return issues.slice(0, 5).map(issue => {
  const path = issue.path.map(key => typeof key === 'number' ? `第 ${key + 1} 项` : labels[String(key)] || String(key)).join(' / ');
  const message = issue.code === 'too_small' ? (issue.origin === 'number' ? `不能小于 ${issue.minimum}` : `至少填写 ${issue.minimum} 项或字符`) : issue.code === 'too_big' ? (issue.origin === 'number' ? `不能大于 ${issue.maximum}` : `最多 ${issue.maximum} 项或字符`) : issue.code === 'invalid_type' ? '请填写有效的值，数值须为整数' : issue.message;
  return `${path ? path + '：' : ''}${message}`;
 }).join('；');
}

/** Compare only the settings that can affect this category's next collection. */
export const DEFAULT_CATEGORY_NAMES: Record<string, string> = { travel: '旅行', wedding: '婚礼', daily: '日常分享' };
export function categoryName(rules: XhsRules, id: string) { return rules.categories[id]?.name || DEFAULT_CATEGORY_NAMES[id] || id; }
export function categoryIds(rules: XhsRules, includeArchived = false) {
 return Object.keys(rules.categories).filter(id => includeArchived || !rules.categories[id].archived).sort((a, b) => (rules.categories[a].order ?? Object.keys(rules.categories).indexOf(a)) - (rules.categories[b].order ?? Object.keys(rules.categories).indexOf(b)));
}
export function enabledCategoryIds(rules: XhsRules) { return categoryIds(rules).filter(id => rules.categories[id].enabled !== false); }
export function effectiveRules(rules: XhsRules, category: string): XhsRules {
 return { ...rules, maxMinutes: rules.maxMinutes ?? 20, noNewRounds: rules.noNewRounds ?? 2, cacheMinutes: rules.cacheMinutes ?? 60, ...rules.categories[category]?.settings };
}
export function themeSearchRules(config: XhsRules, category: string): XhsRules {
 const rules = structuredClone(effectiveRules(config, category));
 rules.topicLimit = Math.max(XHS_MIN_THEME_TARGET, rules.topicLimit);
 rules.categories[category].settings = { ...rules.categories[category].settings, topicLimit: rules.topicLimit };
 return rules;
}
export function requiresDestination(rules: XhsRules, category: string) { return rules.categories[category]?.requireDestination ?? category === 'travel'; }
export function themeInteractionFloor(category: XhsCategoryRule) { return category.minThemeInteractions ?? category.minInteractions * category.minAuthors; }
export function categoryRulesSignature(rules: XhsRules, category: string): string {
 const r = effectiveRules(rules, category), c = r.categories[category];
 return JSON.stringify({ algorithm: 5, ...r, categories: { [category]: c ? { ...c, name: undefined, order: undefined, archived: undefined, enabled: undefined, lockedFields: undefined } : undefined } });
}

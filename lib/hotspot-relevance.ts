import type { Hotspot } from './server/hotspots-types';

export const HOTSPOT_DIRECTIONS = { travel: '旅行', daily: '日常', emotion: '情绪' } as const;
export type HotspotDirection = keyof typeof HOTSPOT_DIRECTIONS;
export type HotspotEditorial = {
  version: 1;
  directions: HotspotDirection[];
  kind: 'discussion' | 'seasonal';
  fit?: 'direct' | 'extended';
  facets?: string[];
  reason: string;
  angles: string[];
  verification: string;
  evidence: string[];
  score: { relevance: number; experience: number; timeliness: number; seasonal: number; verifiability: number; sourceRank: number };
};

type Rule = {
  id: string; directions: HotspotDirection[]; subject: RegExp; context?: RegExp;
  reason: string; angle: string; experiential: boolean; seasonal?: boolean; extended?: boolean;
};
// Match subject/context pairs in a sentence or a title with supporting description.
// Broad lifestyle bridges are a separate, lower-priority tier; a lone loose word is not enough.
// These are transparent editorial heuristics, not an AI classifier or platform audience data.
const rules: Rule[] = [
  { id:'scenery', directions:['travel','daily'], subject:/赏秋|秋游|红叶|枫叶|银杏|雾凇|花海|樱花|赏花|油菜花|雪景|冰雪|极光|萤火虫|候鸟|日落|晚霞/u,
    context:/景|游|观赏|迎来|进入|公园|山|湖|海|江|河|目的地|城市|地方|季|开|绽放|期|体验/u,
    reason:'来源包含季节景色和可观察的场景，适合旅行见闻或日常观察。', angle:'若你计划探访，可列出想观察的景色和待核实的观赏条件；去过后再分享自己的感受。', experiential:true, seasonal:true },
  { id:'outing', directions:['travel'], subject:/旅游|旅行|出游|短途|自驾|徒步|露营|爬山|登山|城市漫游|城市漫步|City\s*walk|特种兵旅行|反向旅游/iu,
    context:/路线|行程|周末|假期|体验|规划|目的地|景|游|走|看|住|记录|变化/u,
    reason:'来源涉及出行或游览体验，可以整理真实路线、观察与感受。', angle:'围绕来源中的出游方式，分享自己的计划与取舍；未去过时写准备过程，不写成游记。', experiential:true },
  { id:'destination', directions:['travel'], subject:/景区|景点|公园|博物馆|美术馆|古镇|展览|动物园|主题乐园|游乐园|艺术馆|国家公园|文化遗产|文博|文旅/u,
    context:/参观|游览|开放|门票|预约|讲解|体验|打卡|游|观|展|景/u,
    reason:'来源有明确的游览或文化体验对象，适合做探访准备和现场观察。', angle:'可从来源提到的参观方式切入，列出自己的兴趣点；预约与开放信息先向场馆核实。', experiential:true },
  { id:'travel-change', directions:['travel'], subject:/签证|入境|免签|航班|机票|高铁|铁路|动车|邮轮|酒店|民宿|住宿|渡轮|机场/u,
    context:/政策|调整|变化|新增|开通|恢复|延长|预约|预订|费用|票价|价格|接驳|攻略|体验|出行|游客|旅客|游|住/u,
    reason:'来源涉及出行条件或住宿变化，对旅行准备可能有参考价值。', angle:'可整理这项变化对自己行程的影响与待确认清单；以使领馆、交通运营方或住宿方公告为准。', experiential:false },
  { id:'slow-travel', directions:['travel','emotion'], subject:/旅行|散步|城市漫游|城市漫步|看海|看日落|独自出游|一个人旅行/u,
    context:/慢下来|放松|松弛|独处|自由|休息|节奏|感受|心情|陪伴/u,
    reason:'来源把出行场景和生活感受联系起来，适合用真实片段承接情绪。', angle:'如果你有相似感受，可选自己的一个见闻展开，不把网上的经历写成亲身经历。', experiential:true },
  { id:'seasonal-life', directions:['daily'], subject:/换季|降温|入冬|秋日|秋天|冬日|春日|夏日|立冬|立秋|梅雨|雨季|回南天|供暖|保暖/u,
    context:/衣|穿|食|吃|喝|家|居|生活|通勤|散步|周末|活动|准备|习惯|收纳/u,
    reason:'来源涉及换季中的生活安排，可以结合自己真实的小变化分享。', angle:'从自己换季时调整的一件小事写起，用生活细节说明感受，不把季节话题写成突发新闻。', experiential:true, seasonal:true },
  { id:'home', directions:['daily'], subject:/家居|家装|装修|收纳|厨房|厨卫|租房|居家|房间|房子|住房|户型|书桌|阳台|绿植|养花|养宠|宠物/u,
    context:/布置|整理|生活|空间|设计|体验|做饭|格局|习惯|记录|改造|打通|动线|跑道|种|养|陪伴|日常/u,
    reason:'来源有具体的居住或生活细节，适合分享个人习惯与体验。', angle:'可对照自己的生活空间或习惯写观察，只展示自己确实使用或体验过的细节。', experiential:true },
  { id:'food', directions:['daily'], subject:/美食|餐饮|咖啡|奶茶|烘焙|早餐|晚餐|火锅|零食|食材|菜市场|小吃|面包|水果|螃蟹|餐厅|探店/u,
    context:/吃|喝|尝|做|买|逛|体验|分享|日常|上市|时令|味|菜|消费/u,
    reason:'来源涉及饮食或日常消费场景，方便结合自己的体验展开。', angle:'如果确实尝过或做过，可记录口味、过程和心情；没有体验时写想尝试的理由，不编造探店。', experiential:true },
  { id:'hobby', directions:['daily'], subject:/摄影|拍照|手作|手工|陶艺|拼图|阅读|书店|读书|骑行|跑步|露营|徒步|园艺|观鸟|绘画|滑雪|编织/u,
    context:/体验|尝试|爱好|入门|周末|记录|参加|活动|兴趣|生活|练习|课程|俱乐部/u,
    reason:'来源涉及可参与的小众爱好或活动，适合记录尝试过程。', angle:'可写自己是否愿意尝试、准备什么，以及真实尝试后的感受，避免虚构成果或经历。', experiential:true },
  { id:'commute', directions:['daily','travel'], subject:/通勤|公交|地铁|骑行|步行|城市交通/u,
    context:/开通|线路|接驳|时间|体验|沿途|风景|周末|出游|变化|生活|指路牌|指示牌|站台|转弯|看懂|焕新/u,
    reason:'来源与日常出行方式有关，可结合自己的路线与沿途观察分享。', angle:'若与自己的路线有关，可记录沿途见闻和路线取舍；运营时间与票价仍需核实。', experiential:true },
  { id:'rest', directions:['emotion','daily'], subject:/休息|独处|松弛|放松|慢生活|慢下来|周末|下班|生活节奏|留白/u,
    context:/生活|日常|感受|心情|习惯|自己|时间|关系|疲惫|散步|朋友|陪伴|忙碌|休息/u,
    reason:'来源涉及生活节奏和日常感受，可以从个人细节写出自己的观点。', angle:'如果与你的感受有关，可从自己的一件小事谈休息或生活节奏，不套用统一的治愈结尾。', experiential:true },
  { id:'relationship', directions:['emotion','daily'], subject:/朋友|友谊|家人|亲情|邻里|陪伴|相处|相聚|人际关系/u,
    context:/生活|日常|见面|散步|周末|感受|理解|相处|距离|边界|聚会|一起|观察/u,
    reason:'来源包含人与人相处的生活观察，适合结合真实关系与感受表达。', angle:'如果有相近经历，可选自己真实的相处细节写感受，不替他人推测动机或编造对话。', experiential:true },
  { id:'city-space', directions:['daily','travel'], extended:true, subject:/街区|街道|步行街|广场|绿道|街角|图书馆|公共空间|社区|指路牌|导向标识|商圈|滨水/u,
    context:/焕新|更新|改造|开放|休闲|便民|转弯|看懂|设施|市民|公众|路线|散步|逛|展/u,
    reason:'来源提到城市空间或设施变化，可自然延伸为城市观察和日常出行。', angle:'可从这项空间或设施变化出发，记录自己所在城市的类似体验；没有去过就写关注点与探访准备。', experiential:true },
  { id:'shopping', directions:['daily'], extended:true, subject:/购物|商品|用品|超市|商场|市集|消费趋势|充电线|充电器|儿童手表|家电|文具|餐具|杯子|服饰|衣服|鞋子|数码产品/u,
    context:/使用|体验|设计|开箱|买|选购|通用|配件|便利|方便|不便|生活|耐用|收纳|需求|消费/u,
    reason:'来源包含商品使用、选购或消费习惯的线索，适合延伸为生活体验。', angle:'可围绕来源里的使用问题或消费变化，记录自己的选择标准；产品细节和价格先核实，不编造使用感受。', experiential:true },
  { id:'weather-calendar', directions:['daily','travel'], extended:true, seasonal:true, subject:/初雪|第一场雪|下雪|降雪|降温|寒潮|升温|晴天|雨天|雨季|节气|立冬|冬至|秋分|清明|中秋|端午|春节|节假日|长假|跨年|万圣节/u,
    context:/天气|气温|冷|热|迎来|来临|到来|准备|习惯|活动|放假|景|生活|过节|冻|安排|记录/u,
    reason:'来源有天气、节气或节日线索，可延伸为当季生活和出游准备。', angle:'可记录自己当地的季节变化或节日安排；核实适用地区、日期和天气，不把别人的现场当成自己的经历。', experiential:true },
  { id:'culture', directions:['daily','emotion'], extended:true, subject:/电影|电视剧|纪录片|综艺|剧集|戏剧|音乐会|演唱会|电影节|书展|文化节|音乐节|小说|新书/u,
    context:/剧情|故事|角色|表达|台词|观影|观剧|阅读|放映|上映|开演|演出|展演|文化|感受|共鸣/u,
    reason:'来源涉及作品或文化活动，可延伸为休闲记录和有具体依据的感受。', angle:'若你看过相关作品或参加过活动，可从一个真实触动你的片段写感受；未体验时写期待，不编造剧情或观后感。', experiential:true },
  { id:'active-leisure', directions:['daily'], extended:true, subject:/运动|健身|瑜伽|游泳|骑车|球场|攀岩|跳舞|舞蹈|羽毛球|乒乓球|网球|飞盘|滑板/u,
    context:/爱好|尝试|入门|活动|开放|预约|练习|休闲|业余|市民|场地|周末|体验/u,
    reason:'来源包含普通人可参与的运动休闲场景，可结合自己的兴趣记录。', angle:'可介绍自己想尝试的活动和准备过程；不写未经确认的运动功效，也不把赛事成绩当成个人体验。', experiential:true },
  { id:'companions', directions:['daily','emotion'], extended:true, subject:/猫咪|小猫|小狗|宠物|养猫|养狗|遛狗|萌宠|手工|手作|阅读|摄影|拍照/u,
    context:/陪伴|日常|习惯|兴趣|记录|生活|尝试|作品|照顾|观察|温暖|可爱|制作/u,
    reason:'来源包含兴趣或陪伴的生活细节，可延伸为日常记录与真实感受。', angle:'可从自己确实做过或观察到的小事展开；不要把来源中的宠物、作品或经历直接写成自己的。', experiential:true },
  { id:'work-life', directions:['daily','emotion'], extended:true, subject:/休假|年假|调休|休息日|下班|上班|职场|工位|工作日|办公|打工/u,
    context:/安排|生活|节奏|边界|时间|社交|独处|休息|通勤|状态|平衡|习惯/u,
    reason:'来源与工作和生活安排有关，可结合自己的节奏和边界感分享。', angle:'可从自己的时间安排或休息习惯谈感受；若涉及休假政策，请先核实适用规则，不推断劳动争议事实。', experiential:true },
  { id:'self-perception', directions:['emotion','daily'], extended:true, subject:/容貌焦虑|外貌焦虑|自我接纳|自我表达|自我认同|年龄焦虑|社交边界|人际边界/u,
    context:/感受|生活|自己|鼓励|表达|看待|认识|相处|观察|焦虑|接纳/u,
    reason:'来源包含自我看待或人际边界的观察，可以有依据地延伸为个人感受。', angle:'若与你的真实感受有关，可写自己如何看待这类生活观察；不替来源人物推测内心，不套用统一的成长结论。', experiential:true },
  { id:'travel-culture', directions:['travel','daily'], extended:true, subject:/行李箱|伴手礼|纪念品|当地文化|地方文化|方言|非遗|手信|旅行准备/u,
    context:/旅游|旅行|开箱|文化|习俗|挑选|体验|游客|准备|记录|出游/u,
    reason:'来源包含旅行准备或目的地文化线索，适合延伸为路线灵感与个人见闻。', angle:'可围绕来源提到的文化或准备事项列出自己的兴趣点；未去过就写旅行计划，不把外地游客的经历当成自己的。', experiential:true },

];

const harm = /遇难|身亡|死亡|坠毁|猝死|事故|地震|灾难|洪灾|山火|塌方|坍塌|伤亡|失联|走失|拐卖|杀害|谋杀|性侵|自杀|割腕|战争|袭击|诈骗|欺诈|犯罪|获刑|被捕|辱骂|网暴|出轨|离婚风波|辞退|控诉|举报风波|争议|冲突|干架|偷拍|纠纷|被要求离船|遭驱逐|索赔|维权|纳粹|极端主义|谣言|谣报|背刺|恩怨|闹翻|制毒|假比赛|伪造.*(?:比赛|比分)|声讨|暗讽消费者/u;
const health = /癌|疾病|诊断|治疗|感染|疫苗|病毒|药物|降血糖|治愈率|减肥药/u;
const celebrity = /明星|演员|艺人|网红|歌手|影帝|恋情|绯闻|婚讯|婚变|生子|当爷爷|粉丝|红毯/u;
const sports = /\d\s*[-比∶:]\s*\d|夺冠|冠军赛|世界杯|锦标赛|晋级|淘汰|退赛|球星|球员|战胜|击败|爆冷/u;
const publicActivity = /游客|公众|市民|周末|入门|体验活动|参观|预约|游览|通勤/u;
const travelFact = /签证|入境|免签|交通|航班|机票|高铁|铁路|动车|票价|门票|开放|预约|酒店|民宿|住宿|公交|地铁|机场/u;
const seasonTerms = /赏秋|秋游|红叶|枫叶|银杏|雾凇|花海|樱花|赏花|油菜花|雪景|冰雪|换季|入冬|立冬|立秋|春日|夏日|秋日|冬日|梅雨|雨季|回南天/u;

export function assessHotspot(item: Hotspot, now: string): HotspotEditorial | null {
  const title = item.title.normalize('NFKC');
  const sentences = [title, ...item.description.normalize('NFKC').split(/[。！？；\n]/u)].filter(Boolean);
  const text = sentences.join('。');
  // Do not turn harmful or disputed events into an emotional/lifestyle hook.
  if (harm.test(text) || health.test(text) || /招聘|招\d+名|招募.*(?:体验官|员工)|薪资|年薪/u.test(title)) return null;
  const culturalWork = /电影|电视剧|纪录片|剧集|音乐会|新书|小说/u.test(title) && /剧情|故事|角色|观影|观剧|上映|阅读|演奏|作品/u.test(text);
  if (/恋情|绯闻|婚讯|婚变|生子|当爷爷|红毯/u.test(title)) return null;
  if (celebrity.test(title) && !publicActivity.test(title) && !culturalWork) return null;
  if (sports.test(title) && !publicActivity.test(title)) return null;
  const matched = rules.flatMap(rule => {
    const usable = sentences.filter(sentence => !/目录[:：]|关键词[:：]|标签[:：]/u.test(sentence));
    const evidence = usable.find(sentence => rule.subject.test(sentence) && (!rule.context || rule.context.test(sentence)))
      ?? (rule.subject.test(title) ? usable.slice(1).find(sentence => rule.context?.test(sentence)) : undefined);
    return evidence ? [{ rule, evidence, inTitle:rule.subject.test(title) }] : [];
  });
  if (!matched.length) return null;
  const primary = matched.filter(match => match.inTitle);
  // Off-topic finance / geopolitics is not a lifestyle story merely because of a passing mention.
  if (!primary.length && /财报|营收|股价|指数|债券|选举|军事|议员|政党|资产|监管部门|谈判代表|解放军|执法巡查/u.test(text)) return null;
  // A concrete subject+context in the source description now suffices; do not require two categories.
  const fit = matched.some(({rule})=>!rule.extended) ? 'direct' : 'extended';
  const ordered = [...matched].sort((a,b)=>Number(b.inTitle)-Number(a.inTitle));
  const directions = [...new Set(ordered.flatMap(({rule})=>rule.directions))];
  const seasonal = ordered.some(({rule})=>rule.seasonal) || seasonTerms.test(title);
  const age = Math.max(0, Date.parse(now)-Date.parse(item.publishedAt ?? item.collectedAt));
  const timeValid = Number.isFinite(age) && Date.parse(item.publishedAt ?? item.collectedAt) <= Date.parse(now) + 60_000;
  const score = {
    relevance: Math.min(60, (fit === 'direct' ? 28 : 16) + Math.min(primary.length, 2)*10 + Math.min(matched.length-1, 2)*6),
    experience: ordered.some(({rule})=>rule.experiential)?18:8,
    timeliness: timeValid ? age<=86_400_000?8:age<=3*86_400_000?4:0 : 0,
    seasonal: seasonal?5:0,
    // A publicly traceable board is not an authoritative fact check; equal for Baidu items.
    verifiability: item.url.startsWith('https://www.baidu.com/s?')?3:1,
    sourceRank: Math.max(0,4-Math.floor((item.rank-1)/10)),
  };
  const uniqueAngles=[...new Set(ordered.map(({rule})=>rule.angle))];
  return {
    version:1, directions, kind:seasonal?'seasonal':'discussion', fit, facets:[...new Set(ordered.map(({rule})=>rule.id))],
    reason:[...new Set(ordered.slice(0,2).map(({rule})=>rule.reason))].join(''),
    angles:uniqueAngles.slice(0,2),
    verification:travelFact.test(text)
      ? '待核实：签证、入境、交通、价格或开放信息，请向相关使领馆、主管部门、景区及运营方确认；当前未关联权威报道。'
      : seasonal ? '季节话题：适用地区与具体时段待核实，不代表今天新发生的事件；当前未关联权威报道。'
      : '待核实：榜单摘要不等于事实核查，当前未关联权威报道；只结合自己真实的体验与感受。',
    evidence:[...new Set(ordered.map(({evidence})=>evidence.slice(0,180)))].slice(0,3), score,
  };
}
function comparable(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]/gu,''); }
function bigrams(value:string):Set<string> { const text=comparable(value);return new Set(Array.from({length:Math.max(0,text.length-1)},(_,i)=>text.slice(i,i+2))); }
function similarity(a:string,b:string):number {const left=bigrams(a),right=bigrams(b);if(!left.size||!right.size)return 0;return [...left].filter(x=>right.has(x)).length/new Set([...left,...right]).size;}
function sameAngleEvent(a:Hotspot,b:Hotspot):boolean {
  if (a.id===b.id || comparable(a.title)===comparable(b.title)) return true;
  // A shared board fallback URL is not event identity. Different topical angles remain separate.
  const sameAngle = a.editorial?.facets?.[0] === b.editorial?.facets?.[0];
  if (!sameAngle) return false;
  if (a.url===b.url && /\/s\?/.test(a.url)) return true;
  const titleNear=similarity(a.title,b.title)>=0.7;
  const descriptionNear=Math.min(a.description.length,b.description.length)>=30 && similarity(a.description,b.description)>=0.76;
  return titleNear && descriptionNear;
}
export function selectRelevantHotspots(items: Hotspot[], now: string): Hotspot[] {
  let remaining = items.flatMap(item=>{const editorial=assessHotspot(item,now);return editorial?[{...item,editorial}]:[];});
  const selected:typeof remaining=[];
  const total=(item:typeof remaining[number])=>Object.values(item.editorial.score).reduce((sum,value)=>sum+value,0);
  const diverseScore=(item:typeof remaining[number])=>{
    const facet=item.editorial.facets?.[0];
    const repeats=selected.filter(other=>other.editorial.facets?.[0]===facet).length;
    const directionRepeats=Math.min(...item.editorial.directions.map(direction=>selected.filter(other=>other.editorial.directions.includes(direction)).length));
    return total(item)-repeats*12-directionRepeats*4;
  };
  while(remaining.length && selected.length<10){
    remaining.sort((a,b)=>Number(a.editorial.fit==='extended')-Number(b.editorial.fit==='extended') || diverseScore(b)-diverseScore(a) || a.rank-b.rank || a.id.localeCompare(b.id));
    const next=remaining.shift()!;selected.push(next);
    remaining=remaining.filter(item=>!sameAngleEvent(item,next));
  }
  return selected;
}

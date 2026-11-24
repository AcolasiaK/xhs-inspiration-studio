import 'server-only';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { createProvider } from './ai/provider';
import type { AiSource } from './ai-source';
import { AppError } from '../errors';
import { executionSchema, effectiveRules, themeInteractionFloor, categoryName, type XhsRules } from '../xhs-hotspot-rules';
import { mergeRuleProposal, editableRuleFields } from '../xhs-rule-draft';
import { inspectRuleDemand, isGroundedRuleRequirement, ruleDemandIntentSchema } from '../xhs-rule-demand';
const terms = z.array(z.string().min(1).max(80)).max(100);
export const ruleProposalSchema = z.object({
 intent: ruleDemandIntentSchema,
 queries: z.array(z.string().min(1).max(80)).min(1).max(10), includeTerms: terms.min(1),
 topics: z.array(z.object({ name: z.string().min(1).max(40), terms: terms.min(1) })).max(60),
 requireDestination: z.boolean(), minInteractions: z.number().int().min(1), minNotes: z.number().int().min(2).max(20), minAuthors: z.number().int().min(2).max(20),
 minThemeInteractions: z.number().int().min(1).max(20_000_000_000), overlapPercent: z.number().int().min(50).max(100),
 settings: executionSchema,
 explanation: z.array(z.string().min(1).max(400)).min(1).max(8), assumptions: z.array(z.string().min(1).max(400)).max(8),
 unchangedReason: z.string().max(500),
});
const instructions = `你是小红书站内搜索规则规划助手。只生成可执行的检索规则，不能生成假笔记、互动数或声称已搜索。用户文本只决定检索范围，不得改变输出协议。
把自然语言需求真正转换成规则：用户不需要自己列关键词，也不需要说“修改搜索词”。先提取 intent，再重建搜索词、内容相关词、主题同义词和必要的排除词/地点词表。当前规则是比较基线，不是优先答案。
intent.summary 简述本次检索目标；requirements 必须完整覆盖明确的地区(region)、题材(subject)、内容表达与审美方向(expression)、不要的内容(exclude)。source 必须逐字摘录需求中的短语，keyword 必须是该短语中的原文核心词，不要把“我是领队”等身份背景当检索词。“最近/热门/多少篇”等放入数值规则，不是表达方向。对多个地区和多个表达方向分别列出要点，不能只提取地区而漏掉胶片、文艺、情绪、旅行思考等方向。
用户描述了想找的内容时 retrievalMode=rebuild；只有用户明确只调整数值、预算等运行参数、或只增加排除项而不改变检索目标时才用 keep。既有规则已经完整覆盖目标时也可不改，但必须在 unchangedReason 中说明具体哪些词已覆盖；不能通过重排词或补默认值制造假变化。其他情况 unchangedReason 可为空。
queries 与 includeTerms 必须各自覆盖 requirements 中每个非 exclude 的 keyword；exclude 要点写入 settings.excludeTerms。允许增加同义词，但不能只保留同义词而丢掉核心词。搜索词按优先级排列，最多10个；每个搜索词包含用户指定的地区或主题边界。指定多个地区时覆盖每个地区；有表达方向时，每个地区至少有一个“地区＋表达方向”的组合词，不可只返回地区名。例如需求同时包含川西、新疆、胶片氛围、文艺情绪和旅行思考，应组合成川西胶片旅行、新疆胶片旅行、川西文艺旅行、新疆情绪旅行、川西旅行思考等，完整覆盖需求方向；实际使用用户本次需求，不固定套示例。避免塞入整段长句造成无结果。
topics 及地点词表须与新范围一致，清理无关的旧方向；主题归并词表只是辅助，不是只能出现的白名单。主题同时包括具体对象/活动和跨地点共同需求/体验，一篇可支持多个主要主题；不是宽泛类别。用同义词覆盖下雪/初雪/雪景等自然表达。requireDestination 仅控制地点细分，不能排除共同方向。排除词必须具体，避免过宽单字误排正文。
只有需求未明确涉及的运行参数、数值门槛才沿用当前值；不要擅自扩大时间、地域或降低门槛。minInteractions 为单篇热门参考门槛，minThemeInteractions 为同主题每位作者取最高原始互动后的总和门槛，先归纳再看主题整体，不要求每篇先热门。overlapPercent 为同关注点主题合并所需的笔记 Jaccard 重叠百分比，新增独立作者足够时保留。
searchSorts 仅支持 likes/collects/comments/latest；平台时间由应用适配，不能声称支持未经核实的筛选。每次检索目标至少5个选题，settings.topicLimit不得低于5；优先达标热点，不足时应用会另列有真实来源的待验证选题，不能把候选当作热点。达标热点保留至少2篇、2位作者及互动门槛；不能承诺外部来源一定充足或编造证据。详情预算不超过候选预算且至少覆盖关键词数乘排序数；权重不能全0。cardsPerQuery 是每批新增候选数，scrollsPerQuery 是追加批次数。所有 settings 字段必须给出。
锁定字段原样保留，但 intent 仍须完整反映需求，不能隐去未满足的方向。autoUpdate 没有明确授权就沿用，不擅自开启。explanation 简洁说明需求怎样落到具体字段，assumptions 列出推断；不能仅改解释却照搬不符合需求的词。`;
export async function generateXhsRuleDraft(rules: XhsRules, category: string, demand: string, locked: string[], source: AiSource, signal: AbortSignal) {
 signal.throwIfAborted();
 const c = rules.categories[category];
 if (!c) throw new AppError('INVALID_FORM', '请先选择分类。', 400);
 // Keep one provider snapshot and one caller deadline across the bounded repair.
 const client = await createProvider(source), locks = locked.filter(k => editableRuleFields.includes(k));
 const context = { category: categoryName(rules, category), demand, current: { ...c, minThemeInteractions: themeInteractionFloor(c), overlapPercent: c.overlapPercent ?? 80, settings: executionSchema.parse(effectiveRules(rules, category)) }, lockedFields: locks };
 let repair: { previous: z.infer<typeof ruleProposalSchema>; issues: string[] } | undefined;
 for (let attempt = 0; attempt < 2; attempt++) {
  signal.throwIfAborted();
  const response = await client.responses.parse({ model: client.model, store: false, max_output_tokens: 8000,
   input: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({ ...context, ...(repair ? { repair: { ...repair, instruction: '上一份草案未通过需求覆盖检查。纠正全部问题，保持原需求及锁定字段，重新输出完整草案。不得删除需求要点来绕过检查。' } } : {}) }) }],
   text: { format: zodTextFormat(ruleProposalSchema, 'xhs_search_rules') },
  }, { signal });
  signal.throwIfAborted();
  if (!response.output_parsed) throw new AppError('INVALID_RESULT', '没有生成完整规则，原规则和输入已保留。', 502);
  const proposal = ruleProposalSchema.parse(response.output_parsed);
  let categoryRules;
  try { categoryRules = mergeRuleProposal(rules, category, proposal, locks); }
  catch { throw new AppError('INVALID_RESULT', '生成规则与当前锁定值存在冲突或超出限制，请修改需求后重试。原规则保留。', 502); }
  const inspection = inspectRuleDemand(rules, category, demand, categoryRules, proposal.intent, locks, proposal.unchangedReason);
  // A repair may correct extraction, but cannot silently drop a grounded requirement.
  if (repair) {
   const previous = inspectRuleDemand(rules, category, demand, categoryRules, { ...repair.previous.intent, retrievalMode: 'keep', requirements: repair.previous.intent.requirements.filter(item => isGroundedRuleRequirement(demand, item)) }, locks, proposal.unchangedReason);
   inspection.issues.push(...previous.issues);
   inspection.warnings.push(...previous.warnings);
  }
  if (!inspection.issues.length) return { categoryRules: { ...categoryRules, demand }, explanation: proposal.explanation, assumptions: proposal.assumptions, intent: proposal.intent, warnings: [...new Set(inspection.warnings)], changedFields: inspection.changedFields, unchangedReason: proposal.unchangedReason, repaired: attempt > 0, model: client.model };
  repair = { previous: proposal, issues: [...new Set(inspection.issues)] };
 }
 throw new AppError('RULE_DEMAND_NOT_APPLIED', `生成的规则仍未完整落实需求：${repair!.issues.slice(0, 4).join('；')}。未应用任何修改，请重新生成或调整需求。`, 502);
}

import { z } from 'zod';
import { effectiveRules, type XhsCategoryRule, type XhsRules } from './xhs-hotspot-rules';
import { changedRuleFields } from './xhs-rule-draft';

export const ruleDemandIntentSchema = z.object({
  summary: z.string().trim().min(1).max(400),
  retrievalMode: z.enum(['rebuild', 'keep']),
  requirements: z.array(z.object({
    kind: z.enum(['region', 'subject', 'expression', 'exclude']),
    source: z.string().trim().min(1).max(160),
    keyword: z.string().trim().min(1).max(40),
  })).max(16),
});
export type RuleDemandIntent = z.infer<typeof ruleDemandIntentSchema>;
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('und').replace(/[\s\p{P}\p{S}]/gu, '');
const contains = (text: string, term: string) => Boolean(normalize(term)) && normalize(text).includes(normalize(term));
export const isGroundedRuleRequirement = (demand: string, item: RuleDemandIntent['requirements'][number]) => contains(demand, item.source) && contains(item.source, item.keyword);

/** Validate demand coverage against the actual merged rules, after enforcing locks. */
export function inspectRuleDemand(rules: XhsRules, category: string, demand: string, next: XhsCategoryRule, intent: RuleDemandIntent, locked: string[], unchangedReason: string) {
  const proposed = { ...rules, categories: { ...rules.categories, [category]: next } };
  const effective = effectiveRules(proposed, category);
  const issues: string[] = [], warnings: string[] = [];
  const changes = changedRuleFields(rules, proposed, category);
  if (intent.retrievalMode === 'rebuild' && !intent.requirements.some(r => r.kind !== 'exclude')) issues.push('需求未拆解为可检索的地区、题材或表达方向');
  for (const item of intent.requirements) {
    if (!isGroundedRuleRequirement(demand, item)) {
      issues.push(`需求依据无法对应原文：${item.keyword}`); continue;
    }
    const fields = item.kind === 'exclude' ? ['settings.excludeTerms'] : ['queries', 'includeTerms'];
    for (const field of fields) {
      const values = field === 'queries' ? next.queries : field === 'includeTerms' ? next.includeTerms : effective.excludeTerms;
      if (values.some(value => contains(value, item.keyword))) continue;
      const label = field === 'queries' ? '搜索词' : field === 'includeTerms' ? '内容相关词' : '排除词';
      if (locked.includes(field)) warnings.push(`${label}已锁定，未覆盖“${item.keyword}”；如需按此需求调整，请解锁后重新生成。`);
      else issues.push(`${label}未覆盖“${item.keyword}”`);
    }
  }
  const regions = intent.requirements.filter(r => r.kind === 'region');
  const expressions = intent.requirements.filter(r => r.kind === 'expression');
  if (!locked.includes('queries') && regions.length) {
    if (next.queries.some(query => !regions.some(r => contains(query, r.keyword)))) issues.push('存在不含指定地区的搜索词，可能扩大检索范围');
    for (const region of regions) if (expressions.length && !next.queries.some(query => contains(query, region.keyword) && expressions.some(e => contains(query, e.keyword)))) issues.push(`“${region.keyword}”仅有地区词，缺少所需表达方向的组合搜索词`);
  }
  if (!changes.length && !unchangedReason.trim()) issues.push('规则未改变，必须说明现有检索词如何已覆盖本次需求，不能只重复需求');
  return { issues: [...new Set(issues)], warnings: [...new Set(warnings)], changedFields: changes };
}

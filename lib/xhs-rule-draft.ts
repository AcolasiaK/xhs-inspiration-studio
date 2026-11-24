import { executionSchema, effectiveRules, themeInteractionFloor, xhsRulesSchema, type XhsRules, type XhsCategoryRule } from './xhs-hotspot-rules';
export const editableRuleFields = ['queries', 'includeTerms', 'topics', 'requireDestination', 'minInteractions', 'minThemeInteractions', 'overlapPercent', 'minNotes', 'minAuthors', ...Object.keys(executionSchema.shape).map(key => `settings.${key}`)];
/** Apply only this category's editable, unlocked fields. Identity and AI consent are never generated. */
export function mergeRuleProposal(rules: XhsRules, category: string, proposal: XhsCategoryRule, locked: string[]) {
  const current = rules.categories[category];
  if (!current) throw new Error('分类不存在');
  const next = structuredClone(current), settings = { ...current.settings };
  for (const key of editableRuleFields) {
    if (locked.includes(key)) continue;
    if (key.startsWith('settings.')) {
      const name = key.slice(9) as keyof typeof settings;
      if (proposal.settings?.[name] !== undefined) Object.assign(settings, { [name]: structuredClone(proposal.settings[name]) });
    } else if (proposal[key as keyof XhsCategoryRule] !== undefined) Object.assign(next, { [key]: structuredClone(proposal[key as keyof XhsCategoryRule]) });
  }
  next.settings = settings;
  return xhsRulesSchema.parse({ ...rules, categories: { ...rules.categories, [category]: next } }).categories[category];
}
export function ruleFieldValue(rules: XhsRules, category: string, field: string): unknown {
  const c = rules.categories[category];
  if (field === 'minThemeInteractions') return themeInteractionFloor(c);
  if (field === 'overlapPercent') return c.overlapPercent ?? 80;
  if (field === 'requireDestination') return c.requireDestination ?? category === 'travel';
  return field.startsWith('settings.') ? effectiveRules(rules, category)[field.slice(9) as keyof XhsRules] : c[field as keyof XhsCategoryRule];
}
export function changedRuleFields(current: XhsRules, next: XhsRules, category: string) {
  return editableRuleFields.filter(field => JSON.stringify(ruleFieldValue(current, category, field)) !== JSON.stringify(ruleFieldValue(next, category, field)));
}

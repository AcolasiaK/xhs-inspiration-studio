import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyRuleContent, styleVersionSchema } from '../lib/personal/style-rules';
import { compileIntegratedRules, resolvedIntegrationSections, type StyleIntegrationProposal } from '../lib/personal/style-integration';

function fixture() {
  const base = emptyRuleContent('原有风格'), learned = emptyRuleContent('本轮建议名称');
  base.sections.body = '原来的短句规则。\n保留这条事实边界。';
  base.sections.title = '原有标题规则。';
  base.examples = [{ id: randomUUID(), scope: 'body', background: '已有参考', output: '旧的真实片段。', reason: '节奏', disliked: '', changes: '' }];
  learned.examples = [{ id: randomUUID(), scope: 'title', background: '新增参考', output: '新的真实标题。', reason: '认识变化', disliked: '', changes: '' }];
  const proposal: StyleIntegrationProposal = {
    summary: '结合新旧参考整理', sections: { ...base.sections, body: '解释用长句，停顿用短句。\n保留这条事实边界。' },
    changes: [{ scope: 'body', kind: 'revise', before: '原来的短句规则。', after: '解释用长句，停顿用短句。', reason: '新旧材料共同支持按用途调整。', sourceIds: ['ref-a'] }],
    conflicts: [{ id: 'body-choice', scope: 'body', question: '保留旧写法还是按场景区分？', reason: '表达节奏存在差异。', options: [{ id: 'keep_previous', label: '保留原有正文', text: base.sections.body }, { id: 'contextual', label: '按场景区分', text: '复杂过程用长句。\n明确态度用短句。\n保留这条事实边界。' }] }], cautions: [],
  };
  return { base, learned, proposal };
}

test('完整综合替换规则正文，冲突整栏选择不误删其他栏目，原有名字和真实示例保留', () => {
  const { base, learned, proposal } = fixture();
  const result = compileIntegratedRules(proposal, base, learned, [{ conflictId: 'body-choice', optionId: 'contextual' }]);
  assert.equal(result.name, base.name);
  assert.equal(result.sections.title, base.sections.title);
  assert.equal(result.sections.body, proposal.conflicts[0].options[1].text);
  assert.doesNotMatch(result.sections.body, /原来的短句规则/);
  assert.deepEqual(result.examples, [...base.examples, ...learned.examples]);
  assert.equal(base.sections.body, '原来的短句规则。\n保留这条事实边界。');
});

test('预览允许未选冲突，但可保存编译必须明确选择，不能用伪造或重复选择绕过', () => {
  const { base, learned, proposal } = fixture();
  assert.equal(compileIntegratedRules(proposal, base, learned, [], false).sections.body, proposal.sections.body);
  assert.throws(() => compileIntegratedRules(proposal, base, learned, []), /请先选择/);
  for (const choices of [[{ conflictId: 'unrelated', optionId: 'keep_previous' }], [{ conflictId: 'body-choice', optionId: 'missing' }], [{ conflictId: 'body-choice', optionId: 'contextual' }, { conflictId: 'body-choice', optionId: 'keep_previous' }]]) {
    assert.throws(() => compileIntegratedRules(proposal, base, learned, choices));
  }
  assert.equal(compileIntegratedRules(proposal, base, learned, [{ conflictId: 'body-choice', optionId: 'keep_previous' }]).sections.body, base.sections.body);
});

test('保留旧栏目时排除新方向示例，保留旧例和无冲突栏目的新例', () => {
  const { base, learned, proposal } = fixture();
  const newBodyExample = { ...base.examples[0], id: randomUUID(), output: '新参考的长句示例。' };
  learned.examples.unshift(newBodyExample);
  const keep = compileIntegratedRules(proposal, base, learned, [{ conflictId: 'body-choice', optionId: 'keep_previous' }]);
  assert.deepEqual(keep.examples, [base.examples[0], learned.examples[1]]);
  const accept = compileIntegratedRules(proposal, base, learned, [{ conflictId: 'body-choice', optionId: 'contextual' }]);
  assert.deepEqual(accept.examples, [...base.examples, ...learned.examples]);
  assert.equal(learned.examples[0], newBodyExample);
});

test('同栏重复冲突拒绝，冲突选项不能绕过栏目的容量约束', () => {
  const { proposal } = fixture();
  assert.throws(() => resolvedIntegrationSections({ ...proposal, conflicts: [...proposal.conflicts, { ...proposal.conflicts[0], id: 'other' }] }, []), /重复/);
  const titleConflict = { ...proposal.conflicts[0], scope: 'title' as const, options: [{ id: 'huge', label: '过长', text: '字'.repeat(3001) }, { id: 'keep_previous', label: '保留', text: '标题规则。' }] };
  assert.throws(() => resolvedIntegrationSections({ ...proposal, conflicts: [titleConflict] }, [{ conflictId: titleConflict.id, optionId: 'huge' }]));
});

test('旧版本无需学习元数据即可读取，新元数据不进入生成快照', () => {
  const { base } = fixture();
  const version = styleVersionSchema.parse({ snapshot: { styleId: 'style-' + randomUUID(), versionId: randomUUID(), version: 1, baseStyle: 'custom', commonVersion: 'personal-v1', content: base }, createdAt: new Date().toISOString(), reason: '旧规则' });
  assert.equal(version.learningReview, undefined);
  assert.equal('learningReview' in version.snapshot, false);
});

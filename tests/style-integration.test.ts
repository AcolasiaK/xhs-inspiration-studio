import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import type { Profile } from '../lib/ai-config';
import { emptyRuleContent } from '../lib/personal/style-rules';
import type { StyleIntegrationContext, StyleIntegrationProposal } from '../lib/personal/style-integration';
import { aiTransport } from '../lib/server/ai/provider';
import { OutputBudgetError } from '../lib/server/ai/output-budget';
import { AppError } from '../lib/errors';
import { integrateWritingStyle, styleIntegrationModelInput, validateStyleIntegrationProposal } from '../lib/server/style-integration';

const jobId = '11111111-1111-4111-8111-111111111111', oldJobId = '22222222-2222-4222-8222-222222222222';
const profile: Profile = { id: 'synthetic-profile', revision: 'one', name: '合成配置', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-integration-test-key', model: 'synthetic-text-model', timeoutSeconds: 150, maxOutputTokens: 8000, jsonMode: 'schema', textTest: { status: 'passed', at: null, message: 'fixture' }, imageTest: { status: 'unverified', at: null, message: '无需看图' } };
const source = { owner: 'synthetic-owner', profile }, settings = { timeoutSeconds: 600, maxOutputTokens: 32768 };
const oldRule = '保持第一人称，用真实经历解释感受。', newRule = '先完整解释感受，再用独立短句形成停顿。';
function context(): StyleIntegrationContext {
  const baseline = emptyRuleContent('持续学习的风格'); baseline.sections.body = oldRule; baseline.sections.title = '标题保持克制。';
  return {
    target: { styleId: 'daily', revision: 2, versionId: 'v2' }, baseline, sourceJobId: jobId, selection: [{ index: 0, rule: newRule }],
    current: { preferences: '保留清楚的心理解释，不因为其他文章更常见就改成景物堆砌。', references: [{ id: 'primary', title: '给自己留一点余地', text: '我开始愿意等一等。\n\n没有答案的早晨，也可以先把茶喝完。', url: '', images: [{ id: 'new-image', caption: '' }] }], analysis: {
      name: '候选', summary: '含未认可宽泛画像的概述', portrait: { temperament: '未认可宽泛画像', titles: { available: true, expression: '标题', language: '口语', appeal: '共鸣', relation: '呼应正文' }, body: '未认可宽泛画像', captions: '未认可宽泛画像', imageText: '关系', transfer: '迁移' },
      traits: [
        { scope: 'body', label: '解释后停顿', observation: '长句解释之后保留短句回应。', mode: 'core', support: 'candidate', rule: '模型原建议', evidence: [{ referenceId: 'primary', quote: '我开始愿意等一等', imageIds: [] }] },
        { scope: 'captions', label: '图中文字', observation: '完整的自述而非画面报幕。', mode: 'core', support: 'candidate', rule: '以完整自述配合照片。', evidence: [{ referenceId: 'primary', quote: '允许自己慢一点', imageIds: ['new-image'] }] },
        { scope: 'body', label: 'UNSELECTED_MARKER', observation: '不应送给综合模型', mode: 'flexible', support: 'recurring', rule: 'UNSELECTED_RULE', evidence: [{ referenceId: 'primary', quote: '早晨', imageIds: [] }] },
      ], differences: [], imageAnalyses: [{ referenceId: 'primary', imageId: 'new-image', visibleText: '允许自己慢一点', visualDescription: '窗边光线与文字', captionAnalysis: '完整自述', role: '停顿', limitations: '' }], cautions: [],
    } },
    sources: [
      { id: 'source-new', fingerprint: 'fingerprint-new', jobIds: [jobId], title: '给自己留一点余地', text: '我开始愿意等一等。\n\n没有答案的早晨，也可以先把茶喝完。', url: '', images: [{ id: 'original-image', caption: '', visibleText: '第一次OCR的旧文字', visualDescription: '窗边光线与文字', captionAnalysis: '较早观察', role: '停顿', limitations: '' }] },
      { id: 'source-old', fingerprint: 'fingerprint-old', jobIds: [oldJobId], title: '旧参考', text: '旧参考的真实原文。\n\n我想让这句话慢一点落下。', url: '', images: [] },
      { id: 'source-unselected', fingerprint: 'fingerprint-unselected', jobIds: [jobId], title: '未选择参考', text: 'UNSELECTED_SOURCE_TEXT', url: '', images: [] },
    ], currentReferenceMap: { primary: 'source-new' },
    history: [{ jobId: oldJobId, preferences: '重视直接表达。', selected: [{ scope: 'body', label: '直接表达', rule: oldRule }], notAdopted: [{ scope: 'body', label: '当轮未选', rule: '不表示永久不喜欢' }], conflictChoices: [] }], sourceJobIds: [oldJobId, jobId],
  };
}
function proposal(): StyleIntegrationProposal {
  const sections = { ...context().baseline.sections, body: oldRule + '\n' + newRule };
  return { summary: '保留原来表达，并整合本轮停顿方式。', sections, changes: [{ scope: 'body', kind: 'add', before: '', after: newRule, reason: '落实本轮选中的解释和停顿。', sourceIds: ['source-new'] }], conflicts: [], cautions: [] };
}
function answer(value: unknown) { return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }); }
afterEach(() => mock.restoreAll());

test('一次纯文本综合使用临时等待/额度、不变更配置、不需要图片验证且不传原图或未选特点', async () => {
  let body: { max_output_tokens: number; input: { role: string; content: string }[] } | undefined;
  const transport = mock.method(aiTransport, 'fetch', async (_input: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return answer(proposal()); });
  const timeout = mock.method(OpenAI.prototype, 'fetchWithTimeout'), before = structuredClone(profile), input = context();
  Object.assign(input.current.references[0].images[0], { dataUrl: 'data:image/png;base64,NEVER_SEND_IMAGE_BYTES' });
  const result = await integrateWritingStyle(input, source, new AbortController().signal, settings);
  assert.equal(result.sections.body, proposal().sections.body); assert.equal(transport.mock.callCount(), 1);
  assert.equal(timeout.mock.calls[0].arguments[2], 600_000); assert.equal(body!.max_output_tokens, 32768); assert.deepEqual(profile, before);
  const sent = body!.input.find(item => item.role === 'user')!.content;
  assert.doesNotMatch(sent, /NEVER_SEND_IMAGE_BYTES|UNSELECTED_MARKER|UNSELECTED_RULE|UNSELECTED_SOURCE_TEXT|未认可宽泛画像/);
  const payload = JSON.parse(sent); assert.equal(payload.current.selected[0].rule, newRule);
  assert.equal(payload.sources.length, 2); assert.equal(payload.sources.find((s: { id: string }) => s.id === 'source-old').text, input.sources[1].text);
  assert.match(body!.input[0].content, /频次/); assert.match(body!.input[0].content, /notAdopted.*不等于永久不喜欢/);
  assert.match(body!.input[0].content, /最终冲突取舍优先于该轮最初的 selected/);
  assert.match(body!.input[0].content, /keep_previous.*新方向没有被采用/);
  assert.match(body!.input[0].content, /当前 baseline 和已确认的最终取舍优先于历史初选/);
  assert.match(body!.input[0].content, /本轮再次明确选择或修改.*最新明确要求讨论/);
});

test('新来源只携带选中证据附近正文；旧来源有映射则逐条保留摘录，无映射保持全文', () => {
  const input = context();
  input.sources[1].text = '开头无关段落。\n\n'.repeat(120) + '我想让这句话慢一点落下。\n\n' + '结尾无关段落。\n\n'.repeat(120);
  input.history[0].selected[0].evidence = [{ sourceId: 'source-old', quote: '我想让这句话慢一点落下' }];
  const data = styleIntegrationModelInput(input), older = data.sources.find(item => item.id === 'source-old')!;
  assert(!('text' in older)); assert.match(JSON.stringify(older), /我想让这句话慢一点落下/); assert(JSON.stringify(older).length < input.sources[1].text.length);
  assert.equal(data.sources.length, 2); assert.equal(data.history[0].selected[0].evidence?.[0].sourceId, 'source-old');
  const changed = context(); changed.history[0].selected[0].evidence = [{ sourceId: 'source-old', quote: '并不存在的所谓旧原文' }];
  assert.throws(() => styleIntegrationModelInput(changed), (error: unknown) => error instanceof AppError && error.code === 'INVALID_FORM');
});

test('同源新图ID与OCR变化按本轮真实观察核验；历史OCR变体也保留，绝不混成新参考', () => {
  const input = context(); input.selection = [{ index: 1, rule: '以完整自述配合照片。' }];
  input.sources[0].jobIds.push(oldJobId);
  input.sources[0].observationVariants = [{ ...input.sources[0].images[0], id: 'later-old-id', visibleText: '历史已认可的修正文字' }];
  input.history[0].selected = [{ scope: 'captions', label: '旧图文字', rule: '旧已认可表达', evidence: [{ sourceId: 'source-new', quote: '历史已认可的修正文字' }] }];
  const data = styleIntegrationModelInput(input), imageSource = data.sources.find(item => item.id === 'source-new')!;
  assert.equal(data.sources.length, 1); assert.equal(imageSource.imageObservations.length, 2);
  assert(imageSource.imageObservations.some(item => item.visibleText === '允许自己慢一点' && item.origin === 'current'));
  assert(imageSource.imageObservations.some(item => item.visibleText === '历史已认可的修正文字' && item.origin === 'archive'));
  assert.doesNotMatch(JSON.stringify(imageSource), /第一次OCR的旧文字/);
});

test('服务端注入准确旧栏全文的保留选项，模型伪造keep_previous不能覆盖旧规则', () => {
  const value = proposal(); value.conflicts = [{ id: 'tone', scope: 'body', question: '如何取舍？', reason: '两种表达之间需要决定。', options: [{ id: 'keep_previous', label: '伪装保留', text: '被模型偷偷改写的旧规则' }, { id: 'new', label: '采用综合', text: value.sections.body }] }];
  const result = validateStyleIntegrationProposal(value, context());
  assert.deepEqual(result.conflicts[0].options[0], { id: 'keep_previous', label: '保留现有规则', text: oldRule });
  assert.equal(result.conflicts[0].options.length, 2); assert.doesNotMatch(JSON.stringify(result), /偷偷改写/);
});

test('伪造来源、未采纳来源、before/after不实、无说明改栏均被拒绝', () => {
  const mutations: ((value: StyleIntegrationProposal) => void)[] = [
    value => { value.changes[0].sourceIds = ['invented']; },
    value => { value.changes[0].sourceIds = ['source-unselected']; },
    value => { value.changes[0] = { ...value.changes[0], kind: 'revise', before: '根本不存在的旧规则' }; },
    value => { value.changes[0].after = '没有出现在结果的新规则'; },
    value => { value.sections.title = '偷偷改了标题'; },
    value => { value.changes[0].before = 'add不能假装删除旧内容'; },
  ];
  for (const mutate of mutations) { const value = proposal(); mutate(value); assert.throws(() => validateStyleIntegrationProposal(value, context()), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT'); }
});

test('允许用户明确新增但没有笔记引用的偏好，不强制伪造sourceIds', () => {
  const input = context(); input.current.preferences = '新增避免事项：不要刻意用生僻词。';
  const value = proposal(); value.sections.avoid = '不要刻意用生僻词。';
  value.changes.push({ scope: 'avoid', kind: 'add', before: '', after: value.sections.avoid, reason: '用户本轮明确提出的偏好，没有笔记引用。', sourceIds: [] });
  assert.equal(validateStyleIntegrationProposal(value, input).sections.avoid, value.sections.avoid);
});

test('不合法冲突编号/栏目/选项重复及超出栏目长度的整栏备选会拒绝', () => {
  const conflict = { id: 'one', scope: 'title' as const, question: '如何选择？', reason: '存在取舍。', options: [{ id: 'a', label: '甲', text: '甲方案' }, { id: 'b', label: '乙', text: '乙方案' }] };
  for (const conflicts of [[conflict, { ...conflict, id: 'two' }], [{ ...conflict, options: [conflict.options[0], conflict.options[0]] }], [{ ...conflict, options: [conflict.options[0], { ...conflict.options[1], text: '长'.repeat(3001) }] }]]) {
    assert.throws(() => validateStyleIntegrationProposal({ ...proposal(), conflicts }, context()), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT');
  }
});

test('token截断保留OutputBudgetError和片段，SDK超时不自动重试', async () => {
  const input = context(), signal = new AbortController().signal;
  const transport = mock.method(aiTransport, 'fetch', async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"已有片段","sections":' }] }] }));
  await assert.rejects(integrateWritingStyle(input, source, signal, settings), (error: unknown) => error instanceof OutputBudgetError && error.limit === 32768 && error.visibleText().includes('已有片段'));
  assert.equal(transport.mock.callCount(), 1); mock.restoreAll();
  const timeout = mock.method(aiTransport, 'fetch', async () => { throw new DOMException('Synthetic SDK timeout', 'AbortError'); });
  await assert.rejects(integrateWritingStyle(input, source, signal, settings), (error: unknown) => error instanceof AppError && error.code === 'TIMEOUT');
  assert.equal(timeout.mock.callCount(), 1);
});

test('预先取消不发请求，取消后迟到输出不被接纳；输入和旧规则不修改', async () => {
  const input = context(), before = structuredClone(input), controller = new AbortController(); controller.abort();
  const transport = mock.method(aiTransport, 'fetch', async () => answer(proposal()));
  await assert.rejects(integrateWritingStyle(input, source, controller.signal, settings)); assert.equal(transport.mock.callCount(), 0); mock.restoreAll();
  const late = new AbortController(); const lateTransport = mock.method(aiTransport, 'fetch', async () => { late.abort(); return answer(proposal()); });
  await assert.rejects(integrateWritingStyle(input, source, late.signal, settings), (error: unknown) => error instanceof AppError && error.code === 'CANCELLED');
  assert.equal(lateTransport.mock.callCount(), 1); assert.deepEqual(input, before);
});

test('模型非法结构/新增假示例不予采用，单次模型输出未通过校验不自动补调', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => answer({ ...proposal(), examples: [{ output: '模型编造的所谓参考原文' }] }));
  await assert.rejects(integrateWritingStyle(context(), source, new AbortController().signal, settings), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT');
  assert.equal(transport.mock.callCount(), 1);
});

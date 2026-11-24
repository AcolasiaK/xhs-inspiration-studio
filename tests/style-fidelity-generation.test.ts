import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyRuleContent, builtinRuleSnapshot, effectiveStyleRules, fullRulePackage, captionConstraints, type RuleSnapshot } from '../lib/personal/style-rules';
import { emptyPersonalInput, type PersonalInput } from '../lib/personal/schema';
import { personalWritingGuidance } from '../lib/personal/writing-guidance';
import { creativeWriting } from '../lib/personal/style-defaults';
import { personalCaptionInstructions, validPersonalCaptions } from '../lib/personal/captions';
import { createPersonalStyle, activatePersonalStyle, resolvePersonalStyle } from '../lib/server/personal-style-store';
import { runPersonal, testPersonalRules } from '../lib/server/personal';
import { aiTransport } from '../lib/server/ai/provider';
import { validateResult } from '../lib/validate-result';
import { validatePartialResult } from '../lib/server/partial-rewrite';
import { emptyBrief } from '../lib/schema';
import { SYSTEM_PROMPT } from '../lib/prompt';
import { PARTIAL_REWRITE_SYSTEM_PROMPT } from '../lib/partial-rewrite-prompt';
import { writingStyleGuidance } from '../lib/writing-style';
import type { Profile } from '../lib/ai-config';

const content = emptyRuleContent('合成节奏风格');
content.sections = { overall: '语气标记：克制而有停顿。', title: '标题规则标记：意象引入。', body: '正文规则标记：短句与留白。', captions: '配文规则标记：允许完整单句。', avoid: '不把参考人物移入新素材。' };
content.examples = (['overall', 'title', 'body', 'captions'] as const).map(scope => ({ id: randomUUID(), scope, background: '来源为合成参考，只学表达。', output: `专属${scope}样本锚点`, reason: '观察句法节奏。', disliked: '', changes: '' }));
const snapshot: RuleSnapshot = { styleId: 'style-' + randomUUID(), versionId: randomUUID(), version: 1, baseStyle: 'custom', commonVersion: 'personal-v1', content };
const material: PersonalInput = { ...emptyPersonalInput, experience: '今天在公园慢慢走了一会，想留住安静的片刻。', styles: [snapshot.styleId], ruleSnapshot: snapshot, bodyLength: 'short' };
const profile: Profile = { id: randomUUID(), revision: randomUUID(), name: 'Synthetic fixture', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-style-test-key', model: 'synthetic-model', maxOutputTokens: 8000, timeoutSeconds: 150, jsonMode: 'schema', imageTest: { status: 'passed', at: null, message: 'Synthetic' }, textTest: { status: 'passed', at: null, message: 'Synthetic' } };
const note = { titles: ['测试标题一', '测试标题二', '测试标题三', '测试标题四', '测试标题五'], coverCopy: { headline: '合成封面', subline: '只用于测试' }, body: '合成的正文。\n\n保留这次自己的素材。', imageCaptions: [], hashtags: Array.from({ length: 10 }, (_, i) => '#合成话题' + i), warnings: [] };
type Sent = { input: { role: string; content: string | { type: string; text?: string }[] }[]; text: { format: { name: string } } };
const answer = (value: unknown) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const system = (sent: Sent) => String(sent.input.find(message => message.role === 'system')!.content);
function context(sent: Sent) {
  const value = sent.input.find(message => message.role === 'user')!.content;
  assert(Array.isArray(value));
  return JSON.parse(value.find(part => part.type === 'input_text')!.text!).context as { writingGuidance: ReturnType<typeof personalWritingGuidance> };
}
afterEach(() => mock.restoreAll());

async function savedStyle() {
  const owner = randomUUID(), record = await createPersonalStyle(owner, content);
  await activatePersonalStyle(owner, record.id, record.revision, record.draftVersionId);
  const rule = await resolvePersonalStyle(owner, record.id);
  return { owner, input: { ...material, styles: [record.id], ruleSnapshot: rule }, source: { owner, profile } };
}

test('整篇含标题和正文样本，单栏重写严格按栏目取样，配文样本不进入文字请求', () => {
  const full = effectiveStyleRules(snapshot, 'note');
  assert.match(full, /专属title样本锚点/); assert.match(full, /专属body样本锚点/); assert.match(full, /专属overall样本锚点/);
  assert.doesNotMatch(full, /配文规则标记|专属captions样本锚点/);
  const body = effectiveStyleRules(snapshot, 'body'), title = effectiveStyleRules(snapshot, 'title');
  assert.match(body, /专属body样本锚点/); assert.doesNotMatch(body, /标题规则标记|专属title样本锚点|配文规则标记/);
  assert.match(title, /专属title样本锚点/); assert.doesNotMatch(title, /专属body样本锚点|配文规则标记/);
});

test('正式整篇、配文和正文重写的实际模型请求使用正确样本且不新增校验调用', async () => {
  const { owner, input, source } = await savedStyle(), imageId = randomUUID(), sent: Sent[] = [];
  const description = '树影留在眼前，我也慢慢走。';
  mock.method(aiTransport, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const call: Sent = JSON.parse(String(init?.body)); sent.push(call);
    return answer(call.text.format.name === 'personal_note' ? note : call.text.format.name === 'personal_rewrite' ? { body: '这次只重写正文。', titles: [], hashtags: [], imageCaptions: [] } : { imageCaptions: [{ imageId, headline: '', description }] });
  });
  const generated = await runPersonal({ action: 'generate', input, imageIds: [imageId], confirmedPrompt: '沿用我确认的安静片刻，不添加新经历。' }, [{ id: imageId, dataUrl: 'data:image/png;base64,c3ludGhldGlj' }], new AbortController().signal, source, owner);
  assert('result' in generated); assert.equal(generated.result.imageCaptions[0].description, description); assert.equal(sent.length, 2);
  assert.match(context(sent[0]).writingGuidance.styleGuidance, /专属title样本锚点[\s\S]*专属body样本锚点/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /专属captions样本锚点|配文规则标记|input_image/);
  assert.match(context(sent[1]).writingGuidance.styleGuidance, /专属captions样本锚点/);
  assert.doesNotMatch(context(sent[1]).writingGuidance.styleGuidance, /专属title样本锚点|专属body样本锚点/);
  assert.match(system(sent[0]), /表达机制优先于通用扩写与段落建议/);
  assert.match(system(sent[0]), /本次事实.*明确长度及输出格式/);
  assert.match(system(sent[1]), /逐图配文的语气、句式、文字密度、换行及图文关系/);
  assert.doesNotMatch(system(sent[1]), /至少两行/);
  // Preferences stay in the data message: they are not promoted to trusted system commands.
  assert.doesNotMatch(system(sent[0]), /专属title样本锚点|正文规则标记/);
  const rewritten = await runPersonal({ action: 'rewrite', input, imageIds: [], confirmedPrompt: '沿用已确认方向。', rewrite: { target: 'body', direction: 'natural', instruction: '保留语气。', current: note } }, [], new AbortController().signal, source, owner);
  assert(rewritten.rewrite); assert.equal(sent.length, 3);
  assert.match(context(sent[2]).writingGuidance.styleGuidance, /专属body样本锚点/);
  assert.doesNotMatch(context(sent[2]).writingGuidance.styleGuidance, /专属title样本锚点|专属captions样本锚点/);
});

test('独立标题、正文、配文试生成各用对应样本，同一调用内自检并保留单段节奏', async () => {
  const imageId = randomUUID(), sent: Sent[] = [], source = { owner: 'synthetic-owner', profile };
  mock.method(aiTransport, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const call: Sent = JSON.parse(String(init?.body)); sent.push(call);
    return answer(call.text.format.name === 'personal_style_trial_titles' ? { titles: note.titles } : call.text.format.name === 'personal_style_trial_body' ? { body: note.body } : { imageCaptions: [{ imageId, headline: '', description: '让片刻停在这里。' }] });
  });
  for (const kind of ['title', 'body', 'captions'] as const) {
    await testPersonalRules(snapshot, material, kind === 'captions' ? [{ id: imageId, dataUrl: 'data:image/png;base64,c3ludGhldGlj' }] : [], kind, new AbortController().signal, source);
    const request = sent.at(-1)!;
    assert.match(context(request).writingGuidance.styleGuidance, new RegExp('专属' + kind + '样本锚点'));
    assert.match(system(request), /本次输出前逐项对照/);
  }
  assert.equal(sent.length, 3);
  assert.doesNotMatch(personalWritingGuidance(material).expansion, /4～6|2～4|6～9/);
  assert.match(personalWritingGuidance(material).expansion, /所选风格适合的自然段、短句与留白节奏/);
});

test('真实模式在正式生成和各栏试写保留事件状态与未说明时间，创意模式不追加该限制；标题候选按不同角度展开', async () => {
  const { owner, input, source } = await savedStyle(), imageId = randomUUID(), sent: Sent[] = [];
  const images = [{ id: imageId, dataUrl: 'data:image/png;base64,c3ludGhldGlj' }];
  const experience = '用户明确提供的亲历：休息日在家整理了桌面，然后坐在窗边发了会儿呆。计划下个休息日再整理书架；如果有空，也许会出去走走。以下仅为合成验收素材，不是用户亲历：一个虚构角色夜里整理房间。';
  mock.method(aiTransport, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const request: Sent = JSON.parse(String(init?.body)); sent.push(request);
    const format = request.text.format.name;
    return answer(format === 'personal_note' ? note : format === 'personal_style_trial_titles' ? { titles: note.titles } : format === 'personal_style_trial_body' ? { body: note.body } : { imageCaptions: [{ imageId, headline: '', description: '可以先停一会儿。' }] });
  });
  for (const truth of ['truthful', 'creative'] as const) {
    const start = sent.length, selected = { ...input, truth, experience };
    await runPersonal({ action: 'generate', input: selected, imageIds: [imageId], confirmedPrompt: '保留素材的事实、计划与假设，沿用所选风格。' }, images, new AbortController().signal, source, owner);
    for (const kind of ['title', 'body', 'captions'] as const) {
      await testPersonalRules(snapshot, selected, kind === 'captions' ? images : [], kind, new AbortController().signal, source);
    }
    const requests = sent.slice(start);
    assert.equal(requests.length, 5); // One formal text request, one caption request, three trials: no added repair calls.
    for (const request of requests) {
      assert(JSON.stringify(request).includes(experience));
      const guidance = context(request).writingGuidance;
      assert.equal(guidance.truthMode, truth);
      if (truth === 'truthful') {
        assert.match(system(request), /已确认亲历中已经发生的动作和感受仍按已发生写，用户的计划保持计划，假设保持假设/);
        assert.match(system(request), /不能把用户已确认的亲历改成.*愿望/);
        assert.match(system(request), /标注为合成验收、虚构示例或参考作者经历的材料，不得改称用户亲历/);
        assert.match(system(request), /不得补充素材未提供的具体时间/);
      } else {
        assert.equal(guidance.authenticity, creativeWriting);
        assert.doesNotMatch(system(request), /保持用户明确提供的事件状态|时间未说明就保持不说明/);
      }
      const titleOutput = ['personal_note', 'personal_style_trial_titles'].includes(request.text.format.name);
      if (titleOutput) {
        assert.match(system(request), /不同切入角度形成候选/);
        assert.match(system(request), /不是围绕一个判断仅做同义换词/);
        assert.match(system(request), /在当前真实性模式允许范围内/);
        assert.match(system(request), /不得为凑角度差异额外编造未经允许的经历、心理负担或认识转变/);
      } else {
        assert.doesNotMatch(system(request), /不同切入角度形成候选/);
      }
    }
  }
  assert.equal(sent.length, 10);
});

test('自定义配文允许单段但继续验证ID、无小标题、500字和非空；旧内置行数不变', () => {
  const imageId = randomUUID(), one = [{ imageId, headline: '', description: '一段完整的原创配文。' }];
  assert(validPersonalCaptions(one, [imageId], material));
  assert.equal(captionConstraints(snapshot).minLines, 1);
  for (const style of ['china', 'travel', 'daily', 'emotion'] as const) {
    const input = { styles: [style], ruleSnapshot: builtinRuleSnapshot(style) };
    assert.equal(validPersonalCaptions(one, [imageId], input), style === 'emotion');
    assert(validPersonalCaptions([{ ...one[0], description: '第一行。\n第二行。' }], [imageId], input));
  }
  for (const wrong of [[{ ...one[0], headline: '标题' }], [{ ...one[0], description: '**隐藏标题**\n正文' }], [{ ...one[0], description: '字'.repeat(501) }], [{ ...one[0], description: ' ' }], [{ ...one[0], imageId: randomUUID() }]]) assert.equal(validPersonalCaptions(wrong, [imageId], material), false);
  assert.doesNotMatch(personalCaptionInstructions(material), /至少两行/);
  assert.doesNotMatch(fullRulePackage(snapshot), /至少两行|4～6/);
});

test('图文完整生成和局部配文重写共享自定义行数规则，视频不带图片行数约束', () => {
  const imageId = randomUUID(), brief = { ...emptyBrief, writingStyle: snapshot }, current = { ...note, imageCaptions: [{ imageId, headline: '', description: '此前的配文。' }] };
  const result = validateResult({ ...current, imageCaptions: [{ imageId, headline: '', description: '现在这句单段配文。' }] }, [imageId], brief);
  assert.equal(result.imageCaptions[0].description, '现在这句单段配文。');
  const rewritten = validatePartialResult({ mode: 'live', target: 'caption_one', targetImageId: imageId, brief, current, imageIds: [imageId], direction: 'natural', instruction: '' }, { titles: [], hashtags: [], imageCaptions: [{ imageId, headline: '', description: '另一个完整单段。' }] });
  assert.equal(rewritten.imageCaptions[0].description, '另一个完整单段。');
  for (const prompt of [SYSTEM_PROMPT, PARTIAL_REWRITE_SYSTEM_PROMPT]) assert.match(prompt, /情绪及自定义风格按规则自然单段或分行/);
  assert.match(writingStyleGuidance(snapshot, 'image'), /不为了凑两行机械拆句/);
  assert.doesNotMatch(writingStyleGuidance(snapshot, 'video'), /不为了凑两行机械拆句/);
});

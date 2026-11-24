import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { emptyAiForm, sameAiForm, needsAiRetest } from '../lib/ai-settings-state';
import { AiProfileResource, describeAiSelection, profileForm } from '../lib/ai-profile-client';
import { unverified, type PublicProfile } from '../lib/ai-config';
import { newPersonalDraft, serializePersonalDraft, personalSummary } from '../lib/personal/drafts';
import { filterPersonalSummaries, suggestedPersonalName } from '../lib/personal/draft-summary';
import { personalStyleChanges } from '../lib/personal/presentation';
import { builtinRuleSnapshot } from '../lib/personal/style-rules';
import { personalLocalStore } from '../lib/personal/store';

const profile: PublicProfile = {
  ...emptyAiForm(), id: 'profile-a', revision: 'revision-a', name: '我的配置', model: 'model-a',
  hasApiKey: true, maskedApiKey: '••••abcd', textTest: unverified(), imageTest: unverified(),
};

test('未保存判断区分有效修改、空密钥保留、连接变化和改回原值', () => {
  const original = profileForm(profile);
  assert.ok(sameAiForm(original, { ...original, name: ' 我的配置 ', clearApiKey: undefined }));
  assert.ok(!sameAiForm(original, { ...original, model: 'model-b' }));
  assert.ok(!sameAiForm(original, { ...original, apiKey: 'synthetic-test-key' }));
  assert.ok(!sameAiForm(original, { ...original, clearApiKey: true }));
  assert.ok(!needsAiRetest({ ...original, name: '改名称' }, profile));
  for (const patch of [{ model: 'model-b' }, { baseUrl: 'https://example.com/v1' }, { apiKey: 'synthetic' }]) {
    assert.ok(needsAiRetest({ ...original, ...patch }, profile));
  }
  assert.ok(!needsAiRetest({ ...original, timeoutSeconds: 30 }, profile));
  assert.ok(!needsAiRetest(original, profile));
  assert.equal(profile.maskedApiKey, '••••abcd');
});

test('AI 状态不将删除的选择回退为默认，冻结快照不随元数据刷新变化', () => {
  const state = { data: { profiles: [profile], defaultId: profile.id, account: 'test' }, loading: false, error: '' };
  const frozen = describeAiSelection(state, profile.id);
  state.data.profiles[0] = { ...profile, model: 'model-b' };
  assert.equal(frozen.model, 'model-a');
  assert.equal(describeAiSelection(state, profile.id).model, 'model-b');
  assert.match(describeAiSelection(state, 'deleted-id').issue, /删除或不可用/);
  assert.equal(describeAiSelection(state, 'deleted-id').id, 'deleted-id');
  assert.match(describeAiSelection({ ...state, error: 'failed' }, profile.id).issue, /读取失败/);
  assert.match(describeAiSelection(state, 'none').issue, /尚未选择/);
});

test('保存后刷新配置时，较早的读取响应不能覆盖新配置状态', async () => {
  const originalFetch = globalThis.fetch;
  const responses: Array<(response: Response) => void> = [];
  globalThis.fetch = async () => new Promise<Response>(resolve => responses.push(resolve));
  try {
    const resource = new AiProfileResource();
    const oldRead = resource.load();
    assert.equal(resource.load(), oldRead, '普通并发读取共用请求');
    const refreshed = resource.reload();
    assert.equal(responses.length, 2);
    responses[1](Response.json({ profiles: [{ ...profile, model: 'new-model' }], defaultId: profile.id, account: 'test' }));
    await refreshed;
    responses[0](Response.json({ profiles: [profile], defaultId: profile.id, account: 'test' }));
    await oldRead;
    assert.equal(resource.getSnapshot().data?.profiles[0].model, 'new-model');
    assert.equal(resource.getSnapshot().loading, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('草稿摘要只截断展示，支持名称和素材搜索，旧默认名称只提供建议', () => {
  const draft = newPersonalDraft();
  draft.nameSource = undefined;
  draft.input.experience = '公园散步。' + '观察树叶和光线。'.repeat(60);
  const before = structuredClone(draft.input);
  const stored = serializePersonalDraft(draft, 1);
  const summary = personalSummary(stored);
  assert.equal(summary.name, '未命名个人草稿');
  assert.equal(summary.suggestedName, '公园散步');
  assert.equal(summary.stage, '已填写内容');
  assert.ok(summary.excerpt!.length <= 120);
  assert.deepEqual(draft.input, before);
  assert.equal(filterPersonalSummaries([summary], '树叶').length, 1);
  assert.equal(filterPersonalSummaries([summary], '未命名').length, 1);
  assert.equal(filterPersonalSummaries([summary], '找不到').length, 0);
  assert.equal(suggestedPersonalName({ ...draft.input, topic: '手写主题' }), '手写主题');
});

test('读取草稿箱返回轻量摘要，打开时再读完整记录，复制和完成记录数量保持正确', async () => {
  globalThis.indexedDB = new IDBFactory();
  const one = newPersonalDraft(), two = newPersonalDraft();
  one.input.topic = '第一份'; two.input.experience = '第二份素材';
  await personalLocalStore.writeDraft(serializePersonalDraft(one, 0), null);
  await personalLocalStore.writeDraft(serializePersonalDraft(two, 0), null);
  const workspace = await personalLocalStore.readWorkspace();
  assert.equal(workspace.summaries.length, 2);
  assert.equal(workspace.drafts.length, 0);
  assert.ok(workspace.summaries.every(row => !('assets' in row) && !('thumbnail' in row)));
  assert.equal((await personalLocalStore.getDraft(two.id)).input.experience, '第二份素材');
});

test('风格差异指出方向与笔记各自原版本，普通素材编辑不扩大风格阻断', () => {
  const draft = newPersonalDraft();
  draft.input.ruleSnapshot = builtinRuleSnapshot('emotion'); draft.input.styles = ['emotion'];
  draft.promptInput = structuredClone(draft.input);
  draft.generatedInput = { input: structuredClone(draft.input), confirmedPrompt: '已确认安排', research: null, imageIds: [] };
  draft.input.experience = '仅修改素材';
  assert.deepEqual(personalStyleChanges(draft), { direction: null, result: null });
  draft.input.styles = ['travel']; draft.input.ruleSnapshot = builtinRuleSnapshot('travel');
  assert.match(personalStyleChanges(draft).direction!, /旅行攻略.*情绪表达.*更新创作方向/);
  assert.match(personalStyleChanges(draft).result!, /情绪表达.*原生成依据保留/);
  assert.equal(draft.generatedInput.input.styles[0], 'emotion');
});

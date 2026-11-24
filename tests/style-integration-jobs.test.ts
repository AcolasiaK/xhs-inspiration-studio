import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../lib/errors';
import { type Profile } from '../lib/ai-config';
import { emptyRuleContent, type RuleContent } from '../lib/personal/style-rules';
import { type StyleAnalysis, type StyleLearningRequest } from '../lib/personal/style-learning';
import { type StyleIntegrationContext, type StyleIntegrationProposal } from '../lib/personal/style-integration';
import { type StyleImageKey } from '../lib/personal/style-learning-job';
import { adoptStyleLearningJob, getStyleLearningJob, pauseStyleLearningJob, resumeStyleLearningJob, startStyleIntegrationJob, startStyleLearningJob, styleLearningJobRuntime } from '../lib/server/style-learning-jobs';
import { copyPersonalStyle, listPersonalStyles, restorePersonalStyle, savePersonalStyle } from '../lib/server/personal-style-store';
import { POST as integrate } from '../app/api/personal/styles/integrations/route';
import { POST as adopt } from '../app/api/personal/styles/learning-jobs/[id]/adopt/route';

const owner = 'local-owner', settings = { timeoutSeconds: 600 }, selection = [{ index: 0, rule: '用一个真实的小动作开启现场观察。' }];
const profile: Profile = { id: 'synthetic-profile', revision: 'revision-1', name: '合成配置', provider: 'custom', protocol: 'responses', baseUrl: 'https://example.com/v1', apiKey: 'synthetic-secret-never-persist', model: 'synthetic-model', timeoutSeconds: 150, maxOutputTokens: 8000, jsonMode: 'schema', textTest: { status: 'passed', at: null, message: 'fixture' }, imageTest: { status: 'passed', at: null, message: 'fixture' } };
const input = (suffix = '最后静静看了一会儿。', images = 0): StyleLearningRequest => ({ references: [{ id: 'primary', title: '', text: '清晨推开窗，看见雨后的树叶。轻轻落下的水珠让我想再站一会儿。' + suffix, images: Array.from({ length: images }, (_, i) => ({ id: `image-${i + 1}`, dataUrl: 'data:image/png;base64,AAAA', caption: '' })), url: '' }], preferences: '喜欢有观察感的表达。' });
const observations = (keys: StyleImageKey[]): StyleAnalysis['imageAnalyses'] => keys.map(key => ({ ...key, visibleText: '', visualDescription: '雨后的树叶与水珠', captionAnalysis: '没有可读文字，可结合正文分析画面关系。', role: '提供树叶的观察细节。', limitations: '' }));
const report = (items: StyleAnalysis['imageAnalyses'] = []): StyleAnalysis => ({ name: '日常观察', summary: '以观察写日常感受。', portrait: { temperament: '从细节形成节奏。', titles: { available: false, expression: '', language: '', appeal: '', relation: '' }, body: '以细节推进。', captions: '根据画面说明。', imageText: '从画面细节出发。', transfer: '换题材后仍保持观察视角。' }, traits: [{ scope: 'body', label: '动作切入', observation: '从当下动作进入观察。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '清晨推开窗', imageIds: [] }], rule: selection[0].rule }, { scope: 'overall', label: '长段抒情', observation: '一段连贯的观察。', mode: 'flexible', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '看见雨后的树叶', imageIds: [] }], rule: '需要时延长抒情段落。' }], differences: [], imageAnalyses: items, cautions: [] });
const content = (): RuleContent => ({ ...emptyRuleContent('合成风格'), sections: { overall: '', title: '', body: selection[0].rule, captions: '', avoid: '' } });
const proposal = (context: StyleIntegrationContext, conflict = false): StyleIntegrationProposal => ({ summary: '结合新旧参考重新整理观察的展开方式。', sections: { ...context.baseline.sections, body: '根据真实素材的观察节奏展开，收束保留余地。' }, changes: [{ scope: 'body', kind: 'merge', before: context.baseline.sections.body, after: '根据真实素材的观察节奏展开，收束保留余地。', reason: '统一新旧参考中的动作和细节，避免叠加重复指令。', sourceIds: context.sources.map(source => source.id) }], conflicts: conflict ? [{ id: 'body-direction', scope: 'body', question: '正文采用哪种节奏？', reason: '两类展开方式需主动取舍。', options: [{ id: 'keep', label: '保留原节奏', text: context.baseline.sections.body }, { id: 'new', label: '采用新节奏', text: '依据新素材使用更短的段落。' }] }] : [], cautions: [] });
const env = { ...process.env }; let directory = '', contexts: StyleIntegrationContext[] = [], imageCalls = 0, synthesisCalls = 0;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-integration-jobs-'));
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', PERSONAL_STYLES_DIR: directory };
  contexts = []; imageCalls = 0; synthesisCalls = 0;
  mock.method(styleLearningJobRuntime, 'selectProfile', async (owner: string) => ({ owner, profile: structuredClone(profile) }));
  mock.method(styleLearningJobRuntime, 'analyzeImages', async (_input: StyleLearningRequest, keys: StyleImageKey[]) => { imageCalls++; return observations(keys); });
  mock.method(styleLearningJobRuntime, 'synthesize', async (_input: StyleLearningRequest, items: StyleAnalysis['imageAnalyses']) => { synthesisCalls++; return report(items); });
  mock.method(styleLearningJobRuntime, 'integrate', async (context: StyleIntegrationContext) => { contexts.push(structuredClone(context)); return proposal(context); });
});
afterEach(async () => { await delay(10); mock.restoreAll(); process.env = env; await rm(directory, { recursive: true, force: true }); });
async function stopped(id: string) {
  for (let i = 0; i < 250; i++) { const { job } = await getStyleLearningJob(owner, id); if (job.status !== 'running') return job; await delay(2); }
  throw new Error('Synthetic job did not finish');
}
async function analyze(value = input()) { const id = randomUUID(); await startStyleLearningJob(owner, id, value, settings); assert.equal((await stopped(id)).status, 'completed'); return id; }
async function firstStyle(value = input()) { const id = await analyze(value); const adopted = await adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: content(), selection, resolutions: [] }); return { id, ...adopted }; }
const target = (style: { id: string; revision: number; draftVersionId: string }) => ({ styleId: style.id, revision: style.revision, versionId: style.draftVersionId });
const pathFor = (id: string) => join(directory, 'learning-jobs', createHash('sha256').update(owner).digest('hex'), id + '.json');
function request(path: string, body: unknown, headers: Record<string, string> = {}) { return new Request('http://localhost/api/personal/styles/' + path, { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }

test('首次采用创建未启用草稿，保存来源、所选/未采用写法，保存不调用 AI', async () => {
  const id = await analyze(input('第一篇。', 2)), beforeImages = imageCalls, beforeSynthesis = synthesisCalls, adoptionId = randomUUID();
  const saved = await adoptStyleLearningJob(owner, id, { adoptionId, content: content(), selection, resolutions: [] });
  assert.equal(saved.style.activeVersionId, null); assert.equal(saved.style.versions.length, 1);
  const memory = saved.style.versions[0].learningReview!;
  assert.equal(memory.adoptionId, adoptionId); assert.deepEqual(memory.sourceJobIds, [id]); assert.equal(memory.rounds[0].preferences, input().preferences);
  assert.equal(memory.rounds[0].selected[0].scope, 'body'); assert.equal(memory.rounds[0].selected[0].rule, selection[0].rule); assert.equal(memory.rounds[0].selected[0].evidence?.[0].quote, '清晨推开窗'); assert(memory.rounds[0].selected[0].evidence?.[0].sourceId.startsWith('ref-'));  assert.equal(memory.rounds[0].notAdopted[0].label, '长段抒情');
  assert.equal(imageCalls, beforeImages); assert.equal(synthesisCalls, beforeSynthesis); assert.equal(contexts.length, 0);
  assert(!JSON.stringify(saved).includes(profile.apiKey));
});

test('跨轮相同 primary 编号隔离，复用完整旧原文和观察；综合恰好一次 AI', async () => {
  const first = await firstStyle(input('第一篇完整原文。', 2)), next = await analyze(input('第二篇完整原文。', 2)), id = randomUUID();
  const oldImages = imageCalls, oldSynthesis = synthesisCalls;
  const running = await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings });
  assert.equal(running.totalSteps, 1); assert.equal(running.integration?.historySourceCount, 1); assert.equal((await stopped(id)).status, 'completed');
  assert.equal(contexts.length, 1); assert.equal(imageCalls, oldImages); assert.equal(synthesisCalls, oldSynthesis);
  const context = contexts[0]; assert.equal(context.sources.length, 2); assert.equal(new Set(context.sources.map(item => item.id)).size, 2);
  assert(context.sources.some(source => source.text.endsWith('第一篇完整原文。'))); assert(context.sources.some(source => source.text.endsWith('第二篇完整原文。')));
  assert.equal(context.sources[0].images.length, 2); assert.equal(context.sources[0].images[0].visualDescription, '雨后的树叶与水珠');
  assert.equal(context.current.references[0].id, 'primary'); assert(context.currentReferenceMap.primary.startsWith('ref-'));
  assert(!JSON.stringify(context).includes('base64')); assert.equal(context.history.length, 1);
  const done = (await getStyleLearningJob(owner, id)).job;
  const saved = await adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: { ...content(), sections: done.integration!.proposal!.sections }, resolutions: [] });
  assert.equal(saved.style.versions.length, 2); assert.equal(saved.style.activeVersionId, null); assert.equal(contexts.length, 1);
  assert.deepEqual(saved.style.versions[1].learningReview?.sourceJobIds, [first.id, next]); assert.equal(saved.style.versions[1].learningReview?.rounds.length, 2);
});

test('相同内容跨任务按 fingerprint 合并，不能伪装成多篇共性', async () => {
  const first = await firstStyle(input('重复样本。', 2)), duplicate = await analyze(input('重复样本。', 2)), id = randomUUID();
  await startStyleIntegrationJob(owner, { id, sourceJobId: duplicate, target: target(first.style), selection, settings }); await stopped(id);
  assert.equal(contexts[0].sources.length, 1); assert.deepEqual(contexts[0].sources[0].jobIds, [first.id, duplicate]);
});

test('旧来源缺失或内容被修改时拒绝综合，不静默删除历史、不发新 AI 调用', async () => {
  const first = await firstStyle(), next = await analyze(input('第二篇。'));
  await delay(10); const bytes = await readFile(pathFor(first.id), 'utf8'); await unlink(pathFor(first.id));
  await assert.rejects(startStyleIntegrationJob(owner, { id: randomUUID(), sourceJobId: next, target: target(first.style), selection, settings }), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  await writeFile(pathFor(first.id), bytes); const changed = JSON.parse(bytes); changed.input.references[0].text += '未参与原分析的篡改。'; await writeFile(pathFor(first.id), JSON.stringify(changed));
  await assert.rejects(startStyleIntegrationJob(owner, { id: randomUUID(), sourceJobId: next, target: target(first.style), selection, settings }), (e: unknown) => e instanceof AppError && e.code === 'STYLE_SOURCE_INVALID');
  assert.equal(contexts.length, 0); assert.equal((await listPersonalStyles(owner)).styles.find(s => s.id === first.style.id)!.versions.length, 1);
});

test('失败和暂停恢复复用冻结目标和来源，恢复不重读旧图或覆盖并发草稿', async () => {
  const first = await firstStyle(input('旧参考。', 2)), next = await analyze(input('新参考。', 2)), id = randomUUID(); let attempts = 0;
  mock.method(styleLearningJobRuntime, 'integrate', async (context: StyleIntegrationContext) => { contexts.push(structuredClone(context)); if (attempts++ === 0) throw new AppError('TIMEOUT', 'fixture', 504); return proposal(context); });
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings }); assert.equal((await stopped(id)).status, 'failed');
  const updated = await savePersonalStyle(owner, first.style.id, first.style.revision, { ...content(), name: '另一个页面的编辑' });
  await delay(10); await unlink(pathFor(first.id));
  await resumeStyleLearningJob(owner, id, { timeoutSeconds: 1200, maxOutputTokens: 32768 }); assert.equal((await stopped(id)).status, 'completed');
  assert.deepEqual(contexts[1], contexts[0]); assert.equal(imageCalls, 2); assert.equal(synthesisCalls, 2);
  await assert.rejects(adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: content(), resolutions: [] }), (e: unknown) => e instanceof AppError && e.code === 'STYLE_CONFLICT');
  assert.equal((await listPersonalStyles(owner)).styles.find(s => s.id === first.style.id)!.revision, updated.revision);
});

test('综合暂停迟到结果不能保存，确认恢复仅再运行综合一步', async () => {
  const first = await firstStyle(), next = await analyze(input('新参考。')), id = randomUUID(); let release!: (value: StyleIntegrationProposal) => void, frozen: StyleIntegrationContext | undefined, calls = 0;
  mock.method(styleLearningJobRuntime, 'integrate', async (context: StyleIntegrationContext) => { frozen = context; if (calls++ === 0) return new Promise<StyleIntegrationProposal>(resolve => { release = resolve; }); return proposal(context); });
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings }); await pauseStyleLearningJob(owner, id);
  await resumeStyleLearningJob(owner, id, settings); assert.equal((await stopped(id)).status, 'completed'); release({ ...proposal(frozen!), summary: '过期回包' }); await delay(10);
  assert.notEqual((await getStyleLearningJob(owner, id)).job.integration?.proposal?.summary, '过期回包'); assert.equal(calls, 2);
});

test('未解决或伪造冲突不能保存，明确选择后保存决定且不自动启用', async () => {
  const first = await firstStyle(), next = await analyze(input('新参考。')), id = randomUUID();
  mock.method(styleLearningJobRuntime, 'integrate', async (context: StyleIntegrationContext) => proposal(context, true));
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings }); await stopped(id);
  for (const resolutions of [[], [{ conflictId: 'invented', optionId: 'new' }], [{ conflictId: 'body-direction', optionId: 'invented' }]]) {
    await assert.rejects(adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: content(), resolutions }), (e: unknown) => e instanceof AppError && e.code === 'STYLE_CONFLICT_UNRESOLVED');
  }
  const saved = await adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: { ...content(), sections: { ...content().sections, body: '依据新素材使用更短的段落。用户进一步修改。' } }, resolutions: [{ conflictId: 'body-direction', optionId: 'new' }] });
  assert.equal(saved.style.activeVersionId, null); assert.equal(saved.style.versions.at(-1)?.learningReview?.rounds.at(-1)?.conflictChoices[0].choice, '采用新节奏');
});

test('采用幂等receipt先于revision检查，重复与丢包不造新版本，内容变化409', async () => {
  const first = await firstStyle(), next = await analyze(input('新参考。')), id = randomUUID();
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings }); await stopped(id);
  const body = { adoptionId: randomUUID(), content: content(), resolutions: [] };
  const saved = await adoptStyleLearningJob(owner, id, body), repeat = await adoptStyleLearningJob(owner, id, body);
  assert.equal(repeat.versionId, saved.versionId); assert.equal(repeat.style.versions.length, 2);
  const anotherId = await adoptStyleLearningJob(owner, id, { ...body, adoptionId: randomUUID() }); assert.equal(anotherId.versionId, saved.versionId);
  await assert.rejects(adoptStyleLearningJob(owner, id, { ...body, content: { ...content(), name: '修改内容' } }), (e: unknown) => e instanceof AppError && e.code === 'STYLE_ADOPTION_CONFLICT');
});

test('manual save/copy/restore保留学习来源，复制不劫持原采用receipt；旧记录可读', async () => {
  const first = await firstStyle(), initialMemory = first.style.versions[0].learningReview;
  const edited = await savePersonalStyle(owner, first.style.id, first.style.revision, { ...content(), name: '手工编辑' }); assert.deepEqual(edited.versions[1].learningReview, initialMemory);
  const copied = await copyPersonalStyle(owner, first.style.id, edited.draftVersionId); assert.deepEqual(copied.versions[0].learningReview, initialMemory); assert.equal(copied.activeVersionId, null);
  const restored = await restorePersonalStyle(owner, first.style.id, edited.revision, first.versionId); assert.deepEqual(restored.versions.at(-1)?.learningReview, initialMemory);
  const receipt = await adoptStyleLearningJob(owner, first.id, { adoptionId: initialMemory!.adoptionId, content: content(), selection, resolutions: [] }); assert.equal(receipt.style.id, first.style.id); assert.equal(receipt.versionId, first.versionId);
  const original = (await listPersonalStyles(owner)).styles.find(s => s.id === 'daily')!; assert.equal(original.versions[0].learningReview, undefined);
});

test('新路由本机同源/账号隔离，拒绝把integration job当新笔记源或越界选择', async () => {
  const first = await firstStyle(), next = await analyze(input('新参考。')), id = randomUUID(), body = { id, sourceJobId: next, target: target(first.style), selection, settings };
  assert.equal((await integrate(request('integrations', body, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await integrate(request('integrations', { ...body, selection: [{ index: 50, rule: '无效选择' }] }))).status, 400);
  await assert.rejects(startStyleIntegrationJob('someone-else', body), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  assert.equal((await integrate(request('integrations', body))).status, 202); await stopped(id);
  await assert.rejects(startStyleIntegrationJob(owner, { ...body, id: randomUUID(), sourceJobId: id }), (e: unknown) => e instanceof AppError && e.code === 'STYLE_SOURCE_INCOMPLETE');
  const response = await adopt(request(`learning-jobs/${id}/adopt`, { adoptionId: randomUUID(), content: content(), resolutions: [] }), { params: Promise.resolve({ id }) }); assert.equal(response.status, 200);
  process.env.APP_MODE = 'cloud'; assert.equal((await integrate(request('integrations', body))).status, 400);
});


test('同图重复读取的已核验 OCR 修正保留为观察变体，不增加来源或图数', async () => {
  let round = 0;
  mock.method(styleLearningJobRuntime, 'analyzeImages', async (_input: StyleLearningRequest, keys: StyleImageKey[]) => observations(keys).map(image => ({ ...image, visibleText: ++round === 1 ? '初次识别文字' : '后来校准的文字' })));
  const first = await firstStyle(input('重复图文。', 1));
  const reread = input('重复图文。', 1); reread.references[0].images[0].id = 'fresh-image-id';
  const next = await analyze(reread), id = randomUUID();
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection, settings }); await stopped(id);
  const sources = contexts[0].sources; assert.equal(sources.length, 1); assert.equal(sources[0].images.length, 1);
  assert.equal(sources[0].images[0].visibleText, '初次识别文字'); assert.equal(sources[0].observationVariants?.length, 1); assert.equal(sources[0].observationVariants?.[0].visibleText, '后来校准的文字');
  assert.equal(contexts[0].current.analysis.imageAnalyses[0].imageId, 'fresh-image-id');
});


test('保留现有规则的最终冲突决定覆盖先前勾选，只记为本轮未采用', async () => {
  const first = await firstStyle(), next = await analyze(input('新参考。')), id = randomUUID();
  const chosen = [{ index: 0, rule: '本轮先勾选、后来放弃的正文写法。' }, { index: 1, rule: '另一个栏目仍然认可的写法。' }];
  mock.method(styleLearningJobRuntime, 'integrate', async (context: StyleIntegrationContext) => {
    contexts.push(structuredClone(context));
    const plan = proposal(context, true); plan.conflicts[0].options[0] = { id: 'keep_previous', label: '保留现有规则', text: context.baseline.sections.body }; return plan;
  });
  await startStyleIntegrationJob(owner, { id, sourceJobId: next, target: target(first.style), selection: chosen, settings }); await stopped(id);
  const saved = await adoptStyleLearningJob(owner, id, { adoptionId: randomUUID(), content: content(), resolutions: [{ conflictId: 'body-direction', optionId: 'keep_previous' }] });
  const review = saved.style.versions.at(-1)!.learningReview!, latest = review.rounds.at(-1)!;
  assert.equal(latest.selected.length, 1); assert.equal(latest.selected[0].scope, 'overall'); assert.equal(latest.selected[0].rule, chosen[1].rule);
  assert.deepEqual(latest.notAdopted, [{ scope: 'body', label: '动作切入', rule: chosen[0].rule }]);
  assert.equal(latest.conflictChoices[0].choice, '保留现有规则'); assert.equal(latest.conflictChoices[0].text, content().sections.body);
  assert.equal(review.rounds[0].selected[0].scope, 'body'); // Earlier approved rules remain approved.
  const third = await analyze(input('再次考虑正文的新参考。')), thirdId = randomUUID();
  await startStyleIntegrationJob(owner, { id: thirdId, sourceJobId: third, target: target(saved.style), selection, settings }); await stopped(thirdId);
  assert.equal(contexts.at(-1)!.history.at(-1)!.selected.some(trait => trait.scope === 'body'), false);
  assert.equal(contexts.at(-1)!.selection[0].index, 0); // The user can select that scope again later.
});

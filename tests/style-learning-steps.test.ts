import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import OpenAI from 'openai';
import type { Profile } from '../lib/ai-config';
import type { StyleAnalysis, StyleLearningRequest } from '../lib/personal/style-learning';
import { styleImageBatches, type StyleJobSettings } from '../lib/personal/style-learning-job';
import { analyzeStyleImageBatch, synthesizeWritingStyle } from '../lib/server/style-learning-steps';
import { aiTransport } from '../lib/server/ai/provider';
import { AppError } from '../lib/errors';
import { OutputBudgetError } from '../lib/server/ai/output-budget';

const profile: Profile = {
  id: 'saved-profile', revision: 'rev-one', name: 'Synthetic fixture', provider: 'openai', protocol: 'responses',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-fixture-key', model: 'synthetic-vision-model', timeoutSeconds: 150, maxOutputTokens: 8000, jsonMode: 'schema',
  textTest: { status: 'passed', at: null, message: 'Synthetic fixture' }, imageTest: { status: 'passed', at: null, message: 'Synthetic fixture' },
};
const source = { owner: 'synthetic-owner', profile };
const settings: StyleJobSettings = { timeoutSeconds: 600, maxOutputTokens: 32768 };
const signal = () => new AbortController().signal;
const title = '把安静留给清晨';
const text = '清晨推开窗，风吹起桌上的纸。我没有急着出门，只听了一会儿楼下的脚步声。杯里的茶还热着。';
type Observation = StyleAnalysis['imageAnalyses'][number];
const observation = (referenceId: string, imageId: string): Observation => ({ referenceId, imageId, visibleText: '', visualDescription: '米色桌面上的杯子', captionAnalysis: '没有图中文字，可以用观察补充正文。', role: '可见日常静物，具体图序关系还需结合其他图片。', limitations: '此批不能确认尚未看到的图片内容。' });
const synthesis: Omit<StyleAnalysis, 'imageAnalyses'> = {
  name: '细节里的安静', summary: '用日常动作和细节承接感受。',
  portrait: { temperament: '用克制的观察传递感受。', titles: { available: true, expression: '借具体时段表达态度。', language: '短句和常见词。', appeal: '来自熟悉感。', relation: '概括正文的感受。' }, body: '从动作进入场景。', captions: '以图中细节呼应正文。', imageText: '图片提供场景，正文补充感受。', transfer: '保留具体观察，随新的真实素材改变展开方式。' },
  traits: [
    { scope: 'title', label: '具体意象', observation: '从日常时段进入情绪。', mode: 'flexible', support: 'candidate', evidence: [{ referenceId: 'first', quote: title, imageIds: [] }], rule: '从新素材里选一个具体时间或场景，联系当时真实感受形成标题。' },
    { scope: 'captions', label: '画面细节', observation: '配文可以围绕可见物件展开。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'first', quote: '米色桌面上的杯子', imageIds: ['shared'] }], rule: '每张配文从画面里一个具体细节展开，避免重复正文结论。' },
  ], differences: [], cautions: ['样本只作候选风格依据。'],
};
type SentBody = { max_output_tokens: number; input: { role: string; content: string | { type: string; text?: string; image_url?: string }[] }[]; text: { format: { schema: { properties: Record<string, unknown> } } } };
function answer(value: unknown) { return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }); }
async function inputWithImages(): Promise<StyleLearningRequest> {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f4e9d5' } }).png().toBuffer();
  const image = { id: 'shared', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, caption: '' };
  return { preferences: '关注图上配文和标题。', references: [
    { id: 'first', title, text, images: [image, { ...image, id: 'second' }], url: '' },
    { id: 'another', title: '', text: '午后走过街角，忽然听到久违的风铃声，于是慢慢停下来望了一会儿。', images: [{ ...image }], url: '' },
  ] };
}
afterEach(() => mock.restoreAll());

test('每批仅发送对应原图，保留原参考图序；跨笔记重复 imageId 仍正确对应且输出乱序可恢复', async () => {
  const input = await inputWithImages();
  // This unselected image is deliberately invalid: cleaning it would fail this batch.
  input.references[0].images[1].dataUrl = 'data:image/png;base64,aGVsbG8=';
  const keys = [{ referenceId: 'first', imageId: 'shared' }, { referenceId: 'another', imageId: 'shared' }];
  let body: SentBody | undefined;
  const timeoutSpy = mock.method(OpenAI.prototype, 'fetchWithTimeout');
  const transport = mock.method(aiTransport, 'fetch', async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return answer({ imageAnalyses: keys.toReversed().map(key => observation(key.referenceId, key.imageId)) });
  });
  const before = structuredClone(profile);
  const result = await analyzeStyleImageBatch(input, keys, source, signal(), settings);
  assert.deepEqual(result.map(item => ({ referenceId: item.referenceId, imageId: item.imageId })), keys);
  assert.equal(transport.mock.callCount(), 1); assert.deepEqual(profile, before);
  assert.equal(body!.max_output_tokens, 32768);
  assert.equal(timeoutSpy.mock.calls[0].arguments[2], 600_000);
  const content = body!.input.find(item => item.role === 'user')!.content;
  assert(Array.isArray(content)); assert.equal(content.filter(item => item.type === 'input_image').length, 2);
  assert(content.filter(item => item.type === 'input_image').every(item => item.image_url?.startsWith('data:image/jpeg;base64,')));
  const metadata = JSON.parse(content[0].text!);
  assert.equal(metadata.references[0].title, title); assert.equal(metadata.references[0].text, text);
  assert.deepEqual(metadata.references[0].images.map((image: { position: number; includedInThisBatch: boolean }) => [image.position, image.includedInThisBatch]), [[1, true], [2, false]]);
  assert.doesNotMatch(content[0].text!, /base64/);
});

test('缺图、重复图、错误参考编号均不形成有效 checkpoint，未请求图编号也不能进入模型', async () => {
  const input = await inputWithImages(), keys = styleImageBatches(input)[0];
  for (const observations of [
    [observation('first', 'shared')],
    [observation('first', 'shared'), observation('first', 'shared')],
    [observation('first', 'shared'), observation('another', 'second')],
  ]) {
    const transport = mock.method(aiTransport, 'fetch', async () => answer({ imageAnalyses: observations }));
    await assert.rejects(analyzeStyleImageBatch(input, keys, source, signal(), settings), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT');
    assert.equal(transport.mock.callCount(), 1); mock.restoreAll();
  }
  const transport = mock.method(aiTransport, 'fetch', async () => answer({ imageAnalyses: [] }));
  await assert.rejects(analyzeStyleImageBatch(input, [{ referenceId: 'missing', imageId: 'shared' }], source, signal(), settings), (error: unknown) => error instanceof AppError && error.code === 'INVALID_FORM');
  assert.equal(transport.mock.callCount(), 0);
});

test('最终只发送文字与全部已验证观察，不重复发图；标题规则、逐图证据与图片顺序完整保留', async () => {
  const input = await inputWithImages(), observations = input.references.flatMap(ref => ref.images.map(image => observation(ref.id, image.id)));
  const before = structuredClone(observations); let body: SentBody | undefined;
  mock.method(aiTransport, 'fetch', async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return answer(synthesis); });
  const result = await synthesizeWritingStyle(input, observations.toReversed(), source, signal(), settings);
  assert.deepEqual(result.imageAnalyses, observations); assert.deepEqual(observations, before);
  assert.deepEqual(result.portrait.titles, synthesis.portrait.titles); assert.equal(result.traits[1].scope, 'captions');
  assert.equal(typeof body!.input.find(item => item.role === 'user')!.content, 'string');
  assert.doesNotMatch(JSON.stringify(body), /data:image|base64|input_image/);
  const sent = JSON.parse(body!.input.find(item => item.role === 'user')!.content as string);
  assert.deepEqual(sent.imageObservations, observations);
  assert(!Object.hasOwn(body!.text.format.schema.properties, 'imageAnalyses'));
});

test('纯文字参考直接归纳；缺少标题不编造标题，候选不自动升级为共性', async () => {
  const input: StyleLearningRequest = { preferences: '', references: [{ id: 'first', title: '', text, images: [], url: '' }] };
  const report = structuredClone(synthesis);
  report.portrait.titles = { available: false, expression: '', language: '', appeal: '', relation: '' };
  report.traits = [{ scope: 'body', label: '具体动作', observation: '动作引入场景。', mode: 'core', support: 'recurring', evidence: [{ referenceId: 'first', quote: '清晨推开窗', imageIds: [] }], rule: '从当下一个具体动作进入叙述。' }];
  const transport = mock.method(aiTransport, 'fetch', async () => answer(report));
  const result = await synthesizeWritingStyle(input, [], source, signal(), { timeoutSeconds: 600 });
  assert.deepEqual(styleImageBatches(input), []); assert.deepEqual(result.imageAnalyses, []);
  assert.equal(result.traits[0].support, 'candidate'); assert.equal(transport.mock.callCount(), 1);
});

test('最终原文校验失败不会修改图片 checkpoint，观察不全则调用前拒绝', async () => {
  const input = await inputWithImages(), observations = input.references.flatMap(ref => ref.images.map(image => observation(ref.id, image.id)));
  const before = structuredClone(observations), report = structuredClone(synthesis);
  report.traits[0].evidence[0].quote = '原文不存在的标题';
  const transport = mock.method(aiTransport, 'fetch', async () => answer(report));
  await assert.rejects(synthesizeWritingStyle(input, observations, source, signal(), settings), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT');
  assert.deepEqual(observations, before); assert.equal(transport.mock.callCount(), 1);
  await assert.rejects(synthesizeWritingStyle(input, observations.slice(1), source, signal(), settings), (error: unknown) => error instanceof AppError && error.code === 'INVALID_RESULT');
  assert.equal(transport.mock.callCount(), 1);
});

test('截断和 SDK 超时向任务层传递，不自动重试或接纳部分观察', async () => {
  const input = await inputWithImages(), keys = styleImageBatches(input)[0];
  const transport = mock.method(aiTransport, 'fetch', async () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"imageAnalyses":[' }] }] }));
  await assert.rejects(analyzeStyleImageBatch(input, keys, source, signal(), settings), (error: unknown) => error instanceof OutputBudgetError && error.limit === 32768);
  assert.equal(transport.mock.callCount(), 1); mock.restoreAll();
  // SDK's fetch layer recognizes AbortError as its own timeout when its signal has not been cancelled externally.
  const timeout = mock.method(aiTransport, 'fetch', async () => { throw new DOMException('Synthetic upstream timeout', 'AbortError'); });
  await assert.rejects(analyzeStyleImageBatch(input, keys, source, signal(), settings), (error: unknown) => error instanceof AppError && error.code === 'TIMEOUT');
  assert.equal(timeout.mock.callCount(), 1);
});

test('取消后迟到的图片结果和最终归纳均不能被接纳', async () => {
  const input = await inputWithImages(), keys = styleImageBatches(input)[0];
  const controller = new AbortController();
  const transport = mock.method(aiTransport, 'fetch', async () => { controller.abort(); return answer({ imageAnalyses: keys.map(key => observation(key.referenceId, key.imageId)) }); });
  await assert.rejects(analyzeStyleImageBatch(input, keys, source, controller.signal, settings));
  assert.equal(transport.mock.callCount(), 1); mock.restoreAll();
  const all = input.references.flatMap(ref => ref.images.map(image => observation(ref.id, image.id))), finalController = new AbortController();
  mock.method(aiTransport, 'fetch', async () => { finalController.abort(); return answer(synthesis); });
  await assert.rejects(synthesizeWritingStyle(input, all, source, finalController.signal, settings));
});

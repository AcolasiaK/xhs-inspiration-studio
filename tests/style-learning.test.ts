import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compileLearnedRules, defaultLearnedSelection, normalizeXhsReferenceLink, styleLearningRequestSchema, validateStyleAnalysis, type StyleAnalysis, type StyleReferenceImage, type StyleReference } from '../lib/personal/style-learning';
import { builtinRuleSnapshot } from '../lib/personal/style-rules';
import { readStyleReference } from '../lib/server/style-reference';
import { POST as analyze } from '../app/api/personal/styles/analyze/route';
import { POST as save } from '../app/api/personal/styles/route';
import { listPersonalStyles } from '../lib/server/personal-style-store';
import { aiTransport } from '../lib/server/ai/provider';
import { selectProfile } from '../lib/server/ai/selection';
import { recordProbe } from '../lib/server/ai/store';
import { previewStyleFragments } from '../lib/server/style-learning-recovery';
import { analysisForLegacyPage, legacyStyleAnalysisSchema, parseStyleLearningInput } from '../lib/server/style-learning-compat';

const reference = '合成参考：清晨推开窗，风吹起桌上的纸。我没有急着出门，只听了一会儿楼下的脚步声。最后把窗关上，杯里的茶还热着。';
const report: StyleAnalysis = { name: '安静的日常', summary: '从日常动作切入，用声音和细节传递感受。', portrait: { temperament: '让日常细节承接感受，以观察代替判断。', titles: { available: false, expression: '', language: '', appeal: '', relation: '' }, body: '从动作开始，以感官细节推进。', captions: '未提供图片，配文风格依据不足。', imageText: '未提供图片，图文关系待补充。', transfer: '保持观察视角，依据新素材选择合适的展开顺序。' }, differences: [], traits: [
  { scope: 'body', label: '动作开头', observation: '用开窗的动作进入当下场景。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '清晨推开窗', imageIds: [] }], rule: '正文从一个具体动作切入，再展开现场观察。' },
  { scope: 'overall', label: '含蓄感受', observation: '以听到的声音代替感受标签。', mode: 'flexible', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '楼下的脚步声', imageIds: [] }], rule: '借观察和感官细节表现感受，减少抽象情绪标签。' },
], imageAnalyses: [], cautions: ['单篇只提供写法参考，不证明用户固定偏好。'] };
const env = { ...process.env }; let directory = '', clock = Date.now();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xhs-learning-test-'));
  process.env = { ...env, APP_MODE: 'local', APP_LOCAL_ONLY: '1', AI_CONFIG_DIR: join(directory, 'ai'), PERSONAL_STYLES_DIR: join(directory, 'styles'), AI_CONFIG_SECRET: '', OPENAI_API_KEY: 'synthetic-style-key', OPENAI_MODEL: 'synthetic-style-model', OPENAI_BASE_URL: 'https://api.openai.com/v1' };
  delete process.env.VERCEL; clock += 60001; mock.method(Date, 'now', () => clock);
});
afterEach(async () => { mock.restoreAll(); process.env = env; await rm(directory, { recursive: true, force: true }); });
const request = (body: unknown, signal?: AbortSignal) => new Request('http://localhost/api/personal/styles/analyze', { method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
const ref = (text = reference, images: StyleReferenceImage[] = [], title = '', id = 'primary'): StyleReference => ({ id, title, text, images, url: '' });
const input = (text = reference, images: StyleReferenceImage[] = []) => ({ references: [ref(text, images)] });
const answer = (value = report) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const imageReport: StyleAnalysis = { ...report, traits: [{ scope: 'captions', label: '图文呼应', observation: '先从画面里的物件展开一句短配文。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '米色背景上的深色方块', imageIds: ['image-one'] }], rule: '逐图配文围绕该图可见的一个细节展开，不重复全文结论。' }], imageAnalyses: [{ referenceId: 'primary', imageId: 'image-one', visibleText: '', visualDescription: '米色背景上的深色方块', captionAnalysis: '图上没有文字，可结合正文围绕形状写一句观察。', role: '图组中的第一张图提供视觉起点。', limitations: '合成图片没有可读文字。' }] };
async function fixtureImage(): Promise<StyleReferenceImage> {
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f4e9d5' } }).png().toBuffer();
  return { id: 'image-one', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, caption: '' };
}

test('转换仅采用勾选项，保留原有规则、配文和示例；新风格没有原作者经历', () => {
  const base = builtinRuleSnapshot('emotion').content, before = structuredClone(base);
  const result = compileLearnedRules(report, [0, 0], base);
  assert.deepEqual(base, before); assert.equal(result.sections.captions, base.sections.captions);
  assert.deepEqual(result.examples, base.examples); assert.equal(result.sections.overall, base.sections.overall);
  assert.match(result.sections.body, /具体动作切入/); assert.equal(result.sections.body.split(report.traits[0].rule).length, 2);
  const fresh = compileLearnedRules(report, [1]); assert.equal(fresh.name, report.name); assert.equal(fresh.sections.body, ''); assert.deepEqual(fresh.examples, []);
  assert.doesNotMatch(JSON.stringify(fresh), /楼下|关窗|茶还热/);
  assert.throws(() => compileLearnedRules(report, []));
  assert.throws(() => compileLearnedRules(report, [0], { ...base, sections: { ...base.sections, body: '文'.repeat(6000) } }));
});

test('原文依据必须确实存在；可执行规则不得大段照搬原文', () => {
  assert.deepEqual(validateStyleAnalysis(report, [ref()]), report);
  assert.throws(() => validateStyleAnalysis({ ...report, traits: [{ ...report.traits[0], evidence: [{ referenceId: 'primary', quote: '不存在的雪山和海边', imageIds: [] }] }] }, [ref()]));
  assert.throws(() => validateStyleAnalysis({ ...report, traits: [{ ...report.traits[0], rule: reference }] }, [ref()]));
});

test('图片分析逐张对应，图文规则进入配文栏目而不覆盖正文；没有图片不编造图文规则', async () => {
  const images = [await fixtureImage()];
  assert.deepEqual(validateStyleAnalysis(imageReport, [ref('', images)]), imageReport);
  const base = builtinRuleSnapshot('emotion').content;
  const rules = compileLearnedRules(imageReport, [0], base);
  assert.equal(rules.sections.body, base.sections.body);
  assert(rules.sections.captions.startsWith(base.sections.captions));
  assert.match(rules.sections.captions, /该图可见的一个细节/);
  assert.throws(() => validateStyleAnalysis(imageReport, [ref()]));
  assert.throws(() => validateStyleAnalysis({ ...imageReport, imageAnalyses: [] }, [ref(reference, images)]));
  assert.throws(() => validateStyleAnalysis({ ...imageReport, imageAnalyses: [...imageReport.imageAnalyses, ...imageReport.imageAnalyses] }, [ref(reference, images)]));
  assert.throws(() => validateStyleAnalysis({ ...imageReport, traits: [{ ...imageReport.traits[0], evidence: [{ ...imageReport.traits[0].evidence[0], imageIds: ['missing'] }] }] }, [ref(reference, images)]));
  assert.throws(() => validateStyleAnalysis({ ...imageReport, traits: [{ ...imageReport.traits[0], evidence: [{ ...imageReport.traits[0].evidence[0], imageIds: [] }] }] }, [ref(reference, images)]));
  const quote = '这是一段很长很长的图上文字必须提炼写法而不能把原句直接照搬到风格规则中去';
  assert.throws(() => validateStyleAnalysis({ ...imageReport, imageAnalyses: [{ ...imageReport.imageAnalyses[0], visibleText: quote }], traits: [{ ...imageReport.traits[0], rule: quote }] }, [ref(reference, images)]));
});

test('仅图片也可分析；远程图片地址、重复编号及伪装图片不能进入模型', async () => {
  const image = await fixtureImage();
  assert(styleLearningRequestSchema.safeParse(input('', [image])).success);
  assert(!styleLearningRequestSchema.safeParse(input('')).success);
  assert(!styleLearningRequestSchema.safeParse(input(reference, [image, image])).success);
  assert(!styleLearningRequestSchema.safeParse(input(reference, [{ ...image, dataUrl: 'http://127.0.0.1/private' }])).success);
  const transport = mock.method(aiTransport, 'fetch', async () => answer());
  const response = await analyze(request(input('', [{ ...image, dataUrl: 'data:image/png;base64,aGVsbG8=' }])));
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_IMAGE');
  assert.equal(transport.mock.callCount(), 0);
});

test('图片原始字节以多模态输入发送，图文结果通过校验并保留逐图对应', async () => {
  const image = await fixtureImage(); let sent: { input: { role: string; content: string | { type: string; text?: string; image_url?: string }[] }[] } | undefined;
  const transport = mock.method(aiTransport, 'fetch', async (_: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return answer(imageReport); });
  const unverified = await analyze(request(input('', [image])));
  assert.equal(unverified.status, 400); assert.equal((await unverified.json()).error.code, 'VISION_UNVERIFIED');
  assert.equal(transport.mock.callCount(), 0);
  const selected = await selectProfile('local-owner');
  await recordProbe('local-owner', selected.profile!, 'image', { status: 'passed', at: null, message: 'Synthetic capability fixture' });
  const response = await analyze(request(input('', [image])));
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.deepEqual(body.analysis, imageReport);
  const content = sent!.input.find(i => i.role === 'user')!.content;
  assert(Array.isArray(content)); assert.equal(content.filter(p => p.type === 'input_image').length, 1);
  assert.match(content.find(p => p.type === 'input_image')!.image_url!, /^data:image\/jpeg;base64,/);
  assert.match(content[0].text!, /image-one/); assert.doesNotMatch(content[0].text!, /base64/);
  assert.equal((await listPersonalStyles('local-owner')).trials.length, 0);
});

test('图集按页读取去掉轮播重复项，部分图片失败保留成功图和明确提示', async () => {
  const image = await fixtureImage(), calls: string[][] = [];
  const id = '0123456789abcdef01234567'; let selected = 0;
  const result = await readStyleReference('https://xhslink.cn/o/test', new AbortController().signal, async args => {
    calls.push(args);
    if (args[0] === 'open') return { targetId: 'own-image-tab' };
    if (args[0] === 'evaluate' && args.at(-1)!.startsWith('async')) return { result: ++selected === 1 };
    if (args[0] === 'evaluate') return { result: { host: 'www.xiaohongshu.com', id, blocked: false, title: '合成标题', body: reference, imageIndexes: [0, 1, 0] } };
    if (args[0] === 'screenshot') return { path: '/synthetic/captured.png' };
    return {};
  }, async () => {}, async () => image.dataUrl);
  assert.equal(result.imageCount, 2); assert.equal(result.images.length, 1);
  assert.equal(result.images[0].id, 'reference-1'); assert.match(result.warnings.join(' '), /第 2 张图片/);
  assert.equal(calls.filter(c => c[0] === 'screenshot').length, 1);
  assert(calls.find(c => c[0] === 'screenshot')!.includes('#noteContainer .note-slider .swiper-slide-active:not(.swiper-slide-duplicate)'));
  assert.deepEqual(calls.at(-1), ['close', 'own-image-tab']);
});

test('仅图笔记保留图集，取消图集读取不继续翻页或返回迟到图片', async () => {
  const image = await fixtureImage(), id = '0123456789abcdef01234567';
  for (const cancel of [false, true]) {
    const calls: string[][] = [], controller = new AbortController();
    const pending = readStyleReference('https://xhslink.cn/o/test', controller.signal, async args => {
      calls.push(args);
      if (args[0] === 'open') return { targetId: 'own-image-tab' };
      if (args[0] === 'evaluate' && args.at(-1)!.startsWith('async')) return { result: true };
      if (args[0] === 'evaluate') return { result: { host: 'www.xiaohongshu.com', id, blocked: false, title: '', body: '', imageIndexes: [0, 1] } };
      if (args[0] === 'screenshot') { if (cancel) controller.abort(); return { path: '/synthetic/image.png' }; }
      return {};
    }, async () => {}, async () => image.dataUrl);
    if (cancel) { await assert.rejects(pending); assert.equal(calls.filter(c => c[0] === 'screenshot').length, 1); }
    else { const result = await pending; assert.equal(result.images.length, 2); assert.equal(result.text, ''); }
    assert.deepEqual(calls.at(-1), ['close', 'own-image-tab']);
  }
});

test('只接受真实笔记路径或分享短链，拒绝私有地址、相似域名及多个链接', () => {
  const id = '0123456789abcdef01234567';
  assert.equal(normalizeXhsReferenceLink(`分享正文 http://xhslink.com/a/Ab123`), 'https://xhslink.com/a/Ab123');
  assert.equal(normalizeXhsReferenceLink(`https://xiaohongshu.com/discovery/item/${id}?xsec_token=example`), `https://www.xiaohongshu.com/discovery/item/${id}?xsec_token=example`);
  for (const bad of ['http://127.0.0.1/secret', 'https://xiaohongshu.com.evil.test/explore/'+id, 'https://www.xiaohongshu.com@evil.test/explore/'+id, 'https://www.xiaohongshu.com/search_result', 'https://xhslink.com/a/one https://xhslink.com/a/two', 'https://xhslink.com:444/a/test']) assert.throws(() => normalizeXhsReferenceLink(bad));
});

test('整段小红书分享文字兼容 cn/o 短链和复制时的转义符', () => {
  const url = 'https://xhslink.cn/o/5tQdzkv8zPm';
  for (const link of [url, String.raw`https\://xhslink.cn/o/5tQdzkv8zPm`, String.raw`https:\/\/xhslink.cn/o/5tQdzkv8zPm`]) {
    assert.equal(normalizeXhsReferenceLink(`“旅行是生命自我重塑的过程” 对我而言， 旅行从来不... ${link} 拷走口令，来【小红书】瞅瞅~`), url);
  }
  for (const bad of ['https://xhslink.cn.evil.test/o/abc', 'https://xhslink.cn@evil.test/o/abc', 'https://xhslink.cn/profile/abc', 'https://xhslink.cn:444/o/abc', `https://xhslink.cn/o/one https://xhslink.com/a/two`, String.raw`https\://xhslink.cn/o/one https\://xhslink.cn/o/two`]) {
    assert.throws(() => normalizeXhsReferenceLink(bad));
  }
});

test('cn 分享短链原样打开并读取跳转后的笔记正文', async () => {
  const calls: string[][] = [], id = '0123456789abcdef01234567';
  const result = await readStyleReference(String.raw`分享标题 https\://xhslink.cn/o/5tQdzkv8zPm 拷走口令，来【小红书】瞅瞅~`, new AbortController().signal, async args => {
    calls.push(args); return args[0] === 'open' ? { targetId: 'short-link-tab' } : args[0] === 'evaluate' ? { result: { host: 'www.xiaohongshu.com', id, blocked: false, title: '合成标题', body: reference } } : {};
  }, async () => {});
  assert.deepEqual(calls.find(c => c[0] === 'open'), ['open', 'https://xhslink.cn/o/5tQdzkv8zPm']);
  assert.equal(result.url, `https://www.xiaohongshu.com/explore/${id}`);
  assert.equal(result.text, `合成标题\n\n${reference}`);
  assert.deepEqual(calls.at(-1), ['close', 'short-link-tab']);
});

test('链接通过独立标签读取正确正文并关闭，输出不保留分享令牌', async () => {
  const calls: string[][] = [], id = '0123456789abcdef01234567';
  const result = await readStyleReference(`https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic`, new AbortController().signal, async args => {
    calls.push(args); return args[0] === 'open' ? { targetId: 'owned-tab' } : args[0] === 'evaluate' ? { result: { host: 'www.xiaohongshu.com', id, blocked: false, title: '合成标题', body: reference } } : {};
  }, async () => {});
  assert.match(result.text, /合成标题/); assert.doesNotMatch(result.url, /token/); assert.deepEqual(calls.at(-1), ['close', 'owned-tab']);
  assert(calls.filter(c => c[0] === 'evaluate').every(c => c.includes('owned-tab')));
});

test('错误页面与登录验证不冒充读取成功；登录页保留供用户完成验证', async () => {
  const id = '0123456789abcdef01234567';
  for (const blocked of [false, true]) {
    const calls: string[][] = [];
    await assert.rejects(() => readStyleReference(`https://www.xiaohongshu.com/explore/${id}`, new AbortController().signal, async args => {
      calls.push(args); return args[0] === 'open' ? { targetId: 'own-tab' } : args[0] === 'evaluate' ? { result: { host: 'www.xiaohongshu.com', id: 'fedcba9876543210fedcba98', blocked, title: '其他笔记', body: reference } } : {};
    }, async () => {}), blocked ? /登录或安全验证/ : /完整正文/);
    assert.equal(calls.some(c => c[0] === 'close'), !blocked);
    assert.equal(calls.filter(c => c[0] === 'evaluate').length, blocked ? 1 : 2);
  }
});

test('拆解与补充分析使用同一请求内容，不保存风格、不启用、不写试生成', async () => {
  const before = await listPersonalStyles('local-owner'); let sent = '';
  mock.method(aiTransport, 'fetch', async (_: unknown, init?: RequestInit) => { sent = String(init?.body); return answer(); });
  const response = await analyze(request({ ...input(), preferences: '减少哲理', previous: report }));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).analysis, report);
  assert.match(sent, /减少哲理/); assert.match(sent, /previous/);
  assert.deepEqual(await listPersonalStyles('local-owner'), before);
});

test('无依据的模型输出被拒绝，原风格不变', async () => {
  const before = await listPersonalStyles('local-owner');
  mock.method(aiTransport, 'fetch', async () => answer({ ...report, traits: [{ ...report.traits[0], evidence: [{ referenceId: 'primary', quote: '虚构的依据', imageIds: [] }] }] }));
  const response = await analyze(request(input()));
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'INVALID_RESULT');
  assert.deepEqual(await listPersonalStyles('local-owner'), before);
});

test('取消与超时拒绝迟到结果；未授权来源及无效文案不调用模型', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => answer());
  const rejected = new Request('http://localhost/api/personal/styles/analyze', { method: 'POST', headers: { host: 'localhost', origin: 'https://external.test', 'content-type': 'application/json' }, body: JSON.stringify(input()) });
  assert.equal((await analyze(rejected)).status, 403);
  assert.equal((await analyze(request(input('太短')))).status, 400);
  const controller = new AbortController(); controller.abort();
  assert.equal((await analyze(request(input(), controller.signal))).status, 499);
  assert.equal(transport.mock.callCount(), 0);
  const originalTimeout = AbortSignal.timeout, deadline = new AbortController();
  mock.method(AbortSignal, 'timeout', (ms: number) => ms === 190000 ? deadline.signal : originalTimeout(ms));
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
  mock.method(aiTransport, 'fetch', async () => { entered(); await hold; return answer(); });
  const pending = analyze(request(input())); await started; deadline.abort();
  const result = await pending; assert.equal(result.status, 504); release();
  await new Promise(r => setTimeout(r, 20)); assert.equal((await listPersonalStyles('local-owner')).trials.length, 0);
});

test('认可后的规则一次保存成新草稿；补充仅新增版本，旧启用版本及冲突保护保留', async () => {
  const content = compileLearnedRules(report, [0, 1]);
  const created = await save(request({ action: 'create', content })); assert.equal(created.status, 200);
  const style = (await created.json()).style; assert.equal(style.activeVersionId, null); assert.deepEqual(style.versions[0].snapshot.content, content);
  const before = (await listPersonalStyles('local-owner')).styles.find(s => s.id === 'daily')!;
  const learned = compileLearnedRules(report, [0], before.versions[0].snapshot.content);
  const body = { action: 'save', id: 'daily', revision: before.revision, content: learned };
  const updated = (await (await save(request(body))).json()).style;
  assert.equal(updated.activeVersionId, before.activeVersionId); assert.equal(updated.versions.length, 2); assert.deepEqual(updated.versions[0], before.versions[0]);
  assert.equal((await save(request(body))).status, 409);
  assert.equal((await save(request({ action: 'create', content: { name: 'bad' } }))).status, 400);
});

const titledReport = (): StyleAnalysis => ({ ...structuredClone(report), portrait: { ...report.portrait, titles: { available: true, expression: '把具体场景凝练成一个感受入口。', language: '短句克制，不堆叠形容词。', appeal: '借熟悉的日常体验引起共鸣。', relation: '点出感受，具体来由留给正文。' } }, traits: [{ scope: 'title', label: '场景与感受', observation: '让场景承担情绪，不提前总结全部内容。', mode: 'core', support: 'candidate', evidence: [{ referenceId: 'primary', quote: '窗边的片刻', imageIds: [] }], rule: '标题从素材中选择一个场景切口，引出感受但不抢先解释全文。' }, ...structuredClone(report.traits)] });

test('标题独立提炼并进入标题规则；不能把正文或图片文字冒充标题', async () => {
  const source = ref(reference, [], '窗边的片刻'), result = titledReport();
  assert.deepEqual(validateStyleAnalysis(result, [source]), result);
  const compiled = compileLearnedRules(result, [0]);
  assert.match(compiled.sections.title, /场景切口/); assert.equal(compiled.sections.body, ''); assert.equal(compiled.sections.captions, '');
  assert.throws(() => validateStyleAnalysis(report, [source]), /标题/);
  const missingRule = structuredClone(result); missingRule.traits = missingRule.traits.filter(t => t.scope !== 'title');
  assert.throws(() => validateStyleAnalysis(missingRule, [source]), /标题/);
  const forged = structuredClone(result); forged.traits[0].evidence[0].quote = '清晨推开窗';
  assert.throws(() => validateStyleAnalysis(forged, [source]), /依据/);
  assert.throws(() => validateStyleAnalysis(result, [ref()]), /标题/);
  const missingFacet = structuredClone(result); missingFacet.portrait.titles.appeal = '';
  assert.throws(() => validateStyleAnalysis(missingFacet, [source]), /不完整/);
  const onlyTitle = { ...result, traits: [result.traits[0]] };
  assert(styleLearningRequestSchema.safeParse({ references: [ref('', [], '窗边的片刻')] }).success);
  assert.equal(validateStyleAnalysis(onlyTitle, [ref('', [], '窗边的片刻')]).traits.length, 1);
  const image = await fixtureImage();
  assert.throws(() => validateStyleAnalysis({ ...result, imageAnalyses: imageReport.imageAnalyses, traits: [{ ...result.traits[0], evidence: [{ referenceId: 'primary', quote: '米色背景上的深色方块', imageIds: [image.id] }] }] }, [{ ...source, images: [image] }]), /标题/);
});

test('单篇候选须认可，多篇共性必须有不同参考依据；差异不自动进入规则', () => {
  const one = structuredClone(report); one.traits[0].support = 'recurring';
  const validated = validateStyleAnalysis(one, [ref()]);
  assert.equal(validated.traits[0].support, 'candidate'); assert.deepEqual(defaultLearnedSelection(validated), []);
  const second = ref('合成参考：傍晚收起伞，门外响起一阵雨声。我停在台阶上，没有马上走进屋里，听雨水落进树叶。', [], '', 'second');
  const both = structuredClone(one); both.traits[0].evidence.push({ referenceId: 'second', quote: '傍晚收起伞', imageIds: [] });
  both.differences = [{ aspect: '场景节奏', referenceIds: ['primary', 'second'], description: '一篇从早晨出发，一篇停留在傍晚。', suggestion: '时间不固定，随用户的新素材决定。' }];
  const common = validateStyleAnalysis(both, [ref(), second]);
  assert.deepEqual(defaultLearnedSelection(common), [0]);
  assert.doesNotMatch(JSON.stringify(compileLearnedRules(common, [0])), /早晨出发|傍晚/);
  const flexible = compileLearnedRules(common, [1]); assert.match(flexible.sections.overall, /随素材调整：/);
  assert.throws(() => validateStyleAnalysis(both, [ref()]));
  const bad = structuredClone(both); bad.differences[0].referenceIds = ['primary', 'primary'];
  assert.throws(() => validateStyleAnalysis(bad, [ref(), second]), /至少两篇/);
});

test('重复正文、重复链接、重复标题样本及过多图不能制造多篇共性', async () => {
  const source = ref();
  assert(!styleLearningRequestSchema.safeParse({ references: [source, { ...source, id: 'second', text: source.text.replace(/。/g, '。\n') }] }).success);
  assert(!styleLearningRequestSchema.safeParse({ references: [{ ...source, url: 'https://xhslink.cn/o/abc' }, { ...source, id: 'second', text: source.text + '更多', url: 'https://xhslink.cn/o/abc' }] }).success);
  assert(!styleLearningRequestSchema.safeParse({ references: [ref('', [], '仅有相同标题'), ref('', [], '仅有相同标题', 'second')] }).success);
  const image = await fixtureImage();
  assert(!styleLearningRequestSchema.safeParse({ references: Array.from({ length: 3 }, (_, n) => ref('', Array.from({ length: 8 }, (_, i) => ({ ...image, id: `image-${i}` })), `参考${n}`, `ref-${n}`)) }).success);
  assert(!styleLearningRequestSchema.safeParse({ references: [{ ...source, id: 'path/collision' }] }).success);
});

test('多篇同号图片按所属参考核对，不能跨篇借用图文依据', async () => {
  const image = await fixtureImage(), first = ref('', [image]), second = ref('', [{ ...image, caption: '另一张图上的文字' }], '', 'second');
  const result = structuredClone(imageReport);
  result.imageAnalyses.push({ ...imageReport.imageAnalyses[0], referenceId: 'second', visibleText: '另一张图上的文字', visualDescription: '灰色的雨伞靠在门边' });
  result.traits[0].evidence.push({ referenceId: 'second', imageIds: [image.id], quote: '另一张图上的文字' });
  result.traits[0].support = 'recurring';
  assert.equal(validateStyleAnalysis(result, [first, second]).traits[0].support, 'recurring');
  result.traits[0].evidence[1].quote = '米色背景上的深色方块';
  assert.throws(() => validateStyleAnalysis(result, [first, second]), /依据/);
});

test('多篇标题和正文作为分离字段发给模型，尊重用户配置的输出额度', async () => {
  const source = ref(reference, [], '窗边的片刻'), second = ref('合成参考：晚饭后走过河边，看见路灯一盏盏亮起来，街口传来有人交谈的声音。', [], '河边的一盏灯', 'second');
  let sent: { max_output_tokens: number; input: { role: string; content: string | { type: string; text?: string }[] }[] } | undefined;
  mock.method(aiTransport, 'fetch', async (_: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return answer(titledReport()); });
  const response = await analyze(request({ references: [source, second], preferences: '标题克制些' }));
  assert.equal(response.status, 200);
  const parts = sent!.input.find(i => i.role === 'user')!.content; assert(Array.isArray(parts));
  const supplied = JSON.parse(parts[0].text!);
  assert.equal(supplied.references[0].title, '窗边的片刻'); assert.equal(supplied.references[1].id, 'second');
  assert.equal(supplied.references[0].text, reference); assert.equal(supplied.preferences, '标题克制些');
  assert(sent!.max_output_tokens > 6500);
  assert.equal((await listPersonalStyles('local-owner')).trials.length, 0);
});


test('已打开的旧页面请求兼容新接口，并返回旧页面实际可解析的结果', async () => {
  const before = await listPersonalStyles('local-owner'); let sent = '';
  mock.method(aiTransport, 'fetch', async (_: unknown, init?: RequestInit) => { sent = String(init?.body); return answer(); });
  const legacy = { referenceText: reference, referenceImages: [], preferences: '保留细节，减少总结' };
  // This is the request rejected by the previous release before reaching a model.
  assert.equal(styleLearningRequestSchema.safeParse(legacy).success, false);
  const response = await analyze(request(legacy));
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Style-Learning-Version'), '1');
  const result = legacyStyleAnalysisSchema.parse((await response.json()).analysis);
  assert.equal(result.traits[0].evidence, '清晨推开窗'); assert.deepEqual(result.traits[0].imageIds, []);
  assert.match(result.traits[0].observation, /候选特点/); assert.match(result.traits[1].rule, /^随素材调整：/);
  assert.match(result.cautions[0], /旧版页面/); assert.equal('portrait' in result, false);
  assert.match(sent, /保留细节，减少总结/); assert.deepEqual(await listPersonalStyles('local-owner'), before);
});

test('旧页面继续反馈时保留文案、图片和上次分析，不把正文首句伪装成标题', async () => {
  const image = await fixtureImage();
  const previous = analysisForLegacyPage(imageReport), legacy = { referenceText: '正文首句并不一定是标题。后面还有自己的观察和感受，需要完整保留。', referenceImages: [image], previous, preferences: '配文短一点' };
  const parsed = parseStyleLearningInput(legacy);
  assert(parsed.legacy); assert.equal(parsed.input.references[0].title, '');
  assert.equal(parsed.input.references[0].text, legacy.referenceText); assert.deepEqual(parsed.input.references[0].images, [image]);
  assert.equal(parsed.input.previous!.traits[0].evidence[0].quote, previous.traits[0].evidence);
  assert.equal(parsed.input.previous!.imageAnalyses[0].referenceId, 'primary');
  const selected = await selectProfile('local-owner');
  await recordProbe('local-owner', selected.profile!, 'image', { status: 'passed', at: null, message: 'Synthetic capability fixture' });
  mock.method(aiTransport, 'fetch', async () => answer(imageReport));
  const response = await analyze(request(legacy));
  const result = legacyStyleAnalysisSchema.parse((await response.json()).analysis);
  assert.equal(response.status, 200); assert.equal(result.imageAnalyses[0].imageId, image.id);
  assert.equal(result.imageAnalyses[0].visibleText, imageReport.imageAnalyses[0].visibleText);
  assert.equal('referenceId' in result.imageAnalyses[0], false);
  assert.deepEqual(result.traits[0].imageIds, [image.id]);
});

test('兼容输出不截断可执行规则，保留完整图片与原文依据', () => {
  const bounded = structuredClone(report);
  bounded.traits = Array.from({ length: 12 }, () => ({ ...report.traits[1], rule: '规'.repeat(690), observation: '观'.repeat(470) }));
  bounded.cautions = Array.from({ length: 4 }, () => '边'.repeat(300));
  const compatible = analysisForLegacyPage(bounded);
  assert.equal(compatible.traits.length, 12); assert.equal(compatible.cautions.length, 5);
  assert.equal(compatible.traits[0].rule, '随素材调整：' + '规'.repeat(690));
  assert.equal(compatible.traits[0].evidence, report.traits[1].evidence[0].quote);
});

test('错误提示指明真正有问题的字段，未知协议与旧结果格式错误不会调用 AI', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => answer());
  for (const [body, expected] of [
    [{ references: [{ ...ref(), title: '字'.repeat(301) }] }, /参考 1的标题最多 300 字/],
    [{ ...input(), preferences: '字'.repeat(2001) }, /补充要求最多 2000 字/],
    [{ referenceText: '字'.repeat(12001) }, /参考文案最多 12000 字/],
    [{ referenceText: reference, previous: { broken: true } }, /上次分析格式不兼容/],
    [{ ...input(), referenceText: reference }, /页面版本不一致/],
  ] as const) {
    const response = await analyze(request(body)); assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, expected);
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('新版协议保持风格画像响应，旧请求取消仍阻止模型调用', async () => {
  const transport = mock.method(aiTransport, 'fetch', async () => answer());
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await analyze(request({ referenceText: reference }, cancelled.signal))).status, 499);
  assert.equal(transport.mock.callCount(), 0);
  const response = await analyze(request(input()));
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Style-Learning-Version'), '2');
  assert.deepEqual((await response.json()).analysis, report);
});


test('达到输出额度后返回可选择的恢复状态和可读片段，确认提高后可完成且配置不变',async()=>{
 const before=await listPersonalStyles('local-owner'),profile=(await selectProfile('local-owner')).profile!,limits:number[]=[];
 const partial='{"name":"候选风格","summary":"片段仅供预览","portrait":{"temperament":"以观察承接感受","body":"尚未完成';
 mock.method(aiTransport,'fetch',async(_url:unknown,init?:RequestInit)=>{
  limits.push(JSON.parse(String(init?.body)).max_output_tokens);
  return limits.length===1?Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:partial}]}]}):answer();
 });
 const first=await analyze(request(input()));assert.equal(first.status,502);const failed=await first.json();
 assert.equal(failed.error.code,'INCOMPLETE');assert.equal(failed.analysis,undefined);assert.equal(failed.recovery.reason,'exhausted');assert.equal(failed.recovery.limit,8000);assert.equal(failed.recovery.suggestedTokens,32768);
 assert.deepEqual(failed.recovery.partial.map((p:{label:string})=>p.label),['建议风格名','风格概述','整体气质']);assert(!JSON.stringify(failed).includes('尚未完成'));
 assert.deepEqual(limits,[8000]);assert.deepEqual(await listPersonalStyles('local-owner'),before);
 const retry=await analyze(request({...input(),maxOutputTokens:32768}));assert.equal(retry.status,200);assert.deepEqual((await retry.json()).analysis,report);assert.deepEqual(limits,[8000,32768]);
 assert.deepEqual((await selectProfile('local-owner')).profile,profile);assert.deepEqual(await listPersonalStyles('local-owner'),before);
});

test('输出预算不被服务支持时仍提供修改重试；取消优先且不返回迟到片段',async()=>{
 mock.method(aiTransport,'fetch',async()=>Response.json({error:{code:'invalid_parameter',message:'max_output_tokens exceeds maximum 16384'}},{status:400}));
 const response=await analyze(request({...input(),maxOutputTokens:32768})),failed=await response.json();assert.equal(failed.error.code,'OUTPUT_BUDGET_UNSUPPORTED');assert.equal(failed.recovery.reason,'unsupported');assert.equal(failed.recovery.suggestedTokens,16384);assert.deepEqual(failed.recovery.partial,[]);
 const abort=new AbortController();mock.method(aiTransport,'fetch',async()=>{abort.abort();return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'{"summary":"迟到片段"'}]}]});});
 const cancelled=await analyze(request(input(),abort.signal)),body=await cancelled.json();assert.equal(cancelled.status,499);assert.equal(body.recovery,undefined);assert(!JSON.stringify(body).includes('迟到片段'));
});

test('不完整 JSON 只展示已闭合的可读字段，不拼接成可执行规则',()=>{
 assert.deepEqual(previewStyleFragments('{"summary":"完整概述","traits":[{"rule":"不应显示的规则"}],"portrait":{"body":"未闭合'),[{label:'风格概述',text:'完整概述'}]);
 assert.deepEqual(previewStyleFragments('{"summary":"包含\\n换行和\\"引号\\"","portrait":'),[{label:'风格概述',text:'包含\n换行和"引号"'}]);
 assert.deepEqual(previewStyleFragments(''),[]);
});

test('旧页面截断提示引导到新恢复交互，额度字段校验不产生模型调用',async()=>{
 const transport=mock.method(aiTransport,'fetch',async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[]}));
 const response=await analyze(request({referenceText:reference}));const result=await response.json();assert.match(result.error.message,/当前页面为旧版/);assert.equal(result.recovery.limit,8000);
 const invalid=await analyze(request({...input(),maxOutputTokens:0}));assert.equal(invalid.status,400);assert.match((await invalid.json()).error.message,/不小于 256/);assert.equal(transport.mock.callCount(),1);
});

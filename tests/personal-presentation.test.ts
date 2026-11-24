import test from 'node:test';
import assert from 'node:assert/strict';
import { personalStepAfterSuccess, initialPersonalStep, personalPromptSummary, personalLengthLabel, personalDirectionPreview } from '../lib/personal/presentation';
import { emptyPersonalInput } from '../lib/personal/schema';
import { personalPromptContract } from '../lib/personal/writing-guidance';

const plan='从散步途中注意到的细节切入，用观察与心情的变化串联段落，让慢下来的感受贯穿其中，减少路线罗列。';
const prompt=`【核心感受或观点】\n从散步里感受慢下来\n\n【写作安排】\n${plan}\n\n【语气与写法】\n自然口语，以观察承接思考。\n\n${personalPromptContract({...emptyPersonalInput,bodyLength:'long'})}`;
test('方向摘要只摘录当前提示词的写作安排，编辑安排、写法、篇幅后即时对应原文',()=>{
 const summary=personalPromptSummary(prompt);assert.equal(summary.core,plan);assert.equal(summary.writing,'自然口语，以观察承接思考。');assert.match(summary.length!,/650～850/);assert.match(summary.boundary!,/^真实润色/);assert.equal(summary.complete,true);
 const changed='以散步中的小事为线索，重点写注意力从目标回到眼前的过程，结尾留白。';
 const edited=personalPromptSummary(prompt.replace(plan,changed).replace('自然口语，以观察承接思考。','克制叙述，不做总结。').replace('650～850','300～400'));
 assert.equal(edited.core,changed);assert.equal(edited.writing,'克制叙述，不做总结。');assert.match(edited.length!,/300～400/);
});
test('旧稿只有核心感受或删除安排区段时使用短提示回退，不把原文或旧观点作为安排',()=>{
 assert.equal(personalPromptSummary('随便写一篇日常。').fallback,true);
 assert.equal(personalPromptSummary('【核心感受或观点】\n从散步里感受慢下来').core,null);
 const s=personalPromptSummary(prompt.replace('【写作安排】','【素材】'));assert.equal(s.core,null);assert.equal(s.fallback,true);
});
test('重复或相互歧义的方向区段不挑选其中一个冒充确认方向',()=>{
 const s=personalPromptSummary(prompt+'\n\n【创作方向】\n从另一处细节切入');assert.equal(s.core,null);assert.equal(s.fallback,true);
});
test('来源里的字数不冒充正文长度；缺少字段保持未知',()=>{
 const s=personalPromptSummary('【核心表达】\n珍惜当下\n\n【参考资料】\n该网站要求200字，真实润色。');assert.equal(s.length,null);assert.equal(s.boundary,null);assert.equal(s.writing,null);assert.equal(s.complete,false);
});
test('支持分段 Markdown 和创意模式当前正文设置，无需数据迁移',()=>{
 const s=personalPromptSummary('## 创作方向\n从细微观察切入，逐步展开感受。\n## 语气与写法\n轻松\n'+personalPromptContract({...emptyPersonalInput,truth:'creative',bodyLength:'custom',customLength:720}));assert.equal(s.core,'从细微观察切入，逐步展开感受。');assert.match(s.boundary!,/^创意发挥/);assert.match(s.length!,/720/);assert.equal(personalLengthLabel({...emptyPersonalInput,bodyLength:'custom',customLength:720}),'自定义约 720 字');
});
test('新草稿显示第一步；只有对应生成成功事件才决定推进到第二或第三步',()=>{
 assert.equal(initialPersonalStep,'input');
 assert.equal(personalStepAfterSuccess('prompt'),'prompt');
 assert.equal(personalStepAfterSuccess('note'),'result');
 assert.equal(initialPersonalStep,'input');
});

test('紧凑摘要保留两句完整安排供展开，预览最多70字符，不修改完整文本',()=>{
 const core='从沿途观察切入，'+ '从眼前的细节理解当下的感受，'.repeat(7)+'留下自然的思考。再以感受变化串联段落，减少重复。';
 const full=`【写作安排】\n${core}\n【输出要求】\n输出格式：生成五个标题。\n【语气与写法】\n自然口语，避免空话。\n${personalPromptContract(emptyPersonalInput)}`;
 const before=full,p=personalDirectionPreview(full,emptyPersonalInput);assert.equal(Array.from(p.preview).length,71);assert.equal(p.core,core);assert.equal(full,before);assert.equal(p.writingLabel,'自然口语');assert.doesNotMatch(p.preview,/输出格式/);
});
test('明显直接复述观点、输出规则或没有安排时不作为摘要，短安排不凑字数',()=>{
 for(const full of ['只有一段完整要求，没有安排区段。','【写作安排】\n输出格式：必须生成5个标题。','【核心表达】\n热闹中的自由和松弛感。\n【写作安排】\n表达热闹中的自由和松弛感。','【核心表达】\n自由与松弛。\n【写作安排】\n自由与松弛！'])assert.equal(personalDirectionPreview(full,emptyPersonalInput).preview,'');
 assert.equal(personalDirectionPreview('【写作安排】\n从散步的细节切入。',emptyPersonalInput).preview,'从散步的细节切入。');
});
test('合法写法不依赖固定动词白名单，静态检查不假装能判断所有语义改写',()=>{
 const plan='放大海面颜色变化，用感官描写连接平静心情。';
 const full=`【核心感受或观点】\n在海边感到放松。\n【写作安排】\n${plan}`;
 assert.equal(personalDirectionPreview(full,emptyPersonalInput).core,plan);
 assert.equal(personalPromptSummary(full).fallback,false);
});
test('真实性只展示当前执行模式，并提示明确冲突，参考经历不冒充模式设置',()=>{
 const creative=personalPromptContract({...emptyPersonalInput,truth:'creative'});
 const p=personalDirectionPreview(creative,emptyPersonalInput);assert.equal(p.truthLabel,'真实润色');assert.match(p.conflict!,/真实性/);
 const same=personalDirectionPreview(creative,{...emptyPersonalInput,truth:'creative'});assert.equal(same.conflict,null);
 assert.equal(personalDirectionPreview('【参考文案】\n创意发挥：这只是参考文章。\n'+personalPromptContract(emptyPersonalInput),emptyPersonalInput).conflict,null);
 assert.match(personalDirectionPreview('创作模式：创意发挥',emptyPersonalInput).conflict!,/真实性/);
});
test('手选篇幅优先原文，自动篇幅不伪造确定字数，模式与长度冲突合并一条',()=>{
 const original=personalPromptContract({...emptyPersonalInput,bodyLength:'short',truth:'creative'});
 const p=personalDirectionPreview(original,{...emptyPersonalInput,bodyLength:'long'});assert.equal(p.lengthLabel,'约 650～850 字');assert.match(p.conflict!,/真实性、篇幅/);
 const auto=personalDirectionPreview(original,{...emptyPersonalInput,truth:'creative'});assert.equal(auto.lengthLabel,'自动篇幅');assert.equal(auto.conflict,null);
 const custom={...emptyPersonalInput,bodyLength:'custom' as const,customLength:720};assert.equal(personalDirectionPreview(personalPromptContract(custom),custom).conflict,null);
});

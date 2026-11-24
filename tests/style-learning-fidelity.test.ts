import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLearnedRules, type StyleAnalysis, type StyleReference } from '../lib/personal/style-learning';
import { referenceExcerpt } from '../lib/personal/style-learning-fidelity';
import { emptyRuleContent, ruleContentSchema } from '../lib/personal/style-rules';

const references: StyleReference[] = [{ id: 'one', title: '我开始给自己的选择留一点余地', text: '以前常常急着把每一步安排妥当。\n\n后来留了一点空白，才发觉，事情未必需要立刻有答案。\n\n我愿意等一等。', images: [{id:'photo',dataUrl:'data:image/png;base64,YQ==',caption:''}], url:'' }];
const report: StyleAnalysis = {
 name:'安静的自我谈话',summary:'用经验解释认识，以短句作停顿。',
 portrait:{temperament:'第一人称自我谈话，解释心理关系，直接但不训诫。',titles:{available:true,expression:'第一人称的认识陈述。',language:'完整口语句，轻微转折。',appeal:'命名熟悉却未说清的感受。',relation:'正文解释认识由来。'},body:'长句解释原因，独立短句落定，不写景物流水账。',captions:'配文是独立的心理解释，照片可以只呼应情绪，避免先报幕画面。',imageText:'正文和配文可以提供同一认识的不同阅读路径。',transfer:'随新的经历更换事实，不强制同一种观点。'},
 traits:[
 {scope:'title',label:'认识变化',observation:'标题指出一个心理关系。',mode:'core',support:'candidate',rule:'以第一人称说清新的认识，正文补足来由。',evidence:[{referenceId:'one',quote:'我开始给自己的选择留一点余地',imageIds:[]}]},
 {scope:'body',label:'长短节奏',observation:'解释长句之后单列一句自我回应。',mode:'core',support:'candidate',rule:'先把一层心理原因说完整，再在认识变化处停顿。',evidence:[{referenceId:'one',quote:'我愿意等一等。',imageIds:[]}]},
 {scope:'captions',label:'独立自述',observation:'文字是完整自述，照片承担情绪呼应。',mode:'core',support:'candidate',rule:'按本图承担的认识写独立配文，照片无需被逐项描述。',evidence:[{referenceId:'one',quote:'不必每一次，都急着找到答案。',imageIds:['photo']}]},
 {scope:'avoid',label:'未选择项',observation:'这项应排除。',mode:'core',support:'candidate',rule:'不应偷偷采用的未选择规则。',evidence:[{referenceId:'one',quote:'我愿意等一等',imageIds:[]}]},
 ],differences:[],imageAnalyses:[{referenceId:'one',imageId:'photo',visibleText:'不必每一次，\n都急着找到答案。\n\n允许自己，慢一点。',visualDescription:'窗边桌面，只有文字和光线。',captionAnalysis:'短句形成自我回应。',role:'提供认识上的停顿。',limitations:''}],cautions:[]
};

test('转换不再丢失标题、正文、配文画像与机制，原文片段保留节奏并明确事实边界',()=>{
 const content=compileLearnedRules(report,[0,1,2],undefined,references);
 assert.match(content.sections.title,/完整口语句/);assert.match(content.sections.body,/长句解释原因/);assert.match(content.sections.captions,/避免先报幕画面/);
 assert.match(content.sections.body,/解释长句之后单列一句自我回应/);
 assert.deepEqual(content.examples.map(e=>e.scope),['title','body','captions']);
 assert.equal(content.examples.find(e=>e.scope==='title')!.output,references[0].title);
 assert.match(content.examples.find(e=>e.scope==='body')!.output,/\n\n我愿意等一等/);
 assert.equal(content.examples.find(e=>e.scope==='captions')!.output,report.imageAnalyses[0].visibleText);
 assert(content.examples.every(e=>e.background.includes('不是本次笔记事实')));
 assert.doesNotMatch(JSON.stringify(content),/data:image|base64|不应偷偷采用/);assert(ruleContentSchema.safeParse(content).success);
});
test('只选标题不注入正文或配文栏目，重复补充不复制画像和示例，原示例与原规则保留',()=>{
 const base=emptyRuleContent('已有风格');base.sections.overall='已手写的整体偏好。';
 base.examples.push({id:crypto.randomUUID(),scope:'overall',background:'我的原示例',output:'原来喜欢的一句表达',reason:'原原因',disliked:'',changes:''});
 const before=structuredClone(base),once=compileLearnedRules(report,[0],base,references),twice=compileLearnedRules(report,[0],once,references);
 assert.deepEqual(base,before);assert.equal(once.sections.body,'');assert.equal(once.sections.captions,'');assert.equal(once.sections.overall,base.sections.overall);
 assert.deepEqual(once.examples[0],base.examples[0]);assert.deepEqual(twice,once);
});
test('没有可见图中文字时不将画面描述伪装成语言范例，也不保存未选参考',()=>{
 const data=structuredClone(report);data.imageAnalyses[0].visibleText='';
 const extra={...references[0],id:'unselected',title:'不应加入的另一种写法',text:'这篇没有被选中的笔记不能成为生成范例。',images:[]};
 const compiled=compileLearnedRules(data,[2],undefined,[...references,extra]);
 assert.equal(compiled.examples.length,0);assert.doesNotMatch(JSON.stringify(compiled),/不应加入|窗边桌面/);
});
test('长参考只截取所选证据附近的有限原文，保留原标点，不回退成无关首段',()=>{
 const source='无关开头。\n'.repeat(200)+'\n我愿意等一等。\n不急着给一切下结论。\n\n'+'后面的内容。\n'.repeat(200);
 const excerpt=referenceExcerpt(source,'我愿意等一等');assert(excerpt.length<=1200);assert.match(excerpt,/我愿意等一等。\n不急着/);
 assert.equal(referenceExcerpt(source,'并不存在的片段'),'');
});
test('既有示例已满时不替换用户示例，所选规则的表达画像仍被保存',()=>{
 const base=emptyRuleContent();base.examples=Array.from({length:8},(_,i)=>({id:crypto.randomUUID(),scope:'title' as const,background:'旧样本',output:'旧样本'+i,reason:'保留',disliked:'',changes:''}));
 const result=compileLearnedRules(report,[0],base,references);assert.deepEqual(result.examples,base.examples);assert.match(result.sections.title,/表达画像/);
});
test('短参考也必须有引用依据，视觉描述不冒充语言样本，用户图上文字补充保留来源',()=>{
 assert.equal(referenceExcerpt('无关短文','不存在依据'),'');
 const data=structuredClone(report);data.traits[2].evidence[0].quote='窗边桌面';
 assert.equal(compileLearnedRules(data,[2],undefined,references).examples.length,0);
 const refs=structuredClone(references);refs[0].images[0].caption='用户补充：我可以先停一停，再作决定。';
 data.traits[2].evidence[0].quote='我可以先停一停';
 const result=compileLearnedRules(data,[2],undefined,refs);
 assert.equal(result.examples[0].output,refs[0].images[0].caption);assert.match(result.examples[0].background,/用户补充文字/);
});
test('同一栏目取消部分特点后，不把整段画像包含的未选写法重新注入',()=>{
 const data=structuredClone(report);data.portrait.body+='不认可的铺陈结构。';
 data.traits.push({...data.traits[1],label:'未选铺陈',rule:'不认可的铺陈结构。'});
 const result=compileLearnedRules(data,[1],undefined,references);
 assert.match(result.sections.body,/解释长句之后单列一句自我回应/);assert.doesNotMatch(result.sections.body,/不认可的铺陈结构/);
});

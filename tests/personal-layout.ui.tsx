import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonalStyleLoadStatus } from "../components/personal/style-load-status";
import { PersonalAssist, PersonalNoteEditor, type PersonalResultProps } from "../components/personal/note-workspace";
import { XhsTitleEditor } from "../components/xhs-title-editor";
import { ResultPanel } from "../components/result-panel";
import { PersonalCopyMenu } from "../components/personal/copy-menu";
import { PersonalTagFields } from "../components/personal/inline-tags";
import { formatPersonalBodyAndTags, finishPersonalTag } from "../lib/personal/note-format";
import { WorkflowStep } from "../components/personal/workflow-step";
import { WorkflowNav } from "../components/personal/workflow-nav";
import { PromptDirection } from "../components/personal/prompt-direction";
import { emptyPersonalInput } from "../lib/personal/schema";
import { CopyButton } from "../components/copy-button";
import { createDemoResult } from "../lib/demo";
import { PersonalPolishControls, PersonalPolishPreview, comparePolishFields, polishChangeMessage } from "../components/personal/polish";
import { newPersonalDraft } from "../lib/personal/drafts";
import { analyzeHashtags, formatAll } from "../lib/format";
import type { ContentResult } from "../lib/schema";

type El=ReactElement<Record<string,unknown>>;
test("润色预览只对照实际改动，将正文放在首位，仍能查看整个选择范围",()=>{
 const before=[{key:"title:0",text:"原题"},{key:"body",text:"原文首段\n\n原文末段"},{key:"cover:headline",text:"未改的封面"}];
 const after=[{key:"title:0",text:"新题"},{key:"body",text:"新的首段\n\n新的末段"},before[2]];
 const fields=comparePolishFields(before,after);
 const markup=renderToStaticMarkup(createElement(PersonalPolishPreview,{fields,scope:"all"}));
 assert.equal((markup.match(/修改前<\/dt>/gu)||[]).length,2);
 assert.equal((markup.match(/修改后<\/dt>/gu)||[]).length,2);
 assert.ok(markup.indexOf("正文修改对照")>=0 && markup.indexOf("正文修改对照")<markup.indexOf("标题 1修改对照"));
 assert.match(markup,/原文首段\n\n原文末段/u);assert.match(markup,/新的首段\n\n新的末段/u);
 assert.match(markup,/<summary>查看完整文案<\/summary>/u);
 assert.match(markup,/未改的封面/u);assert.doesNotMatch(markup,/封面主标题修改对照/u);
});

test("仅标题有改动时说明正文未改，全部相同或仅空白差异时如实反馈",()=>{
 const before=[{key:"title:0",text:"原题"},{key:"body",text:"正文内容"}];
 const onlyTitle=comparePolishFields(before,[{key:"title:0",text:"新题"},{key:"body",text:" 正文内容 "}]);
 assert.match(polishChangeMessage(onlyTitle),/1 个标题。正文未改/u);
 assert.match(polishChangeMessage(onlyTitle,true),/已采用.*1 个标题.*正文未改/u);
 const unchanged=comparePolishFields(before,before);
 assert.equal(polishChangeMessage(unchanged),"本次返回的内容与原文相同。");
 const html=renderToStaticMarkup(createElement(PersonalPolishPreview,{fields:unchanged,scope:"all"}));
 assert.doesNotMatch(html,/修改前<\/dt>/u);
 const captions=comparePolishFields([{key:"caption:a",text:"首图"},{key:"caption:b",text:"次图"}],[{key:"caption:a",text:"首图"},{key:"caption:b",text:"新的次图"}]);
 assert.match(renderToStaticMarkup(createElement(PersonalPolishPreview,{fields:captions,scope:"captions"})),/图片 2 配文修改对照/u);
 assert.doesNotMatch(polishChangeMessage(captions),/正文/u);
});
function elements(node:unknown):El[]{if(Array.isArray(node))return node.flatMap(elements);return node&&typeof node==="object"&&"props" in node?[node as El,...elements((node as El).props.children)]:[];}
function text(node:unknown):string{if(typeof node==="string"||typeof node==="number")return String(node);if(Array.isArray(node))return node.map(text).join("");return node&&typeof node==="object"&&"props" in node?text((node as El).props.children):"";}
function props():PersonalResultProps{return {generation:{mode:"demo",result:createDemoResult([]),imageIds:[],meta:{durationMs:900,completedAt:"2026-11-01T00:00:00.000Z"}},images:[],busy:false,stale:false,onChange(){},onRegenerate(){},onRewrite(){},onPartial(){},onError(){}};}
function edit(node:El,value:string){(node.props.onChange as (e:{target:{value:string}})=>void)({target:{value}});}

test("没有顶部重复标题、单选或默认选择，正文修改不碰其他字段",()=>{
 const p=props(),before=structuredClone(p.generation!.result);let next:ContentResult|undefined;p.onChange=value=>{next=value;};
 const root=PersonalNoteEditor(p),nodes=elements(root);
 assert.ok(!nodes.some(x=>x.props['aria-label']==='当前发布标题'));
 assert.doesNotMatch(text(root),/当前选中|选择或调整标题/);
 edit(nodes.find(x=>x.props.id==='result-body')!,'第一段\n\n第二段');assert.deepEqual(next,{...before,body:'第一段\n\n第二段'});assert.deepEqual(p.generation!.result,before);
});

test("五个标题只有一处编辑，复制正文与话题忽略旧选择，全部文案保留原范围",()=>{
 const p=props();let rewrite:unknown,next:ContentResult|undefined;p.onPartial=c=>{rewrite=c;};p.onChange=r=>{next=r;};
 const nodes=elements(PersonalAssist({...p,selectedTitleIndex:4} as PersonalResultProps));assert.equal(nodes.filter(x=>x.type==='input'&&x.props.type==='radio').length,0);
 assert.equal(nodes.filter(x=>x.type===XhsTitleEditor).length,5);
 const rendered=renderToStaticMarkup(createElement(PersonalAssist,p));
 assert.equal((rendered.match(/<textarea[^>]*aria-label="标题 [1-5]"/gu)||[]).length,5);assert.equal(nodes.filter(x=>x.type==='h3'&&text(x).includes('标题备选')).length,1);
 (nodes.find(x=>x.type===XhsTitleEditor&&x.props.label==='标题 4')!.props.onChange as (s:string)=>void)('新的标题四');assert.equal(next!.titles[3],'新的标题四');
 (nodes.find(x=>x.props['aria-label']==='AI 重写标题 4')!.props.onClick as ()=>void)();assert.deepEqual(rewrite,{target:'title_one',targetIndex:3});
 (nodes.find(x=>x.type==='button'&&text(x)==='AI 重新生成全部标题')!.props.onClick as ()=>void)();assert.deepEqual(rewrite,{target:'titles_all'});
 p.generation!.result=next!;const updated=elements(PersonalAssist(p)),copies=updated.filter(x=>x.type===CopyButton);
 assert.equal(copies.find(x=>x.props.label==='复制标题 4')!.props.text,'新的标题四');
 const menu=updated.find(x=>x.type===PersonalCopyMenu)!;assert.equal(menu.props.result,next);assert.equal(menu.props.disabled,false);
 assert.doesNotMatch(formatPersonalBodyAndTags(next!),/新的标题四/);assert.match(formatAll(next!),/新的标题四/);
 p.generation!.result={...next!,titles:['','','','','']};assert.equal(elements(PersonalAssist(p)).find(x=>x.type===PersonalCopyMenu)!.props.disabled,false);
 p.generation!.result.hashtags=['#不足'];assert.equal(elements(PersonalAssist(p)).find(x=>x.type===PersonalCopyMenu)!.props.disabled,true);
});

test("话题只有一套原位输入，保留未完成内容；整理前后复制和重写限制正确",()=>{
 let changed:string[]=[];const build=(value:string[])=>PersonalTagFields({value,onChange:v=>{changed=v;},onError(){},onPartial(){}});
 let nodes=elements(build(['##一个 #一个 #两个']));assert.equal(nodes.filter(x=>x.type==='input').length,1);assert.equal(nodes.filter(x=>x.type==='textarea'||x.type==='details').length,0);
 assert.equal(nodes.find(x=>x.type===CopyButton)!.props.disabled,true);
 edit(nodes.find(x=>x.props['aria-label']==='话题 1')!,'#保留 手动修改');assert.deepEqual(changed,['#保留 手动修改']);
 nodes=elements(build(['##重复','重复',' #新话题 ','#未完成!','']));
 edit(nodes.find(x=>x.props['aria-label']==='话题 5')!,'#');assert.deepEqual(changed,['##重复','重复',' #新话题 ','#未完成!','#']);
 (nodes.find(x=>x.props['aria-label']==='话题 3')!.props.onBlur as ()=>void)();assert.deepEqual(changed,['##重复','重复','#新话题','#未完成!','']);
 const tags=props().generation!.result.hashtags;nodes=elements(build(tags));assert.equal(nodes.find(x=>x.type===CopyButton)!.props.disabled,false);assert.equal(analyzeHashtags(String(nodes.find(x=>x.type===CopyButton)!.props.text)).count,10);
 const p=props();p.generation!.result={...p.generation!.result,hashtags:['#不足']};assert.ok(elements(PersonalAssist(p)).filter(x=>x.type===CopyButton).every(x=>x.props.label!=='复制正文与话题'||x.props.disabled===true));
 assert.equal(finishPersonalTag('##一个'),'#一个');assert.equal(finishPersonalTag('#未完成!'),'#未完成!');
});

test("风格读取失败停止加载提示，可主动重读，成功后错误区域消失",()=>{
 let retried=0;
 const failed=PersonalStyleLoadStatus({loading:false,error:'风格文件暂时不可读取',onRetry:()=>{retried++;}})!;
 const markup=renderToStaticMarkup(failed);
 assert.match(markup,/role="alert"/);assert.match(markup,/重新读取/);assert.doesNotMatch(markup,/正在读取/);
 const button=elements(failed).find(e=>e.type==='button')!;
 (button.props.onClick as ()=>void)();assert.equal(retried,1);
 assert.match(renderToStaticMarkup(createElement(PersonalStyleLoadStatus,{loading:true,error:'',onRetry:()=>{}})),/正在读取个人风格/);
 assert.equal(renderToStaticMarkup(createElement(PersonalStyleLoadStatus,{loading:false,error:'',onRetry:()=>{}})),'');
});

test("话题增删和显式去重均更新同一数组，单项重写索引与当前输入对应",()=>{
 let value=['##一','#一',' 二 '],choice:unknown,error='';const view=()=>elements(PersonalTagFields({value,onChange:v=>{value=v;},onError:m=>{error=m;},onPartial:c=>{choice=c;}}));
 const click=(nodes:El[],label:string)=>(nodes.find(x=>x.type==='button'&&(x.props['aria-label']===label||text(x)===label))!.props.onClick as ()=>void)();
 click(view(),'整理格式与去重');assert.deepEqual(value,['#一','#二']);click(view(),'添加话题');assert.deepEqual(value,['#一','#二','']);click(view(),'删除话题 2');assert.deepEqual(value,['#一','']);
 value=['#原文!'];click(view(),'整理格式与去重');assert.deepEqual(value,['#原文!']);assert.match(error,/未整理或丢弃/);
 value=props().generation!.result.hashtags;click(view(),'AI 重写话题 4');assert.deepEqual(choice,{target:'tag_one',targetIndex:3});click(view(),'重新生成全部话题');assert.deepEqual(choice,{target:'tags_all'});
 value=[...value,'#重复待整理'];assert.equal(view().find(x=>x.props['aria-label']==='AI 重写话题 1')!.props.disabled,true);
});

test("逐图配文按稳定ID找图片，单项编辑与重写不碰其他配文",()=>{
 const p=props();p.generation!.result=createDemoResult(['image-a','image-b']);p.images=[{id:'image-b',width:100,height:100,preview:'blob:second',file:new File([],'second.png')},{id:'image-a',width:100,height:100,preview:'blob:first',file:new File([],'first.png')}];let next:ContentResult|undefined,target:unknown;p.onChange=x=>{next=x;};p.onPartial=x=>{target=x;};
 const nodes=elements(PersonalNoteEditor(p));assert.deepEqual(nodes.filter(x=>x.type==='img').map(x=>x.props.src),['blob:first','blob:second']);
 edit(nodes.find(x=>x.props['aria-label']==='图片 2 补充说明')!,'多行\n新配文');assert.equal(next!.imageCaptions[1].description,'多行\n新配文');assert.deepEqual(next!.imageCaptions[0],p.generation!.result.imageCaptions[0]);
 (nodes.find(x=>x.props['aria-label']==='AI 重写图片 2 配文')!.props.onClick as ()=>void)();assert.deepEqual(target,{target:'caption_one',targetImageId:'image-b'});
});

test("空稿、无图、忙碌和旧结果警告可用；共享图文结果布局默认不变",()=>{
 const p=props();assert.ok(!text(PersonalNoteEditor(p)).includes('逐图配文'));
 p.busy=true;p.stale=true;assert.equal(elements(PersonalNoteEditor(p)).find(x=>x.type==='fieldset')!.props.disabled,true);assert.match(text(PersonalNoteEditor(p)),/保留上次笔记/);assert.equal(elements(PersonalAssist(p)).find(x=>x.type==='fieldset')!.props.disabled,true);
 const blank={...p,busy:false,generation:null};assert.match(text(PersonalNoteEditor(blank)),/先在第二步确认提示词/);assert.ok(elements(PersonalAssist(blank)).filter(x=>x.type==='button').every(x=>x.props.disabled===true));
 const original=ResultPanel({...p,selectedTitleIndex:2,titleReview:false,onSelectTitle(){}});assert.equal(original.props.className,'result-panel');assert.equal(text(elements(original).find(x=>x.props.id==='result-title')),'笔记结果');assert.ok(!text(original).includes('快捷操作'));
});


test("步骤只有一处可见，隐藏面板仍保留编辑器和反馈，切换不需要挂载或移除编辑器",()=>{
 for(const active of ['input','prompt','result'] as const){
  const panels=(['input','prompt','result'] as const).map(step=>WorkflowStep({step,title:step,subtitle:'内容',status:'待确认',active:active===step,children:createElement('textarea',{value:`${step}正在编辑`}),feedback:createElement('p',null,'保留反馈')}));
  assert.equal(panels.filter(p=>!p.props.hidden).length,1);
  for(const panel of panels){
   const nodes=elements(panel);assert.equal(panel.props.role,'tabpanel');assert.equal(panel.props['aria-labelledby'],String(panel.props.id).replace('personal-','personal-tab-'));
   assert.ok(nodes.some(x=>x.type==='textarea'));assert.match(text(panel),/保留反馈/);assert.equal(nodes.some(x=>x.type==='button'),false);
  }
 }
});

test("润色只有一个标题栏入口，不挤占内容区；空稿禁用，隐藏步骤保留入口状态",()=>{
 const draft=newPersonalDraft(),p=props();
 for(const generated of [false,true]){
  draft.generation=generated?p.generation:null;
  draft.generatedInput=generated?{input:draft.input,confirmedPrompt:'测试方向',research:null,imageIds:[]}:null;
  for(const active of [false,true]){
   const panel=WorkflowStep({step:'result',title:'查看与调整笔记',subtitle:'内容可以直接修改',status:generated?'已生成':'待生成',active,
    actions:createElement(PersonalPolishControls,{key:`polish:${draft.id}`,draft,disabled:false,update(){}}),
    children:createElement(PersonalNoteEditor,{...p,generation:draft.generation,key:`note:${draft.id}`})});
   const nodes=elements(panel),heading=nodes.find(e=>e.props.className==='personal-panel-heading')!;
   const content=nodes.find(e=>e.props.id==='personal-result-content')!;
   assert.equal(elements(heading).filter(e=>e.type===PersonalPolishControls).length,1);
   assert.equal(elements(content).filter(e=>e.type===PersonalPolishControls).length,0);
   const html=renderToStaticMarkup(panel);
   assert.equal((html.match(/>润色文案<\/button>/g)||[]).length,1);
   assert.equal(/<button[^>]*disabled=""[^>]*>[^]*?润色文案<\/button>/.test(html),!generated);
   assert.equal(panel.props.hidden,!active);
  }
 }
});

test("顶部导航有三个可访问的标签；未生成步骤可进入，当前/完成状态带文字且只有一个键盘起点",()=>{
 const html=renderToStaticMarkup(createElement(WorkflowNav,{active:'prompt',statuses:{input:'已完成',prompt:'待确认',result:'待生成'},completed:{input:true,prompt:false,result:false},onSelect(){}}));
 assert.equal((html.match(/role="tab"/g)||[]).length,3);assert.equal((html.match(/tabindex="0"/g)||[]).length,1);
 assert.match(html,/id="personal-tab-prompt"[^>]+aria-selected="true"[^>]+aria-current="step"/);assert.match(html,/aria-controls="personal-result"/);
 assert.match(html,/已完成/);assert.match(html,/待生成/);assert.doesNotMatch(html,/disabled|aria-expanded/);
});

test("简要方向未知时仅提示展开，真实执行设置与完整原文不混淆",()=>{
 const root=PromptDirection({prompt:'这是一份没有固定区段的旧提示词。',input:{...emptyPersonalInput,bodyLength:'long'}});
 assert.match(text(root),/提示词已准备好，可展开查看/);assert.doesNotMatch(text(root),/没有固定区段的旧提示词/);assert.match(text(root),/650～850/);assert.match(text(root),/真实润色/);
 const edited=PromptDirection({prompt:'【写作安排】\n从窗边光线切入，详写阅读时的观察，再串起安静的感受\n\n【语气与写法】\n自然短段落',input:emptyPersonalInput});assert.equal(elements(edited).find(e=>e.props.core)?.props.core,'从窗边光线切入，详写阅读时的观察，再串起安静的感受');assert.match(text(edited),/自然短段落/);
});


test("仅修改观点或其他规则而未确认安排时，隐藏旧摘要并提示核对",()=>{
 const root=PromptDirection({prompt:'【写作安排】\n从散步细节切入，用观察串联心情变化\n\n【语气与写法】\n自然短段落',input:emptyPersonalInput,pending:true});
 assert.match(text(root),/写作安排待核对/);assert.doesNotMatch(text(root),/散步细节/);assert.equal(elements(root).some(e=>e.props.core),false);
});

test("新情绪配文没有小标题字段，旧小标题仍可编辑与复制；逐项编辑只改目标",()=>{
 const p=props();p.generation!.result=createDemoResult(['image-a','image-b']);p.generation!.result.imageCaptions[0]={imageId:'image-a',headline:'',description:'安静的画面里，心也放慢了。\n完整的原创短文。'};p.generation!.result.imageCaptions[1].headline='旧稿自己写的小标题';
 p.images=[{id:'image-a',width:100,height:100,preview:'blob:first',file:new File([],'first.png')},{id:'image-b',width:100,height:100,preview:'blob:second',file:new File([],'second.png')}];
 const html=renderToStaticMarkup(createElement(PersonalNoteEditor,p));assert.ok(!html.includes('aria-label="图片 1 短标题"'));assert.ok(html.includes('aria-label="图片 2 短标题"'));assert.ok(html.includes('旧稿自己写的小标题'));
 const nodes=elements(PersonalNoteEditor(p));assert.equal(nodes.find(x=>x.type===CopyButton&&x.props.label==='复制图片 1 配文')!.props.text,p.generation!.result.imageCaptions[0].description);assert.equal(nodes.find(x=>x.type===CopyButton&&x.props.label==='复制图片 2 配文')!.props.text,`旧稿自己写的小标题\n${p.generation!.result.imageCaptions[1].description}`);
});

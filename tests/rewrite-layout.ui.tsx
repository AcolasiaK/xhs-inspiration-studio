import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,type ReactElement} from 'react';
import {RewriteLayout,RewriteSettings,rewriteDirections} from '../components/rewrite/modal';
import {RewriteResult,partialCopyText,rewriteLabels} from '../components/rewrite/result';
import {CopyButton} from '../components/copy-button';
import type {StudioImage} from '../lib/types';
type El=ReactElement<Record<string,unknown>>;
function nodes(n:unknown):El[]{return Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'&&'props' in n?[n as El,...nodes((n as El).props.children)]:[];}
function text(n:unknown):string{return typeof n==='string'||typeof n==='number'?String(n):Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'&&'props' in n?text((n as El).props.children):'';}
const noop=()=>{};
const base={label:'正文',titleId:'test-title',result:false,directionLabel:'更自然',copyText:'新正文\n\n完整末尾',onStart:noop,onClose:noop,onApply:noop,onEdit:noop,onCopyError:noop};
test('设置只含方向、三行补充与默认折叠依据，输入回调保留原值',()=>{
 let direction='',instruction='';const view=RewriteSettings({direction:'natural',onDirection:v=>{direction=v;},instruction:'保留要求',onInstruction:v=>{instruction=v;},busy:false,basis:createElement('p',{},'合成背景依据')});const els=nodes(view);
 assert.equal(els.filter(e=>e.type==='select').length,1);assert.equal(els.filter(e=>e.type==='option').length,rewriteDirections.length);assert.equal(els.find(e=>e.type==='textarea')!.props.rows,3);assert.equal(els.find(e=>e.type==='details')!.props.open,undefined);assert.doesNotMatch(text(view),/原正文|原内容|对比/);
 (els.find(e=>e.type==='textarea')!.props.onChange as (e:unknown)=>void)({target:{value:'未完成的新要求'}});(els.find(e=>e.type==='select')!.props.onChange as (e:unknown)=>void)({target:{value:'detailed'}});assert.equal(instruction,'未完成的新要求');assert.equal(direction,'detailed');
});
test('预览只展示新结果，设置不可见；复制保留完整换行',()=>{
 const view=RewriteLayout({...base,result:true,settings:createElement('p',{},'不得出现在结果阶段的设置'),children:createElement('p',{},base.copyText)}),els=nodes(view);
 assert.doesNotMatch(text(view),/不得出现在结果阶段|原正文|原内容|对比/);assert.match(text(view),/正文重写结果/);assert.match(text(view),/已生成 · 更自然/);assert.equal(els.find(e=>e.type===CopyButton)!.props.text,base.copyText);
 assert.ok(els.some(e=>e.type==='footer'));assert.ok(els.some(e=>e.props.className==='rw-content'));assert.match(text(view),/修改要求[\s\S]*新正文/);
});
test('只有显式采用回调才应用，取消、修改要求与重新重写各走独立回调',()=>{
 const calls:string[]=[];const els=nodes(RewriteLayout({...base,result:true,onClose:()=>calls.push('close'),onStart:()=>calls.push('start'),onEdit:()=>calls.push('edit'),onApply:()=>calls.push('apply')}));assert.deepEqual(calls,[]);
 for(const label of ['修改要求','重新重写','关闭','使用此结果']){(els.find(e=>e.type==='button'&&text(e)===label)!.props.onClick as ()=>void)();}assert.deepEqual(calls,['edit','start','close','apply']);
});
test('生成中禁止重复提交、可取消，错误有重试，保存时禁止关闭',()=>{
 let els=nodes(RewriteLayout({...base,busy:true,progress:'正在处理图片 1 / 2'}));assert.equal(els.find(e=>e.props.className==='rw-primary')!.props.disabled,true);assert.ok(els.some(e=>e.type==='button'&&text(e)==='取消本次重写'&&!e.props.disabled));assert.ok(els.some(e=>e.props.role==='status'));
 els=nodes(RewriteLayout({...base,error:'模拟超时'}));assert.ok(els.some(e=>e.props.role==='alert'&&text(e)==='模拟超时'));assert.ok(els.some(e=>text(e)==='重试重写'));
 els=nodes(RewriteLayout({...base,result:true,applying:true}));assert.ok(els.filter(e=>e.type==='button').every(e=>e.props.disabled));
});
test('全部局部类型渲染新结果，三个候选保留选择，十个话题复制为空格分隔',()=>{
 let selected=-1;const output={titles:['新候选甲','新候选乙','新候选丙'],hashtags:[],imageCaptions:[]};let els=nodes(RewriteResult({output,choice:{target:'title_one',targetIndex:1},images:[],selected:0,onSelect:i=>{selected=i;}}));assert.equal(els.filter(e=>e.type==='input').length,3);(els.filter(e=>e.type==='input')[2].props.onChange as ()=>void)();assert.equal(selected,2);
 const tags={titles:[],imageCaptions:[],hashtags:Array.from({length:10},(_,i)=>`#话题${i+1}`)};assert.equal(partialCopyText(tags,[]),tags.hashtags.join(' '));els=nodes(RewriteResult({output:tags,choice:{target:'tags_all'},images:[],selected:0,onSelect:noop}));assert.equal(els.filter(e=>e.type==='span').length,10);assert.equal(Object.keys(rewriteLabels).length,7);
});
test('配文预览与复制按稳定 ID 定位原结果图片，不根据返回位置错配',()=>{
 const images=[{id:'a',preview:'blob:a'},{id:'b',preview:'blob:b'}] as StudioImage[];const output={titles:[],hashtags:[],imageCaptions:[{imageId:'b',headline:'新标题',description:'第一行\n第二行'}]};const view=RewriteResult({output,choice:{target:'caption_one',targetImageId:'b'},images,selected:0,onSelect:noop});assert.equal(nodes(view).find(e=>e.type==='img')!.props.src,'blob:b');assert.match(text(view),/图片 2/);assert.equal(partialCopyText(output,images),'图片 2\n新标题\n第一行\n第二行');
});

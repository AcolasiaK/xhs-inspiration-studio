import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBaiduHotspots, fetchBaiduHotspots, collectBaiduHotspots, HotspotSourceError, hotspotSourceErrorMessage } from '../lib/server/hotspots-source';
import { HOTSPOT_BOARD, HOTSPOT_SOURCE, HOTSPOT_SOURCE_KEY, hotspotLinkLabel } from '../lib/hotspot-metadata';
import { beijingDay, HotspotsStore } from '../lib/server/hotspots-store';
import { generateHotspotSuggestions } from '../lib/server/hotspots-ai';
import { PRESET_STYLES } from '../lib/styles';
import { POST } from '../app/api/hotspots/route';
import type { Hotspot, HotspotSuggestion } from '../lib/server/hotspots-types';
import { AppError } from '../lib/errors';

// 所有条目均为测试数据，不代表实时热点。
const collectedAt='2026-11-02T00:00:00.000Z';
const row=(word:string,index:number,extra:Record<string,unknown>={})=>({word,index,desc:'模拟榜单摘要',rawUrl:`https://www.baidu.com/s?wd=${encodeURIComponent(word)}`,...extra});
const html=(content:unknown[])=>`<!DOCTYPE html><!--s-data: ${JSON.stringify({tab:'realtime',data:{cards:[{component:'hotList',content}]}})} -->`;
const item = (id='one'): Hotspot => ({id,title:'模拟热点',description:'模拟说明',url:'https://example.com/test',source:'测试源',publishedAt:null,collectedAt:'2026-10-29T00:00:00.000Z',rank:1});
const idea = (id='one'): HotspotSuggestion => ({hotspotId:id,topic:'测试主题',angle:'测试角度',headline:'测试标题',imageIdea:'测试配图',reason:'测试原因'});
async function sandbox() { const dir=await mkdtemp(join(tmpdir(),'xhs-hotspot-test-')); return {dir,file:join(dir,'hotspots.json'),cleanup:()=>rm(dir,{recursive:true,force:true})}; }

test('百度模拟页面跳过置顶、空项和缺失排名，去重并保留真实原排名，不捏造发布时间',()=>{
  const rows=parseBaiduHotspots(html([row('置顶',0,{isTop:true}),row('模拟热点',0),row('模拟热点',1),row('',2),{word:'缺少排名'},row('第二个模拟',3,{rawUrl:'https://127.0.0.1/private',hotScore:'1234',pubDate:'2026-11-01'})]),collectedAt);
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.rank),[1,4]);assert.equal(rows[0].source,HOTSPOT_SOURCE);
  assert.equal(new URL(rows[0].url).hostname,'www.baidu.com');assert.equal(rows[1].url,HOTSPOT_BOARD);
  assert.ok(rows.every(r=>r.publishedAt===null&&r.collectedAt===collectedAt));assert.equal('hotScore' in rows[1],false);
  assert.equal(hotspotLinkLabel(rows[0]),'查看百度相关结果');assert.equal(hotspotLinkLabel(rows[1]),'查看百度榜单');
});
test('采集保留全部有真实排名的候选，筛选器不再用无关高热条目补数',async()=>{
  const values=Array.from({length:15},(_,i)=>row(`模拟科技${i}`,i));values[14]=row('海外旅行周末路线规划',14);values[13]=row('海外旅行事故',13);
  assert.equal(parseBaiduHotspots(html(values),collectedAt).length,15);
  const batch=await collectBaiduHotspots(collectedAt,async()=>new Response(html(values)));
  assert.equal(batch.sourceCount,15);assert.equal(batch.items.length,1);assert.equal(batch.filteredCount,14);assert.equal(batch.items[0].rank,15);assert.equal(batch.items[0].title,'海外旅行周末路线规划');
});
test('结构改变、验证码和不安全链接不执行脚本或访问限制入口',()=>{
  for(const input of ['<html>changed</html>','<!--s-data: not-json -->',html([]).replace('realtime','other')]) assert.throws(()=>parseBaiduHotspots(input,collectedAt),{code:'FORMAT'});
  assert.throws(()=>parseBaiduHotspots('<html>百度安全验证</html>',collectedAt),{code:'RESTRICTED'});
  for(const rawUrl of ['javascript:alert(1)','https://www.baidu.com.evil.test/s?wd=x','https://user:pass@www.baidu.com/s?wd=x','https://www.baidu.com:444/s?wd=x']) assert.equal(parseBaiduHotspots(html([row('测试',0,{rawUrl})]),collectedAt)[0].url,HOTSPOT_BOARD);
  assert.deepEqual(parseBaiduHotspots(html([]),collectedAt),[]);
});
test('真实采集器只访问固定 URL、不重试、不跟随验证跳转，安全区分失败',async()=>{
  for(const [status,code] of [[403,'RESTRICTED'],[302,'RESTRICTED'],[429,'RATE_LIMIT'],[503,'HTTP']] as const){
    let calls=0;await assert.rejects(fetchBaiduHotspots(collectedAt,async(url,options)=>{calls++;assert.equal(url,HOTSPOT_BOARD);assert.equal(options?.redirect,'manual');assert.equal(new Headers(options?.headers).has('cookie'),false);return new Response('',{status});}),{code});assert.equal(calls,1);
  }
  await assert.rejects(fetchBaiduHotspots(collectedAt,async()=>new Response('x'.repeat(1_000_001))),{code:'TOO_LARGE'});
  await assert.rejects(fetchBaiduHotspots(collectedAt,async()=>new Response(html([]))),{code:'EMPTY'});
  await assert.rejects(fetchBaiduHotspots(collectedAt,async()=>{throw new DOMException('private detail','TimeoutError');}),{code:'TIMEOUT'});
  await assert.rejects(fetchBaiduHotspots(collectedAt,async()=>{throw new Error('private detail');}),{code:'NETWORK'});
  const success=await fetchBaiduHotspots(collectedAt,async()=>new Response(html([row('模拟美食',0)])));assert.equal(success.length,1);
  assert.match(hotspotSourceErrorMessage(new HotspotSourceError('TIMEOUT')),/12 秒/);assert.match(hotspotSourceErrorMessage(new HotspotSourceError('HTTP',502)),/HTTP 502/);assert.doesNotMatch(hotspotSourceErrorMessage(new Error('private detail')),/private/);
});
test('首次全部来源失败不编造热点，也不会请求 AI 建议',async()=>{
  const {file,cleanup}=await sandbox();let called=0;
  const store=new HotspotsStore({file,now:()=>new Date('2026-10-29T00:00:00Z'),collect:async()=>{throw new Error('UNAVAILABLE');},suggest:async()=>{called++;return [];}});
  try {const state=await store.update(true);assert.equal(state.items.length,0);assert.ok(state.error);assert.equal(state.lastSuccessAt,null);await assert.rejects(store.suggest(PRESET_STYLES[0].preferences),/没有可用热点/);assert.equal(called,0);}
  finally {await cleanup();}
});
test('北京时间当天已成功不重复采集，隔天补更，失败保留旧数据并可重启恢复',async()=>{
  const {file,cleanup}=await sandbox(); let now=new Date('2026-10-28T17:00:00Z'),calls=0,fail=false;
  const collect=async()=>{calls++;if(fail)throw new Error('NO_NETWORK');return [item()];};
  const make=()=>new HotspotsStore({file,now:()=>now,collect,suggest:async()=>[idea()]});
  try {
    const store=make();let result=await store.update(false);assert.equal(result.items.length,1);assert.equal(calls,1);
    await store.update(false);assert.equal(calls,1);assert.equal(beijingDay(now),'2026-10-29');
    now=new Date('2026-10-29T17:00:00Z');fail=true;result=await store.update(false);assert.equal(calls,2);assert.equal(result.items.length,1);assert.ok(result.error);assert.equal(result.lastSuccessAt,'2026-10-28T17:00:00.000Z');
    await store.update(false);assert.equal(calls,2);const restored=await make().state();assert.equal(restored.items.length,1);assert.ok(restored.error);
  } finally {await cleanup();}
});
test('自动和手动更新并发只采集一次，状态真实反映进行中',async()=>{
  const {file,cleanup}=await sandbox();let calls=0,release!:()=>void,entered!:()=>void;
  const start=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const store=new HotspotsStore({file,now:()=>new Date('2026-10-29T00:00:00Z'),collect:async()=>{calls++;entered();await wait;return [item()];},suggest:async()=>[]});
  try {const one=store.update(false);await start;assert.equal((await store.state()).updating,true);const two=store.update(true);release();await Promise.all([one,two]);assert.equal(calls,1);assert.equal((await store.state()).updating,false);}finally{await cleanup();}
});
test('热点更新保留成功建议及原始依据，新建议成功后替换；不写入风格参数',async()=>{
  const {file,cleanup}=await sandbox();let now=new Date('2026-10-29T00:00:00Z'),id='one';
  const store=new HotspotsStore({file,now:()=>now,collect:async()=>[item(id)],suggest:async(items)=>[idea(items[0].id),idea(items[0].id),idea(items[0].id)]});
  try {await store.update(true);await store.suggest({...PRESET_STYLES[0].preferences,styleNotes:'PRIVATE_STYLE_SENTINEL'});assert.equal((await store.state()).suggestions.length,3);assert.ok(!(await readFile(file,'utf8')).includes('PRIVATE_STYLE_SENTINEL'));
    now=new Date('2026-10-30T00:00:00Z');id='two';const updated=await store.update(true);
    assert.equal(updated.items[0].id,'two');assert.equal(updated.suggestions.length,3);
    assert.equal(updated.suggestionItems?.[0].id,'one');assert.equal(updated.suggestionSourceAt,'2026-10-29T00:00:00.000Z');
    const restored=await new HotspotsStore({file,now:()=>now,collect:async()=>[],suggest:async()=>[]}).state();assert.equal(restored.suggestionItems?.[0].id,'one');
    const next=await store.suggest(PRESET_STYLES[0].preferences);assert.equal(next.suggestionItems?.[0].id,'two');assert.equal(next.suggestionSourceAt,next.lastSuccessAt);
  }finally{await cleanup();}
});
test('AI 模拟只引用实际热点，错误热点 ID 被拒绝且不打印原始响应',async()=>{
  const env={...process.env};process.env.OPENAI_API_KEY='test-only';process.env.OPENAI_MODEL='test-model';delete process.env.OPENAI_BASE_URL;
  const answer=(id:string)=>({id:'test',object:'response',status:'completed',output:[{id:'m',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({suggestions:[1,2,3].map(i=>({...idea(id),topic:`测试主题${i}`,headline:`测试标题${i}`}))}),annotations:[]}]}]});
  const outbound=mock.method(globalThis,'fetch',async()=>Response.json(answer('one')));
  try {const result=await generateHotspotSuggestions([item()],PRESET_STYLES[0].preferences);assert.equal(result.length,3);const sent=JSON.parse(String(outbound.mock.calls[0].arguments[1]?.body));assert.ok(sent.input[1].content.includes('模拟热点'));assert.equal(outbound.mock.callCount(),1);assert.ok(sent.input[0].content.includes('未关联权威报道'));assert.ok(sent.input[0].content.includes('不代表事件发生在大陆'));const context=JSON.parse(sent.input[1].content).hotspots[0];assert.equal(context.url,item().url);assert.equal(context.collectedAt,item().collectedAt);assert.match(context.verification,/核实/);
    outbound.mock.mockImplementation(async()=>Response.json(answer('invented')));await assert.rejects(generateHotspotSuggestions([item()],PRESET_STYLES[0].preferences));
    const duplicate=answer('one');duplicate.output[0].content[0].text=JSON.stringify({suggestions:[idea(),idea(),idea()]});outbound.mock.mockImplementation(async()=>Response.json(duplicate));await assert.rejects(generateHotspotSuggestions([item()],PRESET_STYLES[0].preferences));
  } finally {mock.restoreAll();process.env=env;}
});
test('真实更新与建议接口需要正确口令，跨站请求被拒绝',async()=>{
  const old={...process.env};process.env={...process.env,APP_ACCESS_TOKEN:'test-only-secret',NODE_ENV:'test'};
  const request=(origin:string,token?:string)=>new Request('http://localhost/api/hotspots',{method:'POST',headers:{host:'localhost',origin,...(token?{'x-access-token':token}:{})},body:JSON.stringify({action:'update'})});
  try {assert.equal((await POST(request('http://elsewhere.test'))).status,403);assert.equal((await POST(request('http://localhost'))).status,401);}
  finally{process.env=old;}
});
test('建议生成时热点变化会拒绝旧结果，不将它写入新快照',async()=>{
  const {file,cleanup}=await sandbox();const now=new Date('2026-10-29T00:00:00Z');let id='one',release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const store=new HotspotsStore({file,now:()=>now,collect:async()=>[item(id)],suggest:async()=>{entered();await wait;return [idea('one'),idea('one'),idea('one')];}});
  try{await store.update(true);const pending=store.suggest(PRESET_STYLES[0].preferences);await started;id='two';await store.update(true);release();await assert.rejects(pending);const current=await store.state();assert.equal(current.items[0].id,'two');assert.equal(current.suggestions.length,0);}
  finally{await cleanup();}
});
test('相同风格并发合并，不同风格不会误收到其他风格的结果',async()=>{
  const {file,cleanup}=await sandbox();let calls=0,release!:()=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
  const store=new HotspotsStore({file,now:()=>new Date('2026-10-29T00:00:00Z'),collect:async()=>[item()],suggest:async()=>{calls++;entered();await wait;return [idea(),idea(),idea()];}});
  try{await store.update(true);const first=store.suggest(PRESET_STYLES[0].preferences);await started;const same=store.suggest(PRESET_STYLES[0].preferences);await assert.rejects(store.suggest(PRESET_STYLES[1].preferences),/另一种风格/);release();await Promise.all([first,same]);assert.equal(calls,1);}
  finally{await cleanup();}
});
test('损坏的缓存日期不会导致页面或每日检查崩溃',async()=>{
  const {file,cleanup}=await sandbox();
  try {await writeFile(file,JSON.stringify({version:1,items:[],lastSuccessAt:'invalid',lastAttemptAt:null,error:null,sources:[],suggestions:[],suggestionGeneratedAt:null,suggestionError:null}));
    const store=new HotspotsStore({file,now:()=>new Date('2026-10-29T00:00:00Z'),collect:async()=>[item()],suggest:async()=>[]});
    assert.ok((await store.state()).error);assert.equal((await store.update(false)).items.length,1);
  }finally{await cleanup();}
});

test('旧来源当天缓存触发新来源更新，受限失败保留旧来源时间并明确标识；恢复后不再误用旧建议',async()=>{
  const {file,cleanup}=await sandbox();let calls=0,fail=true;
  const oldItem={...item(),source:'Google Trends 台湾地区热搜'};
  await writeFile(file,JSON.stringify({version:1,items:[oldItem],lastSuccessAt:collectedAt,lastAttemptAt:collectedAt,error:null,sources:[],suggestions:[idea()],suggestionGeneratedAt:collectedAt,suggestionError:null}));
  const collect=async()=>{calls++;if(fail)throw new HotspotSourceError('RESTRICTED');return [item('new')];};
  const make=()=>new HotspotsStore({file,now:()=>new Date(collectedAt),collect,suggest:async()=>[]});
  try {
    const store=make();assert.match((await store.state()).sourceNotice!,/切换来源前/);
    const failed=await store.update(false);assert.equal(calls,1);assert.match(failed.error!,/访问受限/);assert.deepEqual(failed.items,[oldItem]);assert.equal(failed.lastSuccessAt,collectedAt);assert.match(failed.ordering,/旧来源/);
    await store.update(false);assert.equal(calls,1);assert.match((await make().state()).sourceNotice!,/切换来源前/);
    fail=false;const updated=await store.update(true);assert.equal(updated.sourceNotice,null);assert.equal(updated.suggestions.length,1);assert.deepEqual(updated.suggestionItems,[oldItem]);assert.match(updated.ordering,/百度原排名/);
    const stored=JSON.parse(await readFile(file,'utf8'));assert.equal(stored.sourceKey,HOTSPOT_SOURCE_KEY);assert.equal((await make().state()).sourceNotice,null);
  }finally{await cleanup();}
});

test('热更新替换旧生成函数和原型，保留缓存、并发锁及进行中请求的配置',async()=>{
  const {file,cleanup}=await sandbox();let enter!:()=>void,release!:()=>void,oldCalls=0,newCalls=0;
  const entered=new Promise<void>(r=>{enter=r;}),pending=new Promise<void>(r=>{release=r;});
  const collect=async()=>[item()];
  const store=new HotspotsStore({file,now:()=>new Date(collectedAt),collect,suggest:async(_items,_style,_signal,source)=>{oldCalls++;assert.equal(source,'original-profile');enter();await pending;return [idea()];}});
  try{
    await store.update(true);store.scheduler=true;
    const first=store.suggest(PRESET_STYLES[0].preferences,'original-profile');await entered;
    Object.setPrototypeOf(store,Object.create(HotspotsStore.prototype));
    const refreshed=HotspotsStore.refreshImplementation(store,{collect,suggest:async(_items,_style,_signal,source)=>{newCalls++;assert.equal(source,'new-profile');return [{...idea(),topic:'新调用层的结果'}];}});
    assert.equal(refreshed,store);assert.equal(Object.getPrototypeOf(refreshed),HotspotsStore.prototype);
    assert.equal((await refreshed.state()).scheduler,'running');assert.equal((await refreshed.state()).items.length,1);
    await assert.rejects(refreshed.suggest(PRESET_STYLES[0].preferences,'new-profile'),{code:'SUGGEST_BUSY'});
    const duplicate=refreshed.suggest(PRESET_STYLES[0].preferences,'original-profile');release();
    await Promise.all([first,duplicate]);assert.equal(oldCalls,1);assert.equal(newCalls,0);
    assert.equal((await refreshed.suggest(PRESET_STYLES[0].preferences,'new-profile')).suggestions[0].topic,'新调用层的结果');assert.equal(newCalls,1);
  }finally{release();await cleanup();}
});

test('AI 失败保留成功建议，记录本次时间与请求 ID；重试开始清旧错误且仅成功替换结果',async()=>{
  const {file,cleanup}=await sandbox();let fail=false,wait=false,release!:()=>void,enter!:()=>void;
  const entered=new Promise<void>(r=>{enter=r;}),pending=new Promise<void>(r=>{release=r;});
  let now=new Date(collectedAt);
  const store=new HotspotsStore({file,now:()=>now,collect:async()=>[item()],suggest:async()=>{if(fail)throw new AppError('PROVIDER_LIMIT','模型服务限流，已有建议保留。',429);if(wait){enter();await pending;}return [{...idea(),topic:wait?'新建议':'旧成功建议'}];}});
  const requestId='8ed29070-8b8e-4574-8509-a4a5fdd6cbf1';
  try{
    await store.update(true);await store.suggest(PRESET_STYLES[0].preferences);
    now=new Date('2026-11-02T00:01:00Z');fail=true;
    await assert.rejects(store.suggest(PRESET_STYLES[0].preferences,'relay',undefined,requestId),{code:'PROVIDER_LIMIT'});
    const failed=await store.state();assert.equal(failed.suggestions[0].topic,'旧成功建议');assert.equal(failed.suggestionGeneratedAt,collectedAt);
    assert.equal(failed.suggestionRequestId,requestId);assert.equal(failed.suggestionLastAttemptAt,now.toISOString());assert.equal(failed.suggestionErrorCode,'PROVIDER_LIMIT');
    fail=false;wait=true;const retry=store.suggest(PRESET_STYLES[0].preferences);await entered;
    const during=await store.state();assert.equal(during.suggestionError,null);assert.equal(during.suggestionErrorCode,null);assert.equal(during.suggestions[0].topic,'旧成功建议');
    release();const complete=await retry;assert.equal(complete.suggestions[0].topic,'新建议');assert.equal(complete.suggestionError,null);
  }finally{release();await cleanup();}
});

test('来源有内容但筛选为空属于成功的空列表，不误称来源失败或继续展示旧无关结果',async()=>{
 const {file,cleanup}=await sandbox();let empty=false;
 const store=new HotspotsStore({file,now:()=>new Date(collectedAt),collect:async()=>empty?{items:[],sourceCount:50,filteredCount:50}:[item()],suggest:async()=>[]});
 try{await store.update(true);empty=true;const result=await store.update(true);assert.equal(result.error,null);assert.equal(result.items.length,0);assert.equal(result.sourceCount,50);assert.match(result.selectionNotice!,/保留 0 条/);assert.equal(result.lastSuccessAt,collectedAt);await assert.rejects(store.suggest(PRESET_STYLES[0].preferences),/没有可用热点/);}finally{await cleanup();}
});
test('入选原因和多方向等附加字段可保存恢复，损坏附加字段不损坏旧记录',async()=>{
 const {file,cleanup}=await sandbox();const batch=await collectBaiduHotspots(collectedAt,async()=>new Response(html([row('周末城市漫步，慢下来感受自己的生活',20)])));
 const make=()=>new HotspotsStore({file,now:()=>new Date(collectedAt),collect:async()=>batch,suggest:async()=>[]});
 try{await make().update(true);const restored=await make().state();assert.deepEqual(restored.items[0].editorial,batch.items[0].editorial);assert.equal(restored.sourceCount,1);const saved=JSON.parse(await readFile(file,'utf8'));saved.items[0].editorial={version:999};await writeFile(file,JSON.stringify(saved));const compatible=await make().state();assert.equal(compatible.items.length,1);assert.equal(compatible.items[0].editorial,undefined);assert.equal(compatible.error,null);}finally{await cleanup();}
});

test('来源全部候选和较长摘要进入筛选，不在第十条或摘要180字处提前截断',async()=>{
 const values=Array.from({length:60},(_,i)=>row(`模拟无关科技${i}`,i));
 values[59]=row('一种新的周末选择',59,{desc:'背景说明。'.repeat(40)+'图书馆公共空间改造开放，市民可体验阅读活动。'});
 const parsed=parseBaiduHotspots(html(values),collectedAt);assert.equal(parsed.length,60);assert.ok(parsed[59].description.length>180);
 const batch=await collectBaiduHotspots(collectedAt,async()=>new Response(html(values)));
 assert.equal(batch.sourceCount,60);assert.equal(batch.items.length,1);assert.equal(batch.items[0].rank,60);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { personalGuidePlaces } from '../lib/personal/search-query';
import { searchXhsGuide } from '../lib/server/xhs-guide-search';
import type { BrowserSearchPort } from '../lib/server/openclaw-browser';

const id = 'abcdef0123456789abcdef01';
const title = '洛伽寺＋黄金海岸一日游';
const body = '从石狮黄金海岸沿步道步行到洛伽寺入口，再沿原路返回停车场，全程可安排在同一上午。';

// The site clears the grid when the sort changes, then fills in the detail count
// separately from the note text. Run the actual in-page scripts against those transitions.
function guidePage(options: { title?: string; body?: string; empty?: boolean; stalled?: boolean } = {}) {
  const queries: string[] = [];
  let clock = 0, sortedAt: number | undefined, openedAt: number | undefined, visits = 0;
  let location = new URL('about:blank');
  const hasGrid = () => !options.stalled && !options.empty && (sortedAt === undefined || clock - sortedAt >= 2200);
  const cover = { get isConnected() { return hasGrid(); }, scrollIntoView() {}, click() {
    visits++; openedAt = clock; location.pathname = '/search_result/' + id;
  } };
  const note = { getBoundingClientRect: () => ({ top: 12 }), querySelector: (s: string) => {
    if (s.includes('/explore/')) return { getAttribute: () => '/explore/' + id };
    if (s.startsWith('a.cover')) return cover;
    if (s === '.title') return { innerText: options.title ?? title };
    if (s === '.like-wrapper .count') return { innerText: '256' };
    return null;
  } };
  const tag = { textContent: '最多收藏', getAttribute: () => null, getBoundingClientRect: () => ({width:40,height:20}),
    classList: { contains: () => sortedAt !== undefined }, click() { sortedAt = clock; } };
  const filter = { dispatchEvent() {} };
  const row = { firstElementChild: {textContent:'排序依据'}, querySelectorAll: (s:string) => !s.includes('active') || sortedAt !== undefined ? [tag] : [] };
  const detail = { querySelectorAll: () => [], querySelector(s:string) {
    const values: Record<string,string> = { '.title':options.title ?? title, '#detail-desc':options.body ?? body,
      '.note-content .date':'昨天', '.author-container .username':'公开作者', '.interact-container .like-wrapper .count':'256',
      '.interact-container .collect-wrapper .count':clock - openedAt! >= 1850 ? '118' : '收藏' };
    return s in values ? {innerText:values[s]} : null;
  } };
  const emptyText = () => options.empty && sortedAt !== undefined && clock - sortedAt >= 1600 ? '没有找到相关笔记' : '';
  const document = { body: {get innerText() {return emptyText();}}, querySelectorAll(s:string) {
    if(s === 'section.note-item') return hasGrid() ? [note] : [];
    if(s === '.filter-panel .filters') return [row];
    return [];
  }, querySelector(s:string) {
    if(s === '.filter') return filter;
    if(s === '.note-detail-mask .close-circle') return {click() {openedAt=undefined; location.pathname='/search_result';}};
    if(s === '#noteContainer') return openedAt === undefined ? null : detail;
    if(s.includes('section.note-item')) return hasGrid() ? s.includes('a.cover') ? cover : note : null;
    return null;
  } };
  const port: BrowserSearchPort = async (args) => {
    if (args[0] === 'open') return {targetId:'owned'};
    if (args[0] === 'navigate') {
      location = new URL(args[1]); queries.push(location.searchParams.get('keyword')!);
    }
    if (args[0] === 'evaluate') return {result:await runInNewContext('(' + args.at(-1) + ')()', {
      document, location, URL, window:{scrollY:0}, MouseEvent:class {}, getComputedStyle:()=>({opacity:'1'}),
      Date:class extends Date {static now(){return clock;}},
      setTimeout:(callback:()=>void,ms:number)=>{clock+=ms;callback();},
    })};
    return {ok:true};
  };
  return {port,queries,visits:()=>visits};
}

test('个人攻略等到排序后的卡片和真实收藏数，接受地点与“攻略”没有紧邻的笔记',async()=>{
  const page=guidePage();
  const result=await searchXhsGuide({query:'洛伽寺攻略'},page.port);
  assert.equal(page.queries.length,1);
  assert.deepEqual(page.queries[0].match(/攻略/gu),['攻略']);
  assert.equal(result.state,'found');
  assert.equal(result.sources[0]?.collects,118);
  assert.match(result.sources[0]?.snippet ?? '',/黄金海岸/u);
});

test('标题没写全地点也能核对正文，其他景点的路线不作为本次来源',async()=>{
  for(const [text,count] of [[body,1],['从另一个小镇出发，沿步道步行到另一座古寺的入口，再原路返回停车场。',0]] as const) {
    const page=guidePage({title:'石狮一日游',body:text});
    const result=await searchXhsGuide({query:'洛伽寺'},page.port);
    assert.equal(page.visits(),1);
    assert.equal(result.sources.length,count);
  }
});

test('站点明确无结果和列表一直没有加载完成，返回不同状态',async()=>{
  const empty=await searchXhsGuide({query:'洛伽寺'},guidePage({empty:true}).port);
  const stalled=await searchXhsGuide({query:'洛伽寺'},guidePage({stalled:true}).port);
  assert.equal(empty.state,'none');
  assert.equal(stalled.state,'unavailable');
  assert.match(stalled.notice ?? '',/加载/u);
});

test('检索词保留多个明确地点，拒绝敏感输入和只写检索意图的输入',()=>{
  assert.deepEqual(personalGuidePlaces('泉州 洛伽寺旅游攻略 石狮黄金海岸 攻略'),['泉州','洛伽寺','石狮黄金海岸']);
  assert.deepEqual(personalGuidePlaces('洛伽寺攻略 https://example.com'),[]);
  assert.deepEqual(personalGuidePlaces('路线 攻略'),[]);
});

test('指定多个地点时，正文可以支持其中一个景点，只有城市名不足以入选',async()=>{
  const first=await searchXhsGuide({query:'洛伽寺 石狮黄金海岸'},guidePage({title:'石狮一日游',body:'从石狮出发，先到洛伽寺入口，再沿海边步道步行回到停车场，全程可安排在同一上午。'}).port);
  const cityOnly=await searchXhsGuide({query:'泉州 洛伽寺 石狮黄金海岸'},guidePage({title:'泉州一日游',body:'从泉州老城出发，沿步道步行到别处景区的入口，再原路返回停车场。'}).port);
  assert.equal(first.sources.length,1);
  assert.equal(cityOnly.sources.length,0);
});

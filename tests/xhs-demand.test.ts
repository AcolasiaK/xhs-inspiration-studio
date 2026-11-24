import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_XHS_RULES, categoryIds, effectiveRules, enabledCategoryIds, xhsRulesSchema, type XhsRules } from '../lib/xhs-hotspot-rules';
import { mergeRuleProposal } from '../lib/xhs-rule-draft';
import { rankQualifiedXhsThemes, semanticRulesKey } from '../lib/xhs-hotspot-ranking';
import { XhsRulesStore, defaultRulesVersion } from '../lib/server/xhs-hotspot-rules-store';
import { XhsHotspotsStore } from '../lib/server/xhs-hotspots-store';
import { collectCategory, type CollectionPort, type XhsCandidate } from '../lib/server/xhs-collection-engine';
import { blankCategory, type XhsNote, type XhsCategoryResult } from '../lib/xhs-hotspots';
import { xhsFixtureAnalysis } from './xhs-fixture';
const now = '2026-11-13T04:00:00.000Z';
const hex = (n: number) => n.toString(16).padStart(24, '0');
function rules(): XhsRules { const r = structuredClone(DEFAULT_XHS_RULES); r.categories.food = { name: '美食', queries: ['早餐'], includeTerms: ['早餐'], topics: [{ name: '十分钟早餐', terms: ['十分钟'] }], minInteractions: 500, minAuthors: 2, minNotes: 2, settings: { autoUpdate: false, windowDays: 30, searchSorts: ['likes','latest'], candidateBudget: 100, detailBudget: 50, cardsPerQuery: 5, scrollsPerQuery: 6 } }; return r; }
const note = (id: number, patch: Partial<XhsNote> = {}): XhsNote => ({ id: hex(id), authorId:hex(id+100), author:'测试作者', title:'十分钟早餐', body:'早餐做法', tags:['早餐'], category:'food', query:'早餐', likes:600, collects:50, comments:10, publishedAt:'2026-11-12T00:00:00.000Z', dateLabel:'昨天', collectedAt:now, url:`https://www.xiaohongshu.com/explore/${hex(id)}`, coverFile:null, coverUrl:null, fingerprint:hex(id), ...patch });
const card = (id: number): XhsCandidate => ({ id:hex(id),authorId:hex(id+100),title:'十分钟早餐',date:'昨天',likes:'600',own:false,top:0 });
const result = (notes: XhsNote[], r: XhsRules): XhsCategoryResult => ({ ...blankCategory(),...rankQualifiedXhsThemes(notes,'food',now,r),notes,collectedAt:now,attemptedAt:now,rankingVersion:3 });

test('custom categories preserve inherited settings, isolate overrides and can all be archived', () => {
 const r=xhsRulesSchema.parse(rules()); assert.ok(categoryIds(r).includes('food'));assert.equal(effectiveRules(r,'food').windowDays,30);assert.equal(effectiveRules(r,'travel').windowDays,7);
 r.categories.food.archived=true;assert.ok(!enabledCategoryIds(r).includes('food'));assert.ok(categoryIds(r,true).includes('food'));
 assert.equal(xhsRulesSchema.safeParse({...r,categories:JSON.parse('{"__proto__":{}}')}).success,false);
 assert.equal(xhsRulesSchema.safeParse({...r,categories:{...r.categories,food:{...r.categories.food,settings:{detailBudget:200,candidateBudget:20}}}}).success,false);
});
test('rule proposals cannot override locked values, names, consent or another category', () => {
 const r=rules(), before=structuredClone(r);r.categories.food.semantic={enabled:false,profileId:'',maxCalls:3};
 const proposal={...r.categories.food,name:'AI改名',semantic:{enabled:true,profileId:'wrong',maxCalls:10},queries:['早餐便当'],minInteractions:100,settings:{...r.categories.food.settings,windowDays:7}};
 const merged=mergeRuleProposal(r,'food',proposal,['minInteractions','settings.windowDays']);
 assert.equal(merged.name,'美食');assert.equal(merged.minInteractions,500);assert.equal(merged.settings?.windowDays,30);assert.deepEqual(merged.queries,['早餐便当']);assert.equal(merged.semantic?.enabled,false);assert.deepEqual(r.categories.travel,before.categories.travel);
});
test('saving a removed category archives it and backs up the old file without changing the read', async () => {
 const dir=await mkdtemp(join(tmpdir(),'xhs-dynamic-rules-')),file=join(dir,'rules.json'),store=new XhsRulesStore(file);
 const initial={...defaultRulesVersion(),rules:rules()};await writeFile(file,JSON.stringify(initial));const bytes=await readFile(file,'utf8');assert.deepEqual((await store.read()).rules.categories.food,initial.rules.categories.food);assert.equal(await readFile(file,'utf8'),bytes);
 const next=rules();delete next.categories.food;const saved=await store.save(next,initial.revision);assert.equal(saved.rules.categories.food.archived,true);assert.equal(await readFile(file+'.before-dynamic','utf8'),bytes);
});
test('new category updates persist across restart and leave old categories untouched', async () => {
 const dir=await mkdtemp(join(tmpdir(),'xhs-dynamic-run-')),file=join(dir,'cache.json'),r=rules(),version={...defaultRulesVersion(),rules:r};const runs:string[][]=[];
 const deps={file,now:()=>new Date(now),readRules:async()=>version,analyze:async()=>xhsFixtureAnalysis,collect:async(time:string,_p:unknown,save:(id:string,v:XhsCategoryResult)=>Promise<void>,ids:string[]=[])=>{runs.push(ids);for(const id of ids)await save(id,id==='food'?result([note(1),note(2)],r):{...blankCategory(),collectedAt:time});}};
 const store=new XhsHotspotsStore(deps);await store.update(true,['travel']);await store.waitForUpdate();const before=(await store.state()).categories.travel;
 await store.update(true,['food']);await store.waitForUpdate();const loaded=await new XhsHotspotsStore(deps).state();assert.equal(loaded.categories.food.themes.length,1);assert.deepEqual(loaded.categories.travel,before);assert.deepEqual(runs.at(-1),['food']);
 r.categories.food.archived=true;await assert.rejects(store.update(true,['food']),/有效的热点分类/);
});
test('collection continues beyond the first card batch, reserves search coverage and publishes early', async () => {
 const r=rules();r.categories.food.settings={...r.categories.food.settings,detailBudget:50};const searches:string[]=[],snapshots:XhsCategoryResult[]=[];let inspections=0;
 const port:CollectionPort={async *search(task){searches.push(task.sort);for(let page=0;page<7;page++)yield Array.from({length:5},(_,i)=>card((task.sort==='likes'?0:100)+page*5+i+1));},async inspect(c){inspections++;return{note:note(parseInt(c.id,16))};}};
 const got=await collectCategory('food',r,now,port,()=>{}, {preview:(_c,v)=>snapshots.push(v)});
 assert.ok(inspections>10,'must exceed two initial 5-card batches');assert.ok(inspections<=50);assert.ok(got.candidateCount<=100);assert.ok(searches.includes('likes')&&searches.includes('latest'));assert.ok(snapshots.some(v=>v.notes.length>0&&v.notes.length<got.notes.length));assert.match(got.run?.stopReason || '',/已达到详情核验预算/);
});
test('targeted supplemental search stays under the original query and supplies a second author', async () => {
 const r=rules();r.categories.food.settings={...r.categories.food.settings,searchSorts:['likes'],topicLimit:1,noNewRounds:2};const tasks:string[]=[];
 const port:CollectionPort={async *search(task){tasks.push(task.query);yield [card(task.supplemental?2:1)];},async inspect(c){return{note:note(parseInt(c.id,16))};}};
 const got=await collectCategory('food',r,now,port,()=>{});assert.equal(got.themes.length,1);assert.ok(tasks.length>=2);assert.equal(got.run?.themeTarget?.status,'shortfall');assert.ok(tasks.every(q=>q.startsWith('早餐')));assert.equal(got.themes[0].authorCount,2);
});
test('cache reuse keeps the actual metric timestamp and an aborted run cannot succeed', async () => {
 const r=rules(),cached=[note(1),note(2)];let inspections=0;
 const port:CollectionPort={async *search(){yield[card(1),card(2)];},async inspect(){inspections++;throw new Error('cache should avoid inspection');}};
 const got=await collectCategory('food',r,now,port,()=>{}, {cachedNotes:cached});assert.equal(inspections,0);assert.equal(got.run?.cacheHits,2);assert.equal(got.notes[0].collectedAt,now);
 const controller=new AbortController();controller.abort(new Error('cancelled'));await assert.rejects(collectCategory('food',r,now,port,()=>{}, {signal:controller.signal}),/cancelled/);
});
test('semantic labels only apply to the current scope and cannot change scores or author requirements', () => {
 const r=rules();r.categories.food.semantic={enabled:true,profileId:'fixture',maxCalls:1};const key=semanticRulesKey(r,'food');const a=note(1,{title:'我的早晨',body:'早餐',topicLabels:[{name:'快速营养早餐',kind:'direction',focus:'快速营养早餐',place:null,evidence:'早餐'}],topicRuleKey:key}),b=note(2,{...a,id:hex(2),authorId:hex(102)});
 const ranked=rankQualifiedXhsThemes([a,b],'food',now,r);assert.equal(ranked.themes[0].title,'快速营养早餐');assert.equal(ranked.themes[0].heat,1320);
 assert.equal(rankQualifiedXhsThemes([a,{...b,authorId:a.authorId}],'food',now,r).themes.length,0);
 r.categories.food.demand='改为晚餐';assert.equal(rankQualifiedXhsThemes([a,b],'food',now,r).themes.length,0);
});
test('first-batch notes can be analyzed while collecting; final writes preserve both results', async () => {
 const dir=await mkdtemp(join(tmpdir(),'xhs-preview-analysis-')),r=rules();let proceed!:()=>void;const barrier=new Promise<void>(resolve=>{proceed=resolve;});
 const store=new XhsHotspotsStore({file:join(dir,'cache.json'),now:()=>new Date(now),readRules:async()=>({...defaultRulesVersion(),rules:r}),analyze:async n=>({...xhsFixtureAnalysis,noteId:n.id,fingerprint:n.fingerprint}),collect:async(_time,_p,save,_ids,_rules,context)=>{context?.preview?.('food',result([note(1),note(2)],r));await barrier;await save('food',result([note(1),note(2)],r));}});
 await store.update(true,['food']);assert.equal((await store.state()).previews?.food.themes.length,1);assert.equal((await store.state()).categories.food.themes.length,0);
 await store.analyze(note(1).id,'fixture');proceed();await store.waitForUpdate();const state=await store.state();assert.equal(state.categories.food.themes.length,1);assert.equal(state.analyses[note(1).id].fingerprint,note(1).fingerprint);assert.equal(state.previews?.food,undefined);
});

test('cancelling a running category retains its successful list and analyzed preview', async () => {
 const dir=await mkdtemp(join(tmpdir(),'xhs-cancel-run-')),r=rules();let calls=0;
 const store=new XhsHotspotsStore({file:join(dir,'cache.json'),now:()=>new Date(now),readRules:async()=>({...defaultRulesVersion(),rules:r}),analyze:async n=>({...xhsFixtureAnalysis,noteId:n.id,fingerprint:n.fingerprint}),collect:async(_time,_p,save,_ids,_rules,context)=>{
  if(!calls++){await save('food',result([note(1),note(2)],r));return;}
  context?.preview?.('food',result([note(3),note(4)],r));
  await new Promise<void>((_resolve,reject)=>{context!.signal!.addEventListener('abort',()=>reject(context!.signal!.reason),{once:true});});
 }});
 await store.update(true,['food']);await store.waitForUpdate();await store.update(true,['food']);await store.analyze(note(3).id,'fixture');await store.cancel();await store.waitForUpdate();const state=await store.state();
 assert.equal(state.updating,false);assert.equal(state.categories.food.notes[0].id,note(1).id);assert.equal(state.previews?.food.notes[0].id,note(3).id);assert.ok(state.analyses[note(3).id]);assert.match(state.categories.food.error!,/已停止/);
});

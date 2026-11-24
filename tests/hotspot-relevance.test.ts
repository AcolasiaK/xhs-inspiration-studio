import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessHotspot,selectRelevantHotspots} from '../lib/hotspot-relevance';
import type {Hotspot} from '../lib/server/hotspots-types';
const now='2026-11-02T04:00:00.000Z';
const make=(title:string,description='',rank=20):Hotspot=>({id:title,title,description,rank,source:'百度热搜',url:`https://www.baidu.com/s?wd=${encodeURIComponent(title)}`,publishedAt:null,collectedAt:now});

test('旅行、日常和情绪允许交叉归类，国内国外不以地点名单过滤',()=>{
 for(const place of ['南京','京都','奥克兰','布宜诺斯艾利斯']){
  const result=assessHotspot(make(`${place}周末城市漫步：慢下来感受生活`),now)!;
  assert.ok(result.directions.includes('travel'));assert.ok(result.directions.includes('daily'));assert.ok(result.directions.includes('emotion'));
 }
});
test('同时考虑标题与摘要的场景，不把没有主题关联的孤立词当作入选证据',()=>{
 assert.ok(assessHotspot(make('从看热闹到看门道','参观博物馆时预约讲解，公众体验文化展览。'),now));
 assert.ok(assessHotspot(make('小镇降温后的新景象','河岸迎来雾凇景观。'),now));
 assert.equal(assessHotspot(make('全球指数波动','研究报告目录：旅行、咖啡、周末。'),now),null);
 assert.equal(assessHotspot(make('热门公司发布财报','公司有咖啡业务。'),now),null);
});
test('高热事故、争议、医疗与明星赛事不借生活词强行入选',()=>{
 const titles=['旅游大巴事故','休息日爬山后遭辞退','明星恋情引发讨论','球员3比1夺冠','咖啡治疗疾病','游客遭诈骗','高铁上和乘客干架','246万买邮轮永居权被要求离船','景区6万元招3名冰雪体验官'];
 for(const title of titles) assert.equal(assessHotspot(make(title,'周末一起参观博物馆，慢下来感受生活。',1),now),null,title);
 // An event with an explicit public travel use remains eligible even if sports-related.
 assert.ok(assessHotspot(make('世界杯场馆向游客开放预约参观','公众可以体验体育展览。',30),now));
});
test('相关性高于原榜排名，规则只返回有依据条目且不凑十条',()=>{
 const output=selectRelevantHotspots([make('明星恋情', '',1),make('海外签证政策调整','入境条件发生变化。',2),make('周末城市漫步：和朋友一起放慢生活节奏','分享自己日常散步的感受。',48)],now);
 assert.equal(output.length,2);assert.equal(output[0].rank,48);assert.equal(output[1].rank,2);
 assert.deepEqual(output[0].editorial?.directions.sort(),['daily','emotion','travel']);
});
test('季节话题与近期讨论分开，获取时间不伪造为发布时间',()=>{
 const seasonal=make('秋日周末赏银杏','公园进入观赏季，沿河散步看风景。');
 const item=selectRelevantHotspots([seasonal],now)[0];assert.equal(item.editorial?.kind,'seasonal');assert.equal(item.publishedAt,null);assert.match(item.editorial!.verification,/时段待核实/);
 assert.equal(assessHotspot(make('周末把时间留给自己','下班后的休息习惯与日常感受。'),now)?.kind,'discussion');
 const old={...seasonal,publishedAt:'2025-11-02T00:00:00Z'};
 assert.ok(assessHotspot(old,now)!.score.timeliness<assessHotspot(seasonal,now)!.score.timeliness);
});
test('入选原因和角度有证据、不假定用户经历、不把签证或票价当核实事实',()=>{
 const travel=assessHotspot(make('海外目的地免签政策调整','游客需要确认入境条件和机票费用。'),now)!;
 assert.match(travel.verification,/使领馆/);assert.match(travel.verification,/待核实/);assert.equal(travel.angles.length,1);assert.ok(travel.evidence.every(e=>e.includes('免签')||e.includes('入境')));
 const mood=assessHotspot(make('朋友之间的距离与日常相处','周末见面时留出各自休息时间。'),now)!;
 assert.ok(mood.angles.length<=2);assert.ok(mood.angles.some(a=>/如果|若|可/.test(a)));assert.doesNotMatch(mood.reason,/全网|爆款|小红书热度/);
});

test('扩大生活方式召回，单个方向也可入选，主旨在摘要中不要求两组分类',()=>{
 const cases=[
  ['拐弯指路牌更新','地铁站焕新的指路牌让旅客一眼看懂转弯方向。','travel'],
  ['第一场雪给大鹅冻得坐下了','当地迎来第一场雪，气温下降。','daily'],
  ['儿童手表充电线不通用','配件使用不便，家长购买时需要分别选购。','daily'],
  ['这份轻松从哪里来','受访者谈及容貌焦虑，鼓励自己用不同方式表达。','emotion'],
  ['周末新电影上映','故事通过邻里日常表达细腻的生活感受。','emotion'],
  ['社区游泳场地向市民开放','业余爱好者可预约体验。','daily'],
  ['上班与休假的边界','安排年假时留出自己的休息时间。','emotion'],
  ['新街区迎来公共空间改造','市民可在绿道散步。','travel'],
 ];
 for(const [title,description,direction] of cases){const result=assessHotspot(make(title,description),now);assert.ok(result,title);assert.ok(result.directions.includes(direction as 'travel'|'daily'|'emotion'),title);}
 assert.equal(assessHotspot(make('儿童手表充电线不通用','配件使用不便。'),now)?.fit,'extended');
 assert.equal(assessHotspot(make('演员的新电影上映','影片故事有明确的家庭表达。'),now)?.fit,'extended');
 assert.equal(assessHotspot(make('歌手演唱会宣布要当爷爷','生活记录与感受。'),now),null);
 assert.equal(assessHotspot(make('生活空间新变化','记者确认现场发生事故造成伤亡。'),now),null);
});
test('直接相关优先于延伸，同档通过场景和方向多样性降低单一类别霸榜',()=>{
 const shopping=make('儿童手表充电线不通用','使用配件带来不便。',1);
 const travel=make('海外旅行路线规划','规划行程与实际旅行体验。',50);
 assert.equal(selectRelevantHotspots([shopping,travel],now)[0].title,travel.title);
 const homes=Array.from({length:8},(_,i)=>make(`第${i}套厨房空间布置分享`,'自己的家居格局设计和生活体验。',i+1));
 const emotion=make('朋友之间的距离与日常相处','周末见面时留出自己的休息时间。',40);
 const selected=selectRelevantHotspots([...homes,emotion,travel],now);
 assert.ok(selected.findIndex(i=>i.title===emotion.title)<4);
 assert.ok(selected.findIndex(i=>i.title===travel.title)<6);
 assert.equal(selected.length,10);
});
test('同一事件的近重复角度去重，保留不同场景角度和不同城市事件',()=>{
 const description='南京滨江公园正式开放，市民可预约参观园内文化展览，沿河游览并体验新开放的公共空间。';
 const a=make('南京滨江公园正式开放参观',description,2);
 const b=make('南京滨江公园正式开放参观了',description,9);
 const distinct=make('南京滨江公园旁新增地铁线路','通勤地铁开通新线路，沿途可以看到公园。',10);
 const otherCity=make('苏州滨江公园正式开放参观','苏州新城水岸绿地举办手工市集，居民可以体验陶艺制作与周末休闲活动。',11);
 const selected=selectRelevantHotspots([a,b,distinct,otherCity],now);
 assert.equal(selected.length,3);assert.ok(selected.some(i=>i.id===distinct.id));assert.ok(selected.some(i=>i.id===otherCity.id));
 const duplicateId={...a,title:'同一条来源的另一显示名'};assert.equal(selectRelevantHotspots([a,duplicateId],now).length,1);
});

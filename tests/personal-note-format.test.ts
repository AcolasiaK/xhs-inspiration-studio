import test from "node:test";
import assert from "node:assert/strict";
import { finishPersonalTag, personalTagEntries, personalTagsCanRewriteOne, formatPersonalBodyAndTags, formatPersonalAll, plainPersonalBody } from "../lib/personal/note-format";

test("旧的合并话题可逐项展示，原数组不改写，不吞掉重复或未完成文本",()=>{
  const old=['##日常 #日常 #未完成! #'];
  assert.deepEqual(personalTagEntries(old),['##日常','#日常','#未完成!','#']);
  assert.deepEqual(old,['##日常 #日常 #未完成! #']);
  const tooMany=[Array.from({length:13},(_,i)=>`#话题${i}`).join(' ')];
  assert.deepEqual(personalTagEntries(tooMany),tooMany);
});

test("失焦只规范一个完整话题，不切开正在输入的多词内容",()=>{
  assert.equal(finishPersonalTag('  ＃＃周末日常  '),'#周末日常');
  for(const value of ['', '#', '#一个 #另一个', '#表情🙂','#重复 #重复'])assert.equal(finishPersonalTag(value),value);
});

test("单项重写仅接受与十个规范索引一一对应的输入",()=>{
 const tags=Array.from({length:10},(_,i)=>`#话题${i}`);
 assert.ok(personalTagsCanRewriteOne(tags));
 for(const value of [[tags.join(' ')],[...tags,''],[...tags,tags[0]],tags.slice(1),[...tags.slice(1),'#错!']])assert.equal(personalTagsCanRewriteOne(value),false);
 assert.ok(personalTagsCanRewriteOne(personalTagEntries([tags.join(' ')])));
});

test("个人正文话题复制没有标题依赖，保留正文段落和规范话题",()=>{
 const note={body:'第一段\n\n第二段',hashtags:['##周末','#周末',' ＃生活 '],titles:['不该自动复制的标题'],selectedTitleIndex:0};
 assert.equal(formatPersonalBodyAndTags(note),'第一段\n\n第二段\n\n#周末 #生活');
});

test("旧稿正文复制清除星号和 Markdown，同时保留正文信息、空行和话题",()=>{
 const body = "## 大理交通 ##\r\n\r\n**第一天**：进古城。\r\n* 步行约 3 公里。\r\n\r\n\\*第二天去三塔。\r\n带 2 * 3 瓶水。";
 const expected = "大理交通\n\n第一天：进古城。\n步行约 3 公里。\n\n第二天去三塔。\n带 2乘以3 瓶水。";
 const note={body,hashtags:["#大理"],titles:["旧标题"],coverCopy:{headline:"",subline:""},imageCaptions:[],warnings:[]};
 assert.equal(plainPersonalBody(body),expected);
 assert.equal(formatPersonalBodyAndTags(note),expected+"\n\n#大理");
 assert.ok(formatPersonalAll(note).includes("【正文】\n"+expected+"\n\n【话题】\n#大理"));
 assert.equal(note.body,body);
});

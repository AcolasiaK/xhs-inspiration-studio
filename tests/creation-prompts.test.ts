import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyBrief } from "../lib/schema";
import { buildUserPrompt, SYSTEM_PROMPT } from "../lib/prompt";
import { buildRewritePrompt } from "../lib/rewrite-prompt";
import { validateResult } from "../lib/validate-result";
import { createDemoResult } from "../lib/demo";
import { extractStyle } from "../lib/server/style-extract";

test("创作类型的主次与侧重同时传入，其他类型不继承环游中国长度规则",()=>{
  const base={...emptyBrief,topic:"春日散步",creationTypes:["travel","emotion"] as ("travel"|"emotion")[],primaryType:"emotion" as const,travelFocus:"guide" as const};
  const prompt=buildUserPrompt(base);assert.match(prompt,/主要类型：情绪表达/);assert.match(prompt,/辅助类型：旅行攻略/);assert.match(prompt,/侧重真实可执行的攻略信息/);assert.doesNotMatch(prompt,/125 天|最多 1000 字符/);
  for(const [focus,expected] of [["experience","侧重行程记录和感受"],["guide","侧重真实可执行的攻略信息"],["balanced","行程感受与实用攻略均衡"]] as const)assert.ok(buildUserPrompt({...base,travelFocus:focus}).includes(expected));
  for(const [focus,expected] of [["auto","根据本次主题决定"],["reflection","生活感悟"],["record","轻松记录"]] as const)assert.ok(buildUserPrompt({...emptyBrief,topic:"日常",dailyFocus:focus}).includes(expected));
  assert.match(SYSTEM_PROMPT,/至少两行/);
});

test("路线与费用提示仅按所选风格和当前创作者提供的主题启用",()=>{
 const base={...emptyBrief,topic:"周末环游路线和花费"};
 const china={...base,creationTypes:["china"] as "china"[],primaryType:"china" as const};
 assert.doesNotMatch(buildUserPrompt(base),/路线写作：|费用写作：/);
 assert.match(buildUserPrompt(china),/路线写作：/);
 assert.match(buildUserPrompt(china),/费用写作：/);
 assert.match(buildRewritePrompt(china,"正文","natural",""),/只使用本稿明确给出的金额/);
 assert.doesNotMatch(buildUserPrompt({...china,topic:"一个安静的今天",details:"",supplementTravel:""}),/路线写作：|费用写作：/);
});

test("所有发布标题最多 20 字，环游中国另校验正文加话题长度",()=>{
 const id=randomUUID(), result=createDemoResult([id]); result.titles[0]="一".repeat(21);
 const china={...emptyBrief,topic:"主题",creationTypes:["china"] as "china"[],primaryType:"china" as const,emoji:true};
 assert.throws(()=>validateResult(result,[id],china),/标题不超过 20/);
 assert.throws(()=>validateResult(result,[id],{...emptyBrief,topic:"主题"}),/标题不超过 20/);
 result.titles[0]="标题";result.body="这".repeat(1000);
 assert.throws(()=>validateResult(result,[id],china),/不超过 1000/);
});

test("模拟模型提取风格，空方向综合提取，不保存参考事实并阻止长段原文",async()=>{
 const prev={key:process.env.OPENAI_API_KEY,model:process.env.OPENAI_MODEL,base:process.env.OPENAI_BASE_URL};
 process.env.OPENAI_API_KEY="synthetic-key";process.env.OPENAI_MODEL="synthetic-model";delete process.env.OPENAI_BASE_URL;
 let notes="自然口语，段落短，用具体画面表达感受";
 const fetcher=mock.method(globalThis,"fetch",async()=>Response.json({id:"synthetic",object:"response",status:"completed",output:[{id:"m",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({tone:"自然分享",length:"medium",emoji:false,styleNotes:notes}),annotations:[]}]}]}));
 try {
  const input={referenceText:"这是一段仅供测试的非常长的原始句子不能复制到新的风格里",referenceAspects:[]};
  const style=await extractStyle(input,new AbortController().signal);
  assert.equal(style.audience,"");assert.equal(style.forbidden,"");assert.match(style.styleNotes,/自然口语/);assert.equal(fetcher.mock.callCount(),1);
  notes="这是一段仅供测试的非常长的原始句子不能复制到新的风格里";
  await assert.rejects(extractStyle(input,new AbortController().signal),/含过长原文/);
 } finally {fetcher.mock.restore();if(prev.key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prev.key;if(prev.model===undefined)delete process.env.OPENAI_MODEL;else process.env.OPENAI_MODEL=prev.model;if(prev.base===undefined)delete process.env.OPENAI_BASE_URL;else process.env.OPENAI_BASE_URL=prev.base;}
});

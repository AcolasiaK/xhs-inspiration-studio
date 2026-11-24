import { mockSearchBrowser } from "./browser-search-fixture";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyPersonalInput, personalRequestSchema } from "../lib/personal/schema";
import { runPersonal, validatePersonalResult } from "../lib/server/personal";
import { personalDraftFromHotspot } from "../lib/personal/hotspot-transfer";

const input={...emptyPersonalInput,experience:"今天看见一只红色杯子",topic:"日常",requirements:"自然一点"};
const tags=Array.from({length:10},(_,i)=>`#日常${i}`);
const note={titles:["标题一","标题二","标题三","标题四","标题五"],coverCopy:{headline:"封面",subline:"副标题"},imageCaptions:[],body:"第一段。\n\n第二段。",hashtags:tags,warnings:[]};
function response(value:unknown){return Response.json({id:"test",object:"response",created_at:1,model:"test",status:"completed",error:null,incomplete_details:null,output:[{id:"message",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify(value),annotations:[]}]}]});}
test("热点参考独立传入提示词、正文和重写；公共事实不能当成个人经历，来源不进入正文",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  const requests:string[]=[];const net=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{const body=String(init?.body);requests.push(body);return response(body.includes("personal_prompt")?{prompt:"公共报道仅作背景，依据本人观察写作。",writingPlan:"从用户自己提供的日常观察切入，用个人感受组织段落，公共报道仅作背景线索。",coreIntent:"记录自己的日常观察"}:body.includes("personal_rewrite")?{body:"重写的测试正文",titles:[],imageCaptions:[],hashtags:[]}:note);});
  try{
    const draft=personalDraftFromHotspot({id:"test",title:"合成公共报道",description:"他人的公共活动",source:"测试来源",url:"https://example.com/public",collectedAt:"2026-11-02T00:00:00.000Z",publishedAt:null,rank:1});
    draft.input.experience="我自己的日常观察";
    const request=personalRequestSchema.parse({action:"prompt",input:draft.input,imageIds:[]});
    await runPersonal(request,[],new AbortController().signal);
    await runPersonal({...request,action:"generate",confirmedPrompt:"用户确认的写作安排"},[],new AbortController().signal);
    await runPersonal({...request,action:"rewrite",confirmedPrompt:"用户确认的写作安排",rewrite:{target:"body",direction:"natural",instruction:"",current:note}},[],new AbortController().signal);
    assert.equal(requests.length,3);
    for(const body of requests){assert.match(body,/hotspotReference/);assert.match(body,/合成公共报道/);assert.match(body,/我自己的日常观察/);assert.match(body,/不是用户亲身经历/);}
    assert.throws(()=>validatePersonalResult({...note,body:"参考 https://example.com/public"},[],draft.input),/混入参考/);
  }finally{net.mock.restore();process.env=previous;}
});
test("个人创作无图与有图均可生成，确认提示词参与且图片不进入正文请求",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  let n=0;const requests:unknown[]=[];const id=randomUUID();
  const network=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{const data=JSON.parse(String(init?.body));requests.push(data);n++;return response(n===1||n===2?note:{imageCaptions:[{imageId:id,headline:"",description:"红色的杯子\n桌上一角"}]});});
  try{
    const noImages=personalRequestSchema.parse({action:"generate",input,imageIds:[],confirmedPrompt:"用户编辑确认的提示词"});
    const a=await runPersonal(noImages,[],new AbortController().signal);assert.ok("result" in a);if("result" in a)assert.equal(a.result.imageCaptions.length,0);
    const withImages=personalRequestSchema.parse({...noImages,imageIds:[id]});
    const b=await runPersonal(withImages,[{id,dataUrl:"data:image/jpeg;base64,dGVzdA=="}],new AbortController().signal);assert.ok("result" in b);if("result" in b)assert.equal(b.result.imageCaptions[0].imageId,id);
    assert.equal(n,3);assert.match(JSON.stringify(requests[0]),/用户编辑确认的提示词/);assert.doesNotMatch(JSON.stringify(requests[1]),/input_image/);assert.match(JSON.stringify(requests[2]),/input_image/);
  }finally{network.mock.restore();process.env=previous;}
});
test("个人创作约束拒绝缺失经历、重复话题、图片错位与未确认提示词",()=>{
  assert.equal(personalRequestSchema.safeParse({action:"prompt",input:{...input,experience:" "},imageIds:[]}).success,false);
  assert.equal(personalRequestSchema.safeParse({action:"generate",input,imageIds:[]}).success,false);
  assert.throws(()=>validatePersonalResult({...note,hashtags:[...tags.slice(0,9),tags[0]]},[],input));
  assert.throws(()=>validatePersonalResult({...note,imageCaptions:[]},[randomUUID()],input));
  assert.throws(()=>validatePersonalResult({...note,body:"正文混入 https://example.gov.cn/info"},[],input,{status:"success",retrievedAt:"2026-10-31T00:00:00.000Z",notice:"资料",sources:[{title:"来源",source:"example.gov.cn",url:"https://example.gov.cn/info",snippet:"资料"}]}));
});
test("提示词以已选风格与真实性生成，关闭检索不请求搜索服务",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  const bodies:string[]=[];const net=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{bodies.push(String(init?.body));return response({prompt:"确认的提示词",writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent:"记录当下的感受"});});
  try{
    const action=personalRequestSchema.parse({action:"prompt",input:{...input,truth:"creative",styles:["emotion"],referenceText:"仅参考写法"},imageIds:[]});
    const result=await runPersonal(action,[],new AbortController().signal);assert.ok("prompt" in result);assert.equal(result.research?.status,"disabled");assert.match(bodies[0],/创意发挥/);assert.match(bodies[0],/情绪表达/);assert.doesNotMatch(bodies[0],/路线写作：/);
    const china=personalRequestSchema.parse({action:"prompt",input:{...input,topic:"环游中国总路线",styles:["china"],truth:"truthful"},imageIds:[]});await runPersonal(china,[],new AbortController().signal);assert.match(bodies[1],/真实润色/);assert.match(bodies[1],/路线写作：/);assert.equal(bodies.length,2);
  }finally{net.mock.restore();process.env=previous;}
});
test("正文长度和单一风格在提示词、确认生成和正文重写中传递，旧输入有安全默认",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  const requests:string[]=[];const net=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{const body=String(init?.body);requests.push(body);return response(body.includes("personal_prompt")?{prompt:"模拟提示词",writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent:"在日常里发现平静"}:body.includes("personal_rewrite")?{body:"模拟重写正文",titles:[],imageCaptions:[],hashtags:[]}:note);});
  try{
    const {bodyLength: _length,customLength: _custom,...legacy}=input;void _length;void _custom;
    const old=personalRequestSchema.parse({action:"prompt",input:legacy,imageIds:[]});assert.equal(old.input.bodyLength,"auto");assert.equal(old.input.customLength,500);
    const mixed={...input,styles:["travel"] as const,bodyLength:"custom" as const,customLength:620,customStyle:"更口语化",referenceText:"测试文案",referenceAspects:["tone"]};
    const prompt=personalRequestSchema.parse({action:"prompt",input:mixed,imageIds:[]});await runPersonal(prompt,[],new AbortController().signal);
    const generated=personalRequestSchema.parse({action:"generate",input:mixed,imageIds:[],confirmedPrompt:"用户编辑后要求写作的版本"});await runPersonal(generated,[],new AbortController().signal);
    const rewritten=personalRequestSchema.parse({...generated,action:"rewrite",rewrite:{target:"body",direction:"natural",instruction:"",current:note}});await runPersonal(rewritten,[],new AbortController().signal);
    for(const body of requests){assert.match(body,/旅行攻略/);assert.doesNotMatch(body,/情绪表达：|日常分享：/);assert.match(body,/约 620 字/);assert.match(body,/更口语化/);assert.doesNotMatch(body,/路线写作：/);}
    assert.match(requests[1],/用户编辑后要求写作的版本/);assert.match(requests[2],/用户编辑后要求写作的版本/);
    assert.equal(personalRequestSchema.safeParse({action:"prompt",input:{...input,bodyLength:"custom",customLength:99},imageIds:[]}).success,false);
  }finally{net.mock.restore();process.env=previous;}
});
test("环游中国默认篇幅是偏好，允许用户明确选择更长正文",()=>{
  const china={...input,styles:["china"] as const,bodyLength:"custom" as const,customLength:1200};
  const parsed=personalRequestSchema.parse({action:"generate",input:china,imageIds:[],confirmedPrompt:"正文约 1200 字"});
  const result=validatePersonalResult({...note,body:"可验证内容".repeat(220)},[],parsed.input);
  assert.ok(result.body.length>1000);
  assert.throws(()=>validatePersonalResult({...note,titles:["标题".repeat(11),...note.titles.slice(1)]},[],parsed.input),/标题超出长度/);
});
test("正文重写按确认快照，不把图片及其配文作为正文事实",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  let sent="";const net=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{sent=String(init?.body);return response({body:"新的正文",titles:[],imageCaptions:[],hashtags:[]});});
  try{
    const id=randomUUID();const current={...note,imageCaptions:[{imageId:id,headline:"图片独有事实",description:"图片独有内容\n第二行"}]};
    const action=personalRequestSchema.parse({action:"rewrite",input,imageIds:[id],confirmedPrompt:"用户最终确认",rewrite:{target:"body",direction:"natural",instruction:"",current}});
    const result=await runPersonal(action,[{id,dataUrl:"data:image/jpeg;base64,dGVzdA=="}],new AbortController().signal);assert.ok("rewrite" in result);assert.match(sent,/用户最终确认/);assert.doesNotMatch(sent,/input_image|图片独有事实|图片独有内容/);
  }finally{net.mock.restore();process.env=previous;}
});
test("联网检索优先检索词，否则使用同次提示词生成提取的公开词，不发送经历原文",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";process.env.BOCHA_API_KEY="synthetic-search";delete process.env.OPENAI_BASE_URL;
  const searches:string[]=[];const browser=mockSearchBrowser(query=>{searches.push(query);return [];});const net=mock.method(globalThis,"fetch",async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(String(url).includes("bochaai.com")){searches.push(String(init?.body));return Response.json({code:200,data:{webPages:{value:[]}}});}
    const sent=JSON.parse(String(init?.body));
    const material=JSON.parse(sent.input.find((item:{role:string})=>item.role==="user").content[0].text);
    return response({prompt:"用于测试的提示词",writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent:"旅行中的放松",guideScope:"segment",searchQuery:material.context.input.topic?"杭州 西湖":""});
  });
  try{
    const base={...input,experience:"私人经历不发送搜索",search:true,topic:"杭州西湖"};
    const explicit=personalRequestSchema.parse({action:"prompt",input:{...base,searchPlace:"苏州园林"},imageIds:[]});await runPersonal(explicit,[],new AbortController().signal);
    const explicitSearches=searches.splice(0);
    const fallback=personalRequestSchema.parse({action:"prompt",input:{...base,searchPlace:""},imageIds:[]});await runPersonal(fallback,[],new AbortController().signal);
    const missing=personalRequestSchema.parse({action:"prompt",input:{...base,searchPlace:"",topic:""},imageIds:[]});const result=await runPersonal(missing,[],new AbortController().signal);
    assert.ok(explicitSearches.length && explicitSearches.every(query=>query.startsWith("苏州园林 ")));assert.doesNotMatch(explicitSearches.join(" "),/杭州西湖|私人经历/);assert.ok(searches.length && searches.every(query=>query.startsWith("杭州 西湖 ")));assert.doesNotMatch(searches.join(" "),/私人经历/);assert.equal(result.research?.status,"missing_place");
  }finally{browser.mock.restore();net.mock.restore();process.env=previous;}
});
test("七类局部重写各自验证数量和目标，读取确认快照与用户最新编辑",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  const imageIds=[randomUUID(),randomUUID()];const images=imageIds.map(id=>({id,dataUrl:"data:image/jpeg;base64,dGVzdA=="}));
  const oldIntent="第一步合成的旧方向",confirmedPrompt="【核心感受或观点】\n用户手动修改的已确认提示词";
  const current={...note,titles:["用户改过标题","原标题二","原标题三","原标题四","原标题五"],body:"用户修改后的最新正文",imageCaptions:imageIds.map(imageId=>({imageId,headline:"用户已改配文",description:"第一行\n第二行"}))};
  const responses={
    body:{body:"新的正文",titles:[],imageCaptions:[],hashtags:[]},
    title_one:{body:"",titles:["候选一","候选二","候选三"],imageCaptions:[],hashtags:[]},
    titles_all:{body:"",titles:["新标题一","新标题二","新标题三","新标题四","新标题五"],imageCaptions:[],hashtags:[]},
    caption_one:{body:"",titles:[],imageCaptions:[{imageId:imageIds[0],headline:"",description:"第一行\n第二行"}],hashtags:[]},
    captions_all:{body:"",titles:[],imageCaptions:imageIds.map(imageId=>({imageId,headline:"",description:"第一行\n第二行"})),hashtags:[]},
    tag_one:{body:"",titles:[],imageCaptions:[],hashtags:["#新话题甲","#新话题乙","#新话题丙"]},
    tags_all:{body:"",titles:[],imageCaptions:[],hashtags:Array.from({length:10},(_,i)=>`#新话题${i}`)},
  };
  let value:unknown={},sent="",calls=0;const net=mock.method(globalThis,"fetch",async(_url:RequestInfo|URL,init?:RequestInit)=>{calls++;sent=String(init?.body);return response(value);});
  try{
    for(const target of Object.keys(responses) as (keyof typeof responses)[]){
      const isCaption=target==="caption_one"||target==="captions_all",ids=isCaption?imageIds:[],sourceCurrent=isCaption?current:{...current,imageCaptions:[]};
      value=responses[target];const action=personalRequestSchema.parse({action:"rewrite",input:{...input,coreIntent:oldIntent},imageIds:ids,confirmedPrompt,rewrite:{target,targetIndex:0,targetImageId:isCaption?imageIds[0]:undefined,direction:"natural",instruction:"保留最新修改",current:sourceCurrent}});
      const result=await runPersonal(action,isCaption?images:[],new AbortController().signal);assert.ok("rewrite" in result,`target=${target}`);assert.match(sent,/用户手动修改的已确认提示词/);assert.match(sent,/用户修改后的最新正文/);assert.match(sent,/用户改过标题/);
      const material=JSON.parse(JSON.parse(sent).input.find((item:{role:string})=>item.role==="user").content[0].text);
      assert.equal(material.confirmedPrompt,confirmedPrompt);assert.equal("coreIntent" in material.context.input,false);assert.doesNotMatch(sent,new RegExp(oldIntent,"u"));
      if(isCaption)assert.match(sent,/input_image/);else assert.doesNotMatch(sent,/input_image/);
    }
    assert.equal(calls,7);
    const invalid=personalRequestSchema.parse({action:"rewrite",input,imageIds:[],confirmedPrompt:"确认",rewrite:{target:"title_one",targetIndex:0,direction:"natural",instruction:"",current:{...current,imageCaptions:[]}}});value={...responses.title_one,titles:["不足一","不足二"]};await assert.rejects(runPersonal(invalid,[],new AbortController().signal),/标题/);
    const wrongId=personalRequestSchema.parse({action:"rewrite",input,imageIds,confirmedPrompt:"确认",rewrite:{target:"caption_one",targetImageId:imageIds[0],direction:"natural",instruction:"",current}});value={...responses.caption_one,imageCaptions:[{imageId:randomUUID(),headline:"",description:"一行\n二行"}]};await assert.rejects(runPersonal(wrongId,images,new AbortController().signal),/图片配文/);
    const duplicate=personalRequestSchema.parse({action:"rewrite",input,imageIds:[],confirmedPrompt:"确认",rewrite:{target:"tag_one",targetIndex:0,direction:"natural",instruction:"",current:{...current,imageCaptions:[]}}});value={...responses.tag_one,hashtags:["#新话题","#新话题","#日常1"]};await assert.rejects(runPersonal(duplicate,[],new AbortController().signal),/话题候选/);
  }finally{net.mock.restore();process.env=previous;}
});
test("重写服务失败或取消时不重试、不切换 AI 来源",async()=>{
  const previous={...process.env};process.env.APP_MODE="local";process.env.APP_LOCAL_ONLY="1";process.env.OPENAI_API_KEY="test";process.env.OPENAI_MODEL="test";delete process.env.OPENAI_BASE_URL;
  let calls=0;const net=mock.method(globalThis,"fetch",async(url:RequestInfo|URL)=>{calls++;assert.equal(String(url),"https://api.openai.com/v1/responses");return Response.json({error:{message:"synthetic failure"}},{status:502});});
  try{const action=personalRequestSchema.parse({action:"rewrite",input,imageIds:[],confirmedPrompt:"确认",rewrite:{target:"body",direction:"natural",instruction:"",current:note}});await assert.rejects(runPersonal(action,[],new AbortController().signal));assert.equal(calls,1);const controller=new AbortController();controller.abort();await assert.rejects(runPersonal(action,[],controller.signal));assert.equal(calls,1);}finally{net.mock.restore();process.env=previous;}
});

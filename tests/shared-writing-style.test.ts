import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { builtinRuleSnapshot, emptyRuleContent } from "../lib/personal/style-rules";
import { newDraft, serializeDraft, storedDraftSchema, inputSnapshot } from "../lib/drafts";
import { newVideoDraft, videoDraftSchema, snapshotVideo } from "../lib/video/drafts";
import { createDemoResult } from "../lib/demo";
import { emptyBrief } from "../lib/schema";
import { buildUserPrompt } from "../lib/prompt";
import { buildRewritePrompt } from "../lib/rewrite-prompt";
import { buildPartialRewritePrompt } from "../lib/partial-rewrite-prompt";
import { videoUserPrompt } from "../lib/video/prompt";
import { validateResult } from "../lib/validate-result";
import { validatePartialResult } from "../lib/server/partial-rewrite";
import { submitGeneration } from "../lib/generation-request";
import { activatePersonalStyle, bindWritingStyle, createPersonalStyle, deletePersonalStyle, savePersonalStyle } from "../lib/server/personal-style-store";

test("图文与视频草稿及生成快照保留所选规则版本，旧草稿仍能读取", () => {
  const writingStyle = builtinRuleSnapshot("emotion");
  const draft = newDraft();
  draft.brief.writingStyle = writingStyle;
  assert.deepEqual(storedDraftSchema.parse(serializeDraft(draft, 0)).brief.writingStyle, writingStyle);
  assert.deepEqual(inputSnapshot(draft).brief.writingStyle, writingStyle);
  const video = newVideoDraft(); video.brief.writingStyle = writingStyle;
  assert.deepEqual(videoDraftSchema.parse(video).brief.writingStyle, writingStyle);
  assert.deepEqual(snapshotVideo(video).brief.writingStyle, writingStyle);
  assert.equal(storedDraftSchema.parse(serializeDraft(newDraft(), 0)).brief.writingStyle, undefined);
  assert.equal(videoDraftSchema.parse(newVideoDraft()).brief.style, "自然分享");
});

test("同一份风格的各栏目进入图文生成、重写与视频提示，视频保留时长和素材约束", () => {
  const writingStyle = builtinRuleSnapshot("emotion");
  writingStyle.content.sections = { overall:"整体规则标记",title:"标题规则标记",body:"正文规则标记",captions:"配文规则标记",avoid:"避免规则标记" };
  const brief = { ...emptyBrief, topic:"测试主题", writingStyle };
  const id = randomUUID(), current = createDemoResult([id]);
  const partial = { brief, mode:"live" as const, imageIds:[id], target:"caption_one" as const,targetImageId:id,direction:"natural" as const,instruction:"",current };
  const video = newVideoDraft(); video.brief.writingStyle = writingStyle;
  const videoPrompt = videoUserPrompt({ action:"generate", input:snapshotVideo(video),current:null,targetId:"",instruction:"" });
  for (const prompt of [buildUserPrompt(brief),buildRewritePrompt(brief,"原正文","natural",""),buildPartialRewritePrompt(partial),videoPrompt]) {
    for (const value of Object.values(writingStyle.content.sections)) assert(prompt.includes(value));
  }
  assert(videoPrompt.includes("口播和字幕按镜头时长控制"));
  assert.equal(JSON.parse(videoPrompt).brief.style, undefined);
  assert.match(buildPartialRewritePrompt(partial), /headline 为空字符串/);
});

test("托管风格配文沿用个人创作规则，情绪允许单段，旧模式仍要求短标题", () => {
  const id = randomUUID(), result = createDemoResult([id]);
  result.imageCaptions = [{imageId:id,headline:"",description:"这一刻我只想静静看看窗外，慢慢记住眼前的光。"}];
  const brief = {...emptyBrief,topic:"测试",writingStyle:builtinRuleSnapshot("emotion")};
  assert.equal(validateResult(result,[id],brief).imageCaptions[0].headline, "");
  assert.throws(()=>validateResult(result,[id]));
  assert.throws(()=>validateResult(result,[id],{...brief,writingStyle:builtinRuleSnapshot("daily")}));
  const input = {brief,mode:"live" as const,imageIds:[id],target:"caption_one" as const,targetImageId:id,direction:"natural" as const,instruction:"",current:createDemoResult([id])};
  assert.equal(validatePartialResult(input,{titles:[],hashtags:[],imageCaptions:result.imageCaptions}).imageCaptions.length,1);
  assert.throws(()=>validatePartialResult(input,{titles:[],hashtags:[],imageCaptions:[{...result.imageCaptions[0],headline:"新小标题"}]}));
});

test("图文页面提交并校验带规则的真实生成响应；固定演示不受新规则误拦截", async () => {
  const id = randomUUID(), writingStyle = builtinRuleSnapshot("emotion");
  const brief = {...emptyBrief,topic:"合成测试",writingStyle};
  for (const mode of ["live","demo"] as const) {
    const result = createDemoResult([id]);
    if (mode === "live") result.imageCaptions = [{imageId:id,headline:"",description:"合成的一段完整配文。"}];
    const output = await submitGeneration({brief, mode, aiSource:"", controller:new AbortController(),
      images:[{id,file:new File(["fixture"],"fixture.jpg",{type:"image/jpeg"}),preview:"blob:fixture",width:20,height:20}],
      compress:async()=>[new Blob(["fixture"],{type:"image/jpeg"})],onProgress:()=>{},onRequestStarted:()=>{},
      request:async(_url,init)=>{
        const payload=JSON.parse(String((init?.body as FormData).get("payload")));
        assert.deepEqual(payload.brief.writingStyle,writingStyle);
        return Response.json({result,mode,meta:{durationMs:1,completedAt:new Date().toISOString()}});
      }});
    assert.deepEqual(output.result.imageCaptions,result.imageCaptions);
  }
});

test("共用风格校验账号和启用版本，规则升级或删除不会篡改旧稿快照", async () => {
  const env = process.env.APP_MODE; process.env.APP_MODE="local";
  try {
    const owner=randomUUID(), other=randomUUID();
    let record=await createPersonalStyle(owner,emptyRuleContent("合成风格"));
    const first=record.versions[0].snapshot;
    await assert.rejects(bindWritingStyle({writingStyle:first},owner),/尚未启用/);
    record=await activatePersonalStyle(owner,record.id,record.revision,record.draftVersionId);
    assert.deepEqual((await bindWritingStyle({writingStyle:first},owner)).writingStyle,first);
    await assert.rejects(bindWritingStyle({writingStyle:first},other),/不属于/);
    await assert.rejects(bindWritingStyle({writingStyle:{...first,content:{...first.content,name:"伪造修改"}}},owner),/不一致/);
    record=await savePersonalStyle(owner,record.id,record.revision,{...first.content,name:"新版本"});
    record=await activatePersonalStyle(owner,record.id,record.revision,record.draftVersionId);
    assert.equal((await bindWritingStyle({writingStyle:first},owner)).writingStyle.versionId,first.versionId);
    await deletePersonalStyle(owner,record.id,record.revision);
    assert.deepEqual((await bindWritingStyle({writingStyle:first},owner)).writingStyle,first);
    await assert.rejects(bindWritingStyle({writingStyle:first},other),/不属于/);
  } finally { if(env===undefined)delete process.env.APP_MODE;else process.env.APP_MODE=env; }
});

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { AppError } from "../lib/errors";
import { emptyPersonalInput, personalInputSchema, personalRequestSchema, type PersonalInput } from "../lib/personal/schema";
import { newPersonalDraft, serializePersonalDraft, hydratePersonalDraft, personalStoredSchema } from "../lib/personal/drafts";
import { isPersonalPromptStale, personalInputKey, personalResultFingerprint } from "../lib/personal/flow";
import { personalLocalStore } from "../lib/personal/store";
import { runPersonal } from "../lib/server/personal";
import { personalWritingGuidance } from "../lib/personal/writing-guidance";
import { personalDirectionPreview, personalPromptSummary } from "../lib/personal/presentation";
import { createRepository } from "../lib/cloud/server/repository";
import { createDataService, parsePersonalWire } from "../lib/cloud/server/data";
import type { BlobStorage } from "../lib/cloud/server/blobs";

const experience = "今天去海边看日落，心情很放松。";
const originalIntent = "不急着完成什么，也允许自己享受眼前。";
const editedIntent = "把注意力从远处的目标收回，珍惜此刻。";
const note = {
  titles: ["这一刻就很好", "让心慢一点", "日落时放松", "留住眼前", "不用急着赶路"],
  coverCopy: { headline: "眼前的日落", subline: "心里的松弛" }, imageCaptions: [],
  body: "合成正文，用于验证保存和请求传递。", hashtags: ["#日落", "#海边", "#慢生活", "#生活感悟", "#旅行", "#旅行记录", "#日常", "#日常分享", "#松弛感", "#情绪表达"], warnings: [],
};
function response(value: unknown) {
  return Response.json({ id: "synthetic-intent", object: "response", created_at: 1, model: "synthetic", status: "completed", error: null, incomplete_details: null,
    output: [{ id: "synthetic-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] });
}
function environment() {
  const previous = { ...process.env };
  process.env.APP_MODE = "local"; process.env.APP_LOCAL_ONLY = "1";
  process.env.OPENAI_API_KEY = "synthetic-key"; process.env.OPENAI_MODEL = "synthetic-model";
  delete process.env.OPENAI_BASE_URL;
  return () => { process.env = previous; };
}
function unpack(init?: RequestInit) {
  const request = JSON.parse(String(init?.body));
  const content = request.input.find((item: { role: string }) => item.role === "user").content;
  return { request, material: JSON.parse(content[0].text) };
}
function withGeneration() {
  const draft = newPersonalDraft();
  draft.input = { ...emptyPersonalInput, experience, coreIntent: originalIntent, bodyLength: "long", styles: ["emotion", "daily"] };
  draft.prompt = `【核心感受或观点】\n${originalIntent}\n\n保留自然表达。`;
  draft.promptInput = structuredClone(draft.input);
  draft.generation = { mode: "live", imageIds: [], result: structuredClone(note), meta: { durationMs: 1, completedAt: new Date().toISOString() } };
  draft.generatedInput = { input: structuredClone(draft.input), confirmedPrompt: draft.prompt, research: null, imageIds: [] };
  return draft;
}

test("核心方向可选且有长度边界，旧本地及云端个人草稿补空值但不改旧内容", () => {
  assert.equal(personalInputSchema.parse({ ...emptyPersonalInput, coreIntent: undefined }).coreIntent, "");
  assert.equal(personalInputSchema.safeParse({ ...emptyPersonalInput, coreIntent: "文".repeat(600) }).success, true);
  assert.equal(personalInputSchema.safeParse({ ...emptyPersonalInput, coreIntent: "文".repeat(601) }).success, false);
  const stored = serializePersonalDraft(withGeneration(), 0);
  const legacyInput = (value: PersonalInput) => { const { coreIntent: _removed, ...legacy } = value; void _removed; return legacy; };
  const legacy = { ...stored, input: legacyInput(stored.input), promptInput: legacyInput(stored.promptInput!), generatedInput: { ...stored.generatedInput!, input: legacyInput(stored.generatedInput!.input) } };
  for (const restored of [personalStoredSchema.parse(legacy), parsePersonalWire(legacy)]) {
    assert.equal(restored.version, 1); assert.equal(restored.input.coreIntent, "");
    assert.equal(restored.promptInput?.coreIntent, ""); assert.equal(restored.generatedInput?.input.coreIntent, "");
    assert.equal(restored.prompt, stored.prompt); assert.equal(restored.generation?.result.body, note.body);
    assert.equal(restored.input.experience, experience);
  }
});

test("修改第一步核心方向使提示词过期，编辑第二步确认文字本身不误报过期", () => {
  const draft = withGeneration();
  assert.equal(isPersonalPromptStale(draft), false);
  const updated = { ...draft, input: { ...draft.input, coreIntent: editedIntent } };
  assert.equal(isPersonalPromptStale(updated), true);
  assert.notEqual(personalInputKey(updated), personalInputKey(draft));
  assert.notEqual(personalResultFingerprint(updated), personalResultFingerprint(draft));
  const edited = { ...draft, prompt: draft.prompt.replace(originalIntent, editedIntent) };
  assert.equal(isPersonalPromptStale(edited), false);
  assert.notEqual(personalResultFingerprint(edited), personalResultFingerprint(draft));
});

test("情绪核心引导选材而非行程清单，单一风格及纯旅行结构仍由用户决定", () => {
  const emotion = personalWritingGuidance({ ...emptyPersonalInput, experience, styles: ["emotion"] });
  assert.match(emotion.styleGuidance, /先明确.*核心感受或观点.*场景取舍/u);
  assert.match(emotion.styleGuidance, /不平均分配每个地点的篇幅/u);
  assert.match(emotion.styleGuidance, /不要预设.*治愈.*成长.*做自己/u);
  assert.match(emotion.styleGuidance, /真实润色不能.*编造.*转折/u);
  const travel = personalWritingGuidance({ ...emptyPersonalInput, experience, styles: ["travel"], customStyle: "按天介绍路线，实用为主" });
  assert.match(travel.composition, /路线.*实用/u);
  assert.match(travel.composition, /按天.*路线/u);
  assert.doesNotMatch(travel.styleGuidance, /情绪表达：先明确/u);
  for (const truth of ["truthful", "creative"] as const) {
    const mixed = personalWritingGuidance({ ...emptyPersonalInput, experience, styles: ["emotion"], truth });
    assert.match(mixed.styleGuidance, /只使用本次明确选择的一种风格/u);
    assert.match(mixed.styleGuidance, /不融合其他风格/u);
    assert.match(mixed.composition, /创意发挥.*情节/u);
  }
});

test("手填核心方向保留原意，空方向从同次提示词请求提炼，两模式均返回可编辑首段", async () => {
  const restore = environment(); let calls = 0;
  const materials: Array<{ context: { input: PersonalInput } }> = [];
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++; materials.push(unpack(init).material);
    return response({ prompt: "以场景进入，围绕核心感受自然展开。", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "模型提炼的合成方向" });
  });
  try {
    for (const truth of ["truthful", "creative"] as const) {
      for (const coreIntent of [originalIntent, ""]) {
        const input = { ...emptyPersonalInput, experience, truth, coreIntent, styles: ["emotion"] as PersonalInput["styles"], bodyLength: "long" as const };
        const payload = personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }); const before = structuredClone(payload);
        const result = await runPersonal(payload, [], new AbortController().signal);
        assert.ok("prompt" in result && typeof result.prompt === "string");
        assert.ok(result.prompt.startsWith(`【核心感受或观点】\n${coreIntent || "模型提炼的合成方向"}\n`));
        assert.deepEqual(materials.at(-1)?.context.input, input);
        if (coreIntent) assert.doesNotMatch(result.prompt, /模型提炼的合成方向/u);
        assert.equal(result.research?.status, "disabled"); assert.deepEqual(payload, before);
      }
    }
    assert.equal(calls, 4, "提炼核心方向应复用原提示词请求，不追加一次模型请求");
  } finally { net.mock.restore(); restore(); }
});

test("模型未提供有效核心方向时拒绝不完整提示词，并保留输入", async () => {
  const restore = environment(); let value = "", calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; return response({ prompt: "合成提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: value }); });
  try {
    const payload = personalRequestSchema.parse({ action: "prompt", input: { ...emptyPersonalInput, experience }, imageIds: [] }); const before = structuredClone(payload);
    for (const invalid of [" ", "文".repeat(601)]) {
      value = invalid;
      await assert.rejects(runPersonal(payload, [], new AbortController().signal), (error: unknown) => error instanceof AppError && error.code === "INVALID_RESULT");
      assert.deepEqual(payload, before);
    }
    assert.equal(calls, 2);
  } finally { net.mock.restore(); restore(); }
});

test("同一感受搭配不同素材时读取本次写作安排，确认后逐字使用修改后的安排且没有额外模型调用", async () => {
  const restore = environment();
  const intent = "热闹中的自由和松弛感。";
  const cases = [
    { experience: "和朋友看街头装扮，一起合影，后来放弃排队。", plan: "从街头装扮与朋友合影切入，重点写参与其中的轻松，排队后离开略带一笔，用片段串起自由与松弛。" },
    { experience: "独自逛周末市集，看摊位摆设，买了一束花。", plan: "从市集摊位的摆设切入，把独自闲逛和买花作为线索，写在人群中按自己的节奏停留，不增加同行人物。" },
  ];
  const calls: Array<ReturnType<typeof unpack>> = [];
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const sent = unpack(init); calls.push(sent);
    if (sent.request.text.format.name === "personal_prompt") {
      const entry = cases.find(item => item.experience === sent.material.context.input.experience)!;
      const instructions = sent.request.input.find((item: { role: string }) => item.role === "system").content;
      assert.match(instructions, /writingPlan.*40～70/u);
      assert.match(instructions, /不得只照抄或换说法复述 coreIntent/u);
      assert.match(instructions, /不同素材应有不同安排/u);
      assert.match(instructions, /不为写作安排杜撰人物、地点和事件/u);
      assert.ok(sent.request.text.format.schema.required.includes("writingPlan"));
      return response({ coreIntent: intent, writingPlan: entry.plan, prompt: "【语气与写法】\n自然记录，用具体观察承接感受。" });
    }
    return response(structuredClone(note));
  });
  try {
    const generated: string[] = [];
    for (const entry of cases) {
      const input = { ...emptyPersonalInput, experience: entry.experience, coreIntent: intent, styles: ["emotion"] as PersonalInput["styles"] };
      const result = await runPersonal(personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }), [], new AbortController().signal);
      assert.ok("prompt" in result);
      const prompt = result.prompt!; generated.push(prompt);
      assert.equal(personalPromptSummary(prompt).core, entry.plan);
      assert.equal(personalDirectionPreview(prompt, input).core, entry.plan);
      assert.notEqual(personalDirectionPreview(prompt, input).core, intent);
    }
    assert.notEqual(personalPromptSummary(generated[0]).core, personalPromptSummary(generated[1]).core);
    const editedPlan = "以买花后的心情切入，再回到市集里的观察，重点写独自决定停留节奏的轻松，不按时间罗列。";
    const edited = generated[1].replace(cases[1].plan, editedPlan);
    assert.equal(personalDirectionPreview(edited, emptyPersonalInput).core, editedPlan);
    await runPersonal(personalRequestSchema.parse({ action: "generate", input: { ...emptyPersonalInput, experience: cases[1].experience, coreIntent: intent }, imageIds: [], confirmedPrompt: edited }), [], new AbortController().signal);
    assert.equal(calls.at(-1)?.material.confirmedPrompt, edited);
    assert.doesNotMatch(JSON.stringify(calls.at(-1)), new RegExp(cases[1].plan, "u"));
    assert.equal(calls.length, 3, "两次提示词加一次确认生成，不追加摘要模型调用");
  } finally { net.mock.restore(); restore(); }
});

test("结构校验拒绝缺失、直接复述和输出规则，不以固定写作动词拒绝合法安排", async () => {
  const restore = environment();
  const input = { ...emptyPersonalInput, experience, coreIntent: originalIntent };
  const request = personalRequestSchema.parse({ action: "prompt", input, imageIds: [] });
  const before = structuredClone(request);
  let value: { writingPlan: string; prompt: string } = { writingPlan: "", prompt: "自然表达。" }, calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; return response({ ...value, coreIntent: originalIntent }); });
  try {
    const invalid = ["", originalIntent, `表达${originalIntent}`, "输出格式：从日落切入，生成5个标题。", "从日落切入，" + "细节".repeat(160)];
    for (const writingPlan of invalid) {
      value = { writingPlan, prompt: "自然表达。" };
      await assert.rejects(runPersonal(request, [], new AbortController().signal), (error: unknown) => error instanceof AppError && error.code === "INVALID_RESULT");
      assert.deepEqual(request, before);
    }
    value = { writingPlan: "从日落的观察切入，串联当下感受。", prompt: "【创作方向】\n以另一段经历作为开头。" };
    await assert.rejects(runPersonal(request, [], new AbortController().signal), /重复或不明确/u);
    assert.deepEqual(request, before); assert.equal(calls, invalid.length + 1);
    value = { writingPlan: "放大海面颜色变化，用感官描写连接平静心情。", prompt: "【语气与写法】\n自然口语，保留真实经历。" };
    const accepted = await runPersonal(request, [], new AbortController().signal);
    assert.ok("prompt" in accepted);
    assert.equal(personalPromptSummary(accepted.prompt!).core, value.writingPlan);
    assert.deepEqual(request, before); assert.equal(calls, invalid.length + 2);
  } finally { net.mock.restore(); restore(); }
});

test("最终生成和正文重写优先确认后的核心方向，不把第一步旧方向再次发送为约束", async () => {
  const restore = environment();
  const sent: Array<ReturnType<typeof unpack>> = [];
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const item = unpack(init); sent.push(item);
    return response(item.request.text.format.name === "personal_rewrite" ? { body: "仅待确认的新正文。", titles: [], imageCaptions: [], hashtags: [] } : structuredClone(note));
  });
  try {
    for (const truth of ["truthful", "creative"] as const) {
      for (const bodyLength of ["short", "long", "custom"] as const) {
        const input = { ...emptyPersonalInput, experience, truth, coreIntent: originalIntent, styles: ["emotion"] as PersonalInput["styles"], bodyLength, customLength: 700 };
        const confirmedPrompt = `【核心感受或观点】\n${editedIntent}\n\n用户已修改：结尾留白，不强行升华。`;
        const payload = personalRequestSchema.parse({ action: "generate", input, imageIds: [], confirmedPrompt });
        const original = structuredClone(payload);
        await runPersonal(payload, [], new AbortController().signal);
        const rewritten = personalRequestSchema.parse({ ...payload, action: "rewrite", rewrite: { target: "body", direction: "natural", instruction: "更口语化", current: structuredClone(note) } });
        await runPersonal(rewritten, [], new AbortController().signal);
        for (const item of sent.slice(-2)) {
          assert.equal(item.material.confirmedPrompt, confirmedPrompt);
          assert.equal("coreIntent" in item.material.context.input, false);
          assert.doesNotMatch(JSON.stringify(item.request), new RegExp(originalIntent, "u"));
          assert.equal(item.material.context.input.bodyLength, bodyLength);
          assert.equal(item.material.context.input.truth, truth);
          assert.deepEqual(item.material.context.input.styles, input.styles);
          const instructions = String(item.request.input.find((part: { role: string }) => part.role === "system").content);
          assert.match(instructions, /确认.*核心|核心.*确认/u);
          assert.match(instructions, /首部的新方向优先.*冲突内容/u);
          assert.match(instructions, /标题、正文、话题.*逐图配文.*同一核心/u);
        }
        assert.deepEqual(payload, original);
      }
    }
    assert.equal(sent.length, 12);
  } finally { net.mock.restore(); restore(); }
});

test("有图生成的正文与逐图配文共同遵守编辑方向，图片不反向改变正文或取代确认稿", async () => {
  const restore = environment(), imageId = randomUUID();
  const requests: Array<ReturnType<typeof unpack>> = [];
  const confirmedPrompt = `【核心感受或观点】\n${editedIntent}\n\n旧的策划仍有残留，请以首部观点为准。`;
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const item = unpack(init); requests.push(item);
    return response(item.request.text.format.name === "personal_note" ? structuredClone(note) : { imageCaptions: [{ imageId, headline: "", description: "让注意力留在眼前\n给自己一刻慢下来的时间" }] });
  });
  try {
    const input = { ...emptyPersonalInput, experience, coreIntent: originalIntent, styles: ["emotion"] as PersonalInput["styles"] };
    const payload = personalRequestSchema.parse({ action: "generate", input, imageIds: [imageId], confirmedPrompt });
    const original = structuredClone(payload);
    const result = await runPersonal(payload, [{ id: imageId, dataUrl: "data:image/jpeg;base64,c3ludGhldGlj" }], new AbortController().signal);
    assert.equal(requests.length, 2); assert.ok("result" in result);
    assert.equal(result.result.body, note.body); assert.equal(result.result.imageCaptions[0].imageId, imageId);
    for (const item of requests) {
      assert.equal(item.material.confirmedPrompt, confirmedPrompt);
      assert.equal("coreIntent" in item.material.context.input, false);
      assert.doesNotMatch(JSON.stringify(item.request), new RegExp(originalIntent, "u"));
    }
    assert.doesNotMatch(JSON.stringify(requests[0]), /input_image/u);
    assert.match(JSON.stringify(requests[1]), /input_image/u);
    assert.equal(requests[1].material.body, note.body); assert.deepEqual(payload, original);
  } finally { net.mock.restore(); restore(); }
});

test("本地保存恢复当前核心方向与生成快照，修改新方向不污染旧结果重写依据", async () => {
  const previousIDB = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory();
  try {
    const draft = withGeneration(); draft.input.coreIntent = editedIntent;
    draft.prompt = `【核心感受或观点】\n${editedIntent}\n\n尚未用于旧结果的新提示词。`;
    const stored = await personalLocalStore.writeDraft(serializePersonalDraft(draft, 0), null);
    const restored = await hydratePersonalDraft(await personalLocalStore.getDraft(stored.id));
    assert.equal(restored.input.coreIntent, editedIntent); assert.equal(restored.prompt, draft.prompt);
    assert.equal(restored.promptInput?.coreIntent, originalIntent);
    assert.equal(restored.generatedInput?.input.coreIntent, originalIntent);
    assert.equal(restored.generatedInput?.confirmedPrompt, withGeneration().generatedInput?.confirmedPrompt);
    assert.equal(restored.generation?.result.body, note.body); assert.equal(isPersonalPromptStale(restored), true);
    const restore = environment(); let requestBody = "";
    const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { requestBody = String(init?.body); return response({ body: "旧结果方向下的新正文预览。", titles: [], imageCaptions: [], hashtags: [] }); });
    try {
      const basis = restored.generatedInput!;
      await runPersonal(personalRequestSchema.parse({ action: "rewrite", input: {...basis.input,styles:["emotion"]}, imageIds: basis.imageIds, confirmedPrompt: basis.confirmedPrompt, rewrite: { target: "body", direction: "natural", instruction: "", current: restored.generation!.result } }), [], new AbortController().signal);
      assert.match(requestBody, new RegExp(originalIntent, "u")); assert.doesNotMatch(requestBody, new RegExp(editedIntent, "u"));
      assert.equal(restored.generation?.result.body, note.body);
    } finally { net.mock.restore(); restore(); }
  } finally { globalThis.indexedDB = previousIDB; }
});

test("云端隔离测试能保存核心方向与确认快照，另一账号不能读取或改写", async () => {
  const previous = { ...process.env }, directory = await mkdtemp(join(tmpdir(), "xhs-core-intent-"));
  process.env = { ...previous, APP_MODE: "cloud", APP_ORIGIN: "http://127.0.0.1:3022", CLOUD_LOCAL_TEST: "1", CLOUD_BACKEND: "sqlite", CLOUD_SQLITE_PATH: join(directory, "records.sqlite") };
  const blobs: BlobStorage = { async put(key) { return key; }, async get() { throw new Error("no images in this synthetic test"); }, async remove() {} };
  try {
    const repository = await createRepository(), service = createDataService(repository, blobs), owner = randomUUID(), other = randomUUID();
    const stored = serializePersonalDraft(withGeneration(), 0);
    const wire = { ...stored, assets: [] };
    const saved = await service.savePersonal(owner, wire, null);
    const loaded = await service.personal(owner, saved.id);
    assert.equal(loaded.input.coreIntent, originalIntent); assert.equal(loaded.generatedInput?.input.coreIntent, originalIntent);
    assert.equal(loaded.generatedInput?.confirmedPrompt, wire.generatedInput?.confirmedPrompt);
    await assert.rejects(service.personal(other, saved.id), /没有找到/u);
    await assert.rejects(service.savePersonal(other, { ...wire, input: { ...wire.input, coreIntent: editedIntent } }, saved.revision), /修改|删除/u);
    assert.equal((await service.personal(owner, saved.id)).input.coreIntent, originalIntent);
    assert.equal((await service.personalWorkspace(other)).summaries.length, 0);
  } finally { process.env = previous; await rm(directory, { recursive: true, force: true }); }
});

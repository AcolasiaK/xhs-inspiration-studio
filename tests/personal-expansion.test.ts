import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { emptyPersonalInput, personalRequestSchema, type PersonalInput } from "../lib/personal/schema";
import { runPersonal } from "../lib/server/personal";
import { AppError } from "../lib/errors";
import { personalBodyTarget, personalPromptContract, personalWritingGuidance } from "../lib/personal/writing-guidance";

const sparseExperience = "今天去海边看日落，心情很放松。";
const savedNote = {
  titles: ["海边日落", "今天慢一点", "留一点时间", "落日的片刻", "把心放轻"],
  coverCopy: { headline: "海边日落", subline: "放松的片刻" },
  imageCaptions: [],
  body: "这是已编辑且必须保留的合成正文。\n\n这是第二段。",
  hashtags: ["#看日落", "#海边", "#生活记录", "#放松", "#日常分享", "#情绪表达", "#慢生活", "#日落记录", "#生活感悟", "#旅行记录"],
  warnings: [],
};

type ModelRequest = {
  input: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  text: { format: { name: string } };
  max_output_tokens?: number;
};
function material(request: ModelRequest): Record<string, unknown> {
  const content = request.input.find(item => item.role === "user")?.content;
  assert.ok(Array.isArray(content));
  const text = content.find(item => item.type === "input_text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text!);
}
function assertWritingRequest(request: ModelRequest, input: PersonalInput) {
  const system = request.input.find(item => item.role === "system")?.content;
  assert.equal(typeof system, "string");
  const guidance = personalWritingGuidance(input);
  for (const rule of [guidance.authenticity, guidance.composition, guidance.expansion, guidance.length.instruction, guidance.review]) {
    assert.ok((system as string).includes(rule), "正文写作规则必须实际进入模型系统指令");
  }
  const context = material(request).context as { input: PersonalInput; writingGuidance: ReturnType<typeof personalWritingGuidance> };
  assert.deepEqual(context.writingGuidance, guidance);
  const { coreIntent, ...confirmedInput } = input;
  assert.deepEqual(context.input, request.text.format.name === "personal_prompt" ? { ...confirmedInput, coreIntent } : confirmedInput);
}
function response(value: unknown, status = "completed") {
  return Response.json({ id: "synthetic-expansion", object: "response", created_at: 1, model: "test", status,
    error: null, incomplete_details: status === "completed" ? null : { reason: "max_output_tokens" },
    output: [{ id: "synthetic-message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] });
}
function relayEnvironment() {
  const prior = { ...process.env };
  process.env.APP_MODE = "local"; process.env.APP_LOCAL_ONLY = "1";
  process.env.OPENAI_API_KEY = "synthetic-key"; process.env.OPENAI_MODEL = "synthetic-model";
  delete process.env.OPENAI_BASE_URL;
  return () => { process.env = prior; };
}

test("真实润色允许深入表达而不补造具体亲历，创意模式独立允许场景和情节", () => {
  const input = { ...emptyPersonalInput, experience: sparseExperience, styles: ["travel"] as PersonalInput["styles"], bodyLength: "long" as const };
  const truthful = personalWritingGuidance({ ...input, truth: "truthful" });
  const creative = personalWritingGuidance({ ...input, truth: "creative" });
  assert.equal(truthful.truthMode, "truthful"); assert.equal(creative.truthMode, "creative");
  assert.notEqual(truthful.authenticity, creative.authenticity);
  assert.match(truthful.authenticity, /允许充分展开.*心情.*感受.*氛围.*思考/u);
  assert.match(truthful.authenticity, /不新增.*人物.*对话.*事件.*地点.*行程.*消费/u);
  assert.match(truthful.authenticity, /未提供的过往经历、惯常行为/u);
  assert.match(creative.authenticity, /允许主动补充.*场景.*人物.*情节.*对话.*细节.*情绪变化/u);
  assert.match(creative.authenticity, /外部可核实信息.*不能伪称查证/u);
  for (const guidance of [truthful, creative]) {
    assert.match(guidance.expansion, /输入篇幅不是输出篇幅的上限/u);
    assert.match(guidance.review, /明显短于目标.*补充不同层次/u);
    assert.match(guidance.styleGuidance, /旅行攻略/); assert.doesNotMatch(guidance.styleGuidance, /情绪表达：|日常分享：/);
    assert.doesNotMatch(guidance.styleGuidance, /用已提供的路线和场景|只有提供了多日安排才按天展开/u);
    assert.doesNotMatch(guidance.styleGuidance, /路线写作：/u);
  }
});

test("所选篇幅独立于输入长短，明确长度优先旧提示词，自动模式才采用文字篇幅要求", () => {
  for (const [mode, min, max, target] of [["short", 150, 250, 200], ["medium", 350, 550, 450], ["long", 650, 850, 750]] as const) {
    const input = { ...emptyPersonalInput, experience: sparseExperience, bodyLength: mode };
    const actual = personalBodyTarget(input);
    assert.equal(actual.mode, mode); assert.equal(actual.min, min); assert.equal(actual.max, max); assert.equal(actual.target, target);
    assert.deepEqual(personalBodyTarget({ ...input, experience: sparseExperience.repeat(50) }), actual);
    assert.match(actual.instruction, /当前长度选项优先于旧的或自动生成的提示词/u);
    const visible = personalPromptContract({ ...input, truth: "truthful" });
    assert.match(visible, /真实润色/u); assert.ok(visible.includes(`${min}～${max}`));
  }
  const custom = personalBodyTarget({ ...emptyPersonalInput, experience: sparseExperience, bodyLength: "custom", customLength: 900 });
  assert.equal(custom.target, 900); assert.ok(custom.min < 900 && custom.max > 900);
  const automatic = personalBodyTarget({ ...emptyPersonalInput, experience: sparseExperience });
  assert.match(automatic.instruction, /优先遵循用户确认提示词或补充要求中明确填写的长度/u);
  const contract = personalPromptContract({ ...emptyPersonalInput, experience: sparseExperience, truth: "creative", bodyLength: "custom", customLength: 900 });
  assert.match(contract, /创意发挥/u); assert.match(contract, /900/u); assert.match(contract, /输入简短不限制正文长度/u);
});

test("稀疏输入的最终确认提示词、真实性和长度在正文与重写请求中保持完整", async () => {
  const restore = relayEnvironment();
  const requests: ModelRequest[] = [];
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ModelRequest; requests.push(request);
    if (request.text.format.name === "personal_prompt") return response({ prompt: "模型返回的待确认提示词", writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "在日落中找到松弛" });
    if (request.text.format.name === "personal_rewrite") return response({ body: "预览中的新正文。", titles: [], imageCaptions: [], hashtags: [] });
    return response(structuredClone(savedNote));
  });
  try {
    for (const truth of ["truthful", "creative"] as const) {
      for (const styles of [["travel"], ["emotion"], ["daily"]] as PersonalInput["styles"][]) {
        for (const bodyLength of ["short", "medium", "long", "custom"] as const) {
          const input = { ...emptyPersonalInput, experience: sparseExperience, styles, truth, bodyLength, customLength: 900, customStyle: "自然的观察，段落间有情绪变化" };
          const confirmedPrompt = "我编辑确认的提示词：正文保留海边、日落和放松的主题。\n结尾留白，不强行升华。";
          const payload = personalRequestSchema.parse({ action: "generate", input, imageIds: [], confirmedPrompt });
          const original = structuredClone(payload);
          const before = requests.length;
          await runPersonal(payload, [], new AbortController().signal);
          assert.equal(requests.length, before + 1, "完整无图生成不应静默追加其他模型调用");
          const sent = material(requests.at(-1)!);
          assert.equal(sent.confirmedPrompt, confirmedPrompt);
          assertWritingRequest(requests.at(-1)!, input);
          assert.deepEqual(payload, original, "输入和已确认提示词不能被请求过程改写");
        }
      }
      const input = { ...emptyPersonalInput, experience: sparseExperience, truth, styles: ["travel"] as PersonalInput["styles"], bodyLength: "long" as const };
      const before = requests.length;
      const prompt = await runPersonal(personalRequestSchema.parse({ action: "prompt", input, imageIds: [] }), [], new AbortController().signal);
      assert.ok("prompt" in prompt && typeof prompt.prompt === "string");
      assert.ok(prompt.prompt.endsWith(personalPromptContract(input)), "可编辑提示词必须可见地包含当前真实性与篇幅设置");
      assert.ok(prompt.prompt.startsWith("【核心感受或观点】"));
      assert.ok(prompt.prompt.includes("模型返回的待确认提示词"));
      const confirmedPrompt = "用户确认后的全新版本：围绕海边日落逐层展开。";
      const payload = personalRequestSchema.parse({ action: "rewrite", input, imageIds: [], confirmedPrompt, rewrite: { target: "body", direction: "detailed", instruction: "增加观察和思考的层次", current: structuredClone(savedNote) } });
      const old = structuredClone(payload);
      await runPersonal(payload, [], new AbortController().signal);
      assert.equal(requests.length, before + 2);
      assert.equal(material(requests.at(-1)!).confirmedPrompt, confirmedPrompt);
      assert.deepEqual(payload, old, "预览重写不得修改用户已编辑的原文");
      for (const sent of requests.slice(before)) {
        assertWritingRequest(sent, input);
      }
    }
  } finally { net.mock.restore(); restore(); }
});

test("旧提示词字数不同仍原样提交，显式长度指令优先且不会偷偷改写用户确认内容", async () => {
  const restore = relayEnvironment();
  let sent: ModelRequest | undefined;
  const net = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return response(structuredClone(savedNote)); });
  try {
    const confirmedPrompt = "用户编辑确认：请保留日落放松的主题，正文约 100 字。";
    const input = { ...emptyPersonalInput, experience: sparseExperience, truth: "creative" as const, bodyLength: "long" as const };
    await runPersonal(personalRequestSchema.parse({ action: "generate", input, imageIds: [], confirmedPrompt }), [], new AbortController().signal);
    assert.ok(sent); assert.equal(material(sent).confirmedPrompt, confirmedPrompt);
    assertWritingRequest(sent, input);
    assert.match(String(sent.input.find(item => item.role === "system")?.content), /当前长度选项优先/u);
  } finally { net.mock.restore(); restore(); }
});

test("生成提示词追加可见设置后超出保存上限时明确失败，不返回不能保存的提示词", async () => {
  const restore = relayEnvironment(); let calls = 0;
  const net = mock.method(globalThis, "fetch", async () => { calls++; return response({ prompt: "文".repeat(11990), writingPlan: "从已有场景切入，重点写观察细节，用感受串联段落，自然收住。", coreIntent: "合成核心方向" }); });
  try {
    const payload = personalRequestSchema.parse({ action: "prompt", input: { ...emptyPersonalInput, experience: sparseExperience }, imageIds: [] });
    const original = structuredClone(payload);
    await assert.rejects(runPersonal(payload, [], new AbortController().signal), (e: unknown) => e instanceof AppError && e.code === "INVALID_RESULT");
    assert.equal(calls, 1); assert.deepEqual(payload, original);
  } finally { net.mock.restore(); restore(); }
});

test("短输入正文生成或重写遇到 502、取消或不完整结果时不覆盖原文且不自动重试", async () => {
  const restore = relayEnvironment();
  let calls = 0, mode: "502" | "incomplete" = "502";
  const net = mock.method(globalThis, "fetch", async () => {
    calls++;
    return mode === "502" ? Response.json({ error: { message: "synthetic upstream failure" } }, { status: 502 }) : response(structuredClone(savedNote), "incomplete");
  });
  try {
    const input = { ...emptyPersonalInput, experience: sparseExperience, bodyLength: "long" as const };
    const payload = personalRequestSchema.parse({ action: "rewrite", input, imageIds: [], confirmedPrompt: "已编辑确认的提示词", rewrite: { target: "body", direction: "detailed", instruction: "自然展开", current: structuredClone(savedNote) } });
    const original = structuredClone(payload);
    await assert.rejects(runPersonal(payload, [], new AbortController().signal), (e: unknown) => e instanceof AppError && e.code === "PROVIDER_UNAVAILABLE");
    assert.equal(calls, 1); assert.deepEqual(payload, original);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(runPersonal(payload, [], aborted.signal), (e: unknown) => e instanceof AppError && e.code === "CANCELLED");
    assert.equal(calls, 1); assert.deepEqual(payload, original);
    mode = "incomplete";
    const generation = personalRequestSchema.parse({ action: "generate", input, imageIds: [], confirmedPrompt: payload.confirmedPrompt });
    await assert.rejects(runPersonal(generation, [], new AbortController().signal), (e: unknown) => e instanceof AppError && e.code === "INCOMPLETE");
    assert.equal(calls, 2); assert.deepEqual(payload, original);
  } finally { net.mock.restore(); restore(); }
});

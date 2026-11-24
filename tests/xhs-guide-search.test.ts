import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { searchPersonalBackground } from "../lib/server/personal-search";
import { searchXhsGuide, xhsGuideSearchTransport } from "../lib/server/xhs-guide-search";
import { travelResearchSchema } from "../lib/travel-research";
import { researchForPrompt } from "../lib/research-prompt";
import { personalCaptionInstructions } from "../lib/personal/captions";
import { emptyPersonalInput } from "../lib/personal/schema";
import { builtinRuleSnapshot } from "../lib/personal/style-rules";
import { mockSearchBrowser } from "./browser-search-fixture";

const place = "大理";
const validState = {host:"www.xiaohongshu.com",blocked:false,login:false};

test("OpenClaw 拦截公共网页检索时提示导航保护和代理设置，并隐藏底层错误", async () => {
  const home = await mkdtemp(join(tmpdir(), "xhs-browser-policy-"));
  try {
    const bin = join(home, ".openclaw", "bin");
    await mkdir(bin, {recursive:true});
    await writeFile(join(bin, "openclaw"), `#!/bin/sh
case "$5" in
  start|close) printf '{"ok":true}\\n' ;;
  open) printf '{"targetId":"test-tab"}\\n' ;;
  navigate) printf 'browser navigation blocked by policy; PRIVATE_CLI_CREDENTIAL\\n' >&2; exit 1 ;;
  *) exit 1 ;;
esac
`, {mode:0o700});
    const {stdout} = await promisify(execFile)(process.execPath, [
      "--conditions=react-server", "--import", "tsx", "--eval",
      `require("node:os").homedir = () => process.argv[1];
      require("node:module").syncBuiltinESMExports();
      const {searchPersonalBackground} = require("./lib/server/personal-search.ts");
      searchPersonalBackground({query:"大理",enabled:true}).then(result => {
        process.stdout.write(JSON.stringify(result));
      }).catch(error => { console.error(error); process.exitCode = 1; });`,
      "--", home,
    ], {env:{...process.env,APP_MODE:"local"},timeout:10_000});
    const result = travelResearchSchema.parse(JSON.parse(stdout));
    assert.equal(result.status, "error");
    assert.deepEqual(result.sources, []);
    assert.match(result.notice, /OpenClaw.*导航保护.*代理/u);
    assert.doesNotMatch(stdout, /PRIVATE_CLI_CREDENTIAL|请确认 OpenClaw 网关/u);
  } finally {
    await rm(home, {recursive:true,force:true});
  }
});

test("个人攻略直接查公开网页，整地和局部范围都不会打开小红书", async () => {
  const previous = process.env.APP_MODE;
  process.env.APP_MODE = "local";
  const community = mock.method(xhsGuideSearchTransport, "run", async () => {
    throw new Error("个人创作不应打开小红书");
  });
  const queries: string[] = [];
  const browser = mockSearchBrowser(query => {
    queries.push(query);
    return [{ title: "大理游览线路", url: "https://www.gov.cn/route", snippet: "大理古城从南门步行到五华楼，乘坐公交到喜洲入口。" }];
  });
  try {
    for (const wholeDestination of [true, false]) {
      queries.length = 0;
      const result = await searchPersonalBackground({ query: "大理攻略", enabled: true, wholeDestination });
      assert.ok(travelResearchSchema.safeParse(result).success);
      assert.equal(result.sources[0]?.url, "https://www.gov.cn/route");
      assert.match(JSON.stringify(researchForPrompt(result)), /五华楼/u);
      assert.equal(queries.some(query => query.includes("精品线路")), wholeDestination);
      assert.ok(queries.some(query => query.includes("游览线路")));
      assert.ok(queries.some(query => query.includes("交通")));
    }
    assert.equal(community.mock.callCount(), 0);
  } finally {
    community.mock.restore();
    browser.mock.restore();
    if (previous === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = previous;
  }
});

test("小红书要求登录时停在自己的搜索页，不筛选、不读取正文", async () => {
  const commands:string[] = [];
  const result=await searchXhsGuide({query:place},async args=>{
    commands.push(args[0]);
    if(args[0]==="open")return {targetId:"isolated"};
    if(args[0]==="evaluate")return {result:{state:{...validState,login:true}}};
    return {};
  });
  assert.equal(result.state,"login");
  assert.equal(result.sources.length,0);
  assert.deepEqual(commands,["start","open","navigate","evaluate"]);
});

test("思考+攻略的配文只写感受，旧提示词里的攻略不进入配文", () => {
  const ruleSnapshot=builtinRuleSnapshot("daily");
  const common={...emptyPersonalInput,ruleSnapshot};
  const selected={...common,ruleSnapshot:{...ruleSnapshot,baseStyle:"custom" as const,content:{...ruleSnapshot.content,name:"思考+攻略"}}};
  assert.match(personalCaptionInstructions(selected,false),/首句进入本篇已知经历/u);
  assert.match(personalCaptionInstructions(selected,false),/逐图配文不提供景点推荐、路线/u);
  assert.match(personalCaptionInstructions(selected,false),/攻略集中在笔记正文后半段/u);
  assert.doesNotMatch(personalCaptionInstructions(selected,false),/读者用得上的信息/u);
  assert.doesNotMatch(personalCaptionInstructions(common,false),/首句进入本篇已知经历/u);
});

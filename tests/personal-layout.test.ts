import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("个人步骤导航与共享界面回归（浏览器 React 条件）",()=>{
  // The main suite uses react-server; the UI and its icon library need normal client React.
  const env={...process.env};
  delete env.NODE_TEST_CONTEXT; // Run the UI file as an independent test runner.
  const run=spawnSync(process.execPath,["--import","tsx","--test",fileURLToPath(new URL('./personal-layout.ui.tsx',import.meta.url))],{encoding:"utf8",env});
  assert.equal(run.status,0,run.stdout+run.stderr);
});

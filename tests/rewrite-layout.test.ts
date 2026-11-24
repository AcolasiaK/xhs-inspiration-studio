import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('统一重写弹窗 UI（6 项无付费交互检查）',()=>{const run=spawnSync(process.execPath,['--import','tsx','--test',fileURLToPath(new URL('./rewrite-layout.ui.tsx',import.meta.url))],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);});

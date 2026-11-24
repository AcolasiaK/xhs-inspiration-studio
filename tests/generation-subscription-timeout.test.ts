import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generationTimeouts} from '../lib/server/generation-timeouts';
import {POST} from '../app/api/generate/route';
test('配置快照采用任务总预算，订阅请求被拒绝',async()=>{assert.equal(generationTimeouts('','',{owner:'local-owner',profile:null}).totalMs,190000);const r=await POST(new Request('http://localhost/api/generate',{method:'POST',headers:{'X-AI-Source':'chatgpt'}}));assert.equal(r.status,400);});

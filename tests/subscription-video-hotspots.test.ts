import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POST as video} from '../app/api/video/route';
import {POST as hotspots} from '../app/api/hotspots/route';
test('视频与热点拒绝停用订阅来源',async()=>{for(const handler of [video,hotspots]){const r=await handler(new Request('http://localhost/api/test',{method:'POST',headers:{'X-AI-Source':'chatgpt'}}));assert.equal(r.status,400);assert.equal((await r.json()).error.code,'SOURCE_REMOVED');}});

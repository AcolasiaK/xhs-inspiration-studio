import {test} from 'node:test';
import assert from 'node:assert/strict';
import {POST as rewrite} from '../app/api/rewrite/route';
import {POST as partial} from '../app/api/partial-rewrite/route';
import {POST as style} from '../app/api/style-extract/route';
test('已停用的订阅请求被拒绝，不调用其他服务',async()=>{for(const handler of [rewrite,partial,style]){const r=await handler(new Request('http://localhost/api/test',{method:'POST',headers:{'X-AI-Source':'chatgpt'}}));assert.equal(r.status,400);assert.equal((await r.json()).error.code,'SOURCE_REMOVED');}});

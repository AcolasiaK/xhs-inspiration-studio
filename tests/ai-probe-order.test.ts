import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { POST } from '../app/api/ai/profiles/route';
import { aiTransport } from '../lib/server/ai/provider';
import { beginProbe, readStateFor, recordProbe, saveProfile } from '../lib/server/ai/store';

const origin = 'http://127.0.0.1';
const owner = 'local-owner';
const fields = {name:'fixture', provider:'custom', protocol:'responses', baseUrl:'https://example.com/v1', apiKey:'synthetic-key', model:'test-model'};
const passed = {status:'passed' as const, at:null, message:'new result'};
const failed = {status:'failed' as const, at:null, message:'old result'};

async function temporaryStore(mode:'local'|'cloud', run:()=>Promise<void>) {
 const previous = process.env;
 const dir = await mkdtemp(join(tmpdir(),'xhs-probe-order-'));
 process.env = {...previous, APP_MODE:mode, APP_LOCAL_ONLY:'1', NODE_ENV:'test', APP_ORIGIN:origin,
  AI_CONFIG_DIR:dir, AI_CONFIG_SECRET:'synthetic-fixture-only-at-least-32-characters',
  CLOUD_LOCAL_TEST:'1', CLOUD_BACKEND:'sqlite', CLOUD_SQLITE_PATH:join(dir,'test.sqlite')};
 delete process.env.VERCEL;
 try { await run(); }
 finally { process.env=previous; await rm(dir,{recursive:true,force:true}); }
}

test('同配置并发测试中，旧请求晚到不能盖掉更新的测试结果', async t => temporaryStore('local', async () => {
 const saved = await saveProfile(owner, fields);
 const testRequest = () => new Request(origin+'/api/ai/profiles', {
  method:'POST', headers:{host:'127.0.0.1',origin,'content-type':'application/json'},
  body:JSON.stringify({action:'test',kind:'text',id:saved.id,revision:saved.revision}),
 });
 let markStarted!:()=>void, release!:()=>void;
 const started = new Promise<void>(resolve=>{markStarted=resolve;});
 const waiting = new Promise<void>(resolve=>{release=resolve;});
 let calls = 0;
 t.mock.method(aiTransport, 'fetch', async () => {
  const first = ++calls===1;
  if(first){ markStarted(); await waiting; }
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({value:first?'wrong':'OK'})}]}]});
 });
 const first = POST(testRequest());
 await started;
 try { assert.equal((await POST(testRequest())).status,200); }
 finally { release(); }
 assert.equal((await first).status,409);
 assert.equal((await readStateFor(owner)).profiles[0].textTest.status,'passed');
 assert.equal(calls,2);
}));

for (const mode of ['local','cloud'] as const) {
 test(mode+' 的独立进程共享测试顺序，放弃测试不阻止重试或不同能力测试', async () => temporaryStore(mode, async () => {
  const saved = await saveProfile(owner,fields);
  const first = await beginProbe(owner,saved.id,saved.revision,'image');
  const text = await beginProbe(owner,saved.id,saved.revision,'text');
  // A separate process owns the same file/SQLite database but shares no memory.
  const script = `
   const {beginProbe,recordProbe}=require('./lib/server/ai/store.ts');
   const [owner,id,revision]=process.argv.slice(1);
   (async()=>{
    const image=await beginProbe(owner,id,revision,'image');
    await recordProbe(owner,image.profile,'image',{status:'passed',at:null,message:'new result'},image.probeId);
    await beginProbe(owner,id,revision,'image');
   })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  await promisify(execFile)(process.execPath,['--conditions=react-server','--import','tsx','-e',script,owner,saved.id,saved.revision]);
  await assert.rejects(recordProbe(owner,first.profile,'image',failed,first.probeId),{code:'CONFLICT'});
  await recordProbe(owner,text.profile,'text',passed,text.probeId);
  const current=(await readStateFor(owner)).profiles[0];
  assert.deepEqual(current.imageTest,passed);
  assert.deepEqual(current.textTest,passed);
  assert.equal(current.revision,saved.revision);
  assert.equal(first.profile.imageTest.status,'unverified');
  const older=await beginProbe(owner,saved.id,saved.revision,'image');
  const retry=await beginProbe(owner,saved.id,saved.revision,'image');
  // Also reject a superseded response while the newer attempt is still running.
  await assert.rejects(recordProbe(owner,older.profile,'image',failed,older.probeId),{code:'CONFLICT'});
  assert.deepEqual((await readStateFor(owner)).profiles[0].imageTest,passed);
  await recordProbe(owner,retry.profile,'image',passed,retry.probeId);
 }));
}

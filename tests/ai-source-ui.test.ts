import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getAiSource,setAiSource,setDefaultAiSource,subscribeAiSource,aiSourceHeader} from '../lib/ai-source';
import {setCloudIdentity} from '../lib/cloud/client';
import {AiProfileResource, describeAiSelection, isSameAiRevision, testAiProfileConnection} from '../lib/ai-profile-client';
import {safeErrorCode} from '../lib/client-diagnostics';
test('选择仅保存 profileId，跨组件和 storage 同步，账号命名空间隔离',()=>{const old=globalThis.window;const storage=new Map<string,string>();const fake=Object.assign(new EventTarget(),{localStorage:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});Object.defineProperty(globalThis,'window',{value:fake,configurable:true});let n=0;const off=subscribeAiSource(()=>n++);try{setCloudIdentity('',false);setAiSource('profile-a');assert.equal(getAiSource(),'profile-a');assert.deepEqual(aiSourceHeader(),{'X-AI-Profile':'profile-a'});fake.dispatchEvent(new Event('storage'));assert.equal(n,2);assert.deepEqual([...storage.values()],['profile-a']);setCloudIdentity('other',true);assert.notEqual(getAiSource(),'profile-a');}finally{off();setCloudIdentity('',false);Object.defineProperty(globalThis,'window',{value:old,configurable:true});}});

test('配置仍在加载时按服务端默认值请求，用户显式清空则发送 none', () => {
  const old = globalThis.window;
  const storage = new Map<string, string>();
  const fake = Object.assign(new EventTarget(), {localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  }});
  Object.defineProperty(globalThis, 'window', {value: fake, configurable: true});
  setCloudIdentity('loading-profile-test', true);
  try {
    const pending = {data: null, loading: true, error: ''};
    assert.deepEqual(aiSourceHeader(), {});
    assert.deepEqual(aiSourceHeader(describeAiSelection(pending, getAiSource()).id), {});
    setDefaultAiSource('verified-default');
    setAiSource('explicit-selection');
    storage.clear(); // Another tab selected "use default".
    assert.deepEqual(aiSourceHeader(), {'X-AI-Profile': 'verified-default'});
    setAiSource('none');
    assert.deepEqual(aiSourceHeader(), {'X-AI-Profile': 'none'});
  } finally {
    setCloudIdentity('', false);
    Object.defineProperty(globalThis, 'window', {value: old, configurable: true});
  }
});

test('浏览器拒绝本地存储时沿用已读取默认配置，也可显式切换和恢复默认', () => {
  const old = globalThis.window;
  const fake = new EventTarget();
  Object.defineProperty(fake, 'localStorage', {get() { throw new Error('storage unavailable'); }});
  Object.defineProperty(globalThis, 'window', {value: fake, configurable: true});
  setCloudIdentity('memory-profile-test', true);
  try {
    setDefaultAiSource('verified-default');
    assert.equal(getAiSource(), 'verified-default');
    setAiSource('alternate');
    assert.equal(getAiSource(), 'alternate');
    setAiSource('');
    assert.equal(getAiSource(), 'verified-default');
  } finally {
    setCloudIdentity('', false);
    Object.defineProperty(globalThis, 'window', {value: old, configurable: true});
  }
});

test('用户主动测试只发送确认的配置与版本，测试失败保留可读原因', async () => {
  const original = globalThis.fetch;
  const plan = {id: 'saved-profile', revision: 'confirmed-version'};
  const probe = {status: 'failed', at: '2026-11-18T01:00:00.000Z', message: '服务暂时无法连接'};
  const requests: unknown[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/ai/profiles');
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({probe});
  };
  try {
    assert.deepEqual(await testAiProfileConnection(plan, 'image'), probe);
    assert.deepEqual(requests, [{action: 'test', ...plan, kind: 'image'}]);
  } finally { globalThis.fetch = original; }
});

test('另一标签页编辑同一配置后，创作页会重新读取模型与验证状态', async () => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const fake = Object.assign(new EventTarget(), { BroadcastChannel });
  Object.defineProperty(globalThis, 'window', {value: fake, configurable: true});
  setCloudIdentity('updated-profile-test', true);
  let model = 'old', resolveRefresh!: () => void;
  const refreshed = new Promise<void>(resolve => { resolveRefresh = resolve; });
  globalThis.fetch = async () => Response.json({profiles: [{id: 'same-id', model}], defaultId: 'same-id'});
  const editor = new AiProfileResource(), writer = new AiProfileResource();
  const closeEditor = editor.subscribe(() => {});
  const closeWriter = writer.subscribe(() => {
    if (writer.getSnapshot().data?.profiles[0]?.model === 'new') resolveRefresh();
  });
  try {
    await writer.load();
    model = 'new';
    await editor.afterChange();
    await refreshed;
    assert.equal(writer.getSnapshot().data?.profiles[0]?.model, 'new');
  } finally {
    closeEditor(); closeWriter(); globalThis.fetch = oldFetch;
    setCloudIdentity('', false);
    Object.defineProperty(globalThis, 'window', {value: oldWindow, configurable: true});
  }
});

test('同一配置换模型后，图文页不沿用旧成功标记；图片失败原因仍能识别', () => {
  const old = {id: 'saved-profile', revision: 'v1'};
  assert.equal(isSameAiRevision(old, {...old}), true);
  assert.equal(isSameAiRevision(old, {...old, revision: 'v2'}), false);
  assert.equal(isSameAiRevision(null, old), false);
  assert.equal(safeErrorCode('VISION_UNVERIFIED'), 'VISION_UNVERIFIED');
  assert.equal(safeErrorCode('VISION_UNSUPPORTED'), 'VISION_UNSUPPORTED');
});

test('账号切换后的晚回包、旧资源刷新和默认选择更新不能污染新账号', async () => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const fake = new EventTarget();
  Object.defineProperty(globalThis, 'window', {value: fake, configurable: true});
  setCloudIdentity('first-account', true);
  const firstNamespace = 'first-account';
  const first = new AiProfileResource();
  let calls = 0, finish!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { finish = resolve; });
  globalThis.fetch = async () => { calls++; return delayed; };
  try {
    const reading = first.load();
    setCloudIdentity('second-account', true);
    setDefaultAiSource('second-default');
    setAiSource('second-choice');
    finish(Response.json({profiles: [{id: 'first-choice'}], defaultId: 'first-choice'}));
    await reading;
    assert.equal(first.getSnapshot().data, null);
    await first.afterChange();
    assert.equal(calls, 1);
    setAiSource('first-choice', firstNamespace);
    assert.equal(getAiSource(), 'second-choice');
  } finally {
    globalThis.fetch = oldFetch; setCloudIdentity('', false);
    Object.defineProperty(globalThis, 'window', {value: oldWindow, configurable: true});
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenClawBrowser, BrowserNavigationBlockedError } from '../lib/server/openclaw-browser';

const url = 'https://www.xiaohongshu.com/search_result?keyword=%E6%97%85%E8%A1%8C';
const navigation = ['navigate', url, '--target-id', 'owned'];
const pageTimeout = 'TimeoutError: page.goto: Timeout 20000ms exceeded. waiting until "load"';

test('a load timeout on a usable search page keeps its owned tab and never repeats navigation', async () => {
  const calls: string[] = [];
  const result = await runOpenClawBrowser(navigation, new AbortController().signal, async args => {
    calls.push(args[0]);
    assert.ok(args.includes('owned'));
    if (args[0] === 'navigate') throw Object.assign(new Error(), { stderr: pageTimeout });
    return { result: { url: url + '&type=51', ready: 'interactive' } };
  });
  assert.deepEqual(calls, ['navigate', 'evaluate']);
  assert.equal(result.ok, true);
});

test('recovery refuses stale results, other origins and unfinished navigation', async () => {
  for (const [actual, ready] of [[url.replace('%E6%97%85%E8%A1%8C', 'old'), 'complete'], [url.replace('www.', 'other.'), 'complete'], [url, 'loading']]) {
    await assert.rejects(() => runOpenClawBrowser(navigation, new AbortController().signal, async args =>
      args[0] === 'navigate' ? { ok: false, error: { message: pageTimeout } } : { result: { url: actual, ready } }
    ), /超时/);
  }
});

test('a navigation policy refusal or cancellation never attempts recovery', async () => {
  const signal = new AbortController();
  const calls: string[] = [];
  await assert.rejects(() => runOpenClawBrowser(navigation, signal.signal, async args => {
    calls.push(args[0]);
    throw Object.assign(new Error(), { stderr: 'browser navigation blocked by policy' });
  }), BrowserNavigationBlockedError);
  signal.abort();
  await assert.rejects(() => runOpenClawBrowser(navigation, signal.signal, async () => { calls.push('unexpected'); return {}; }), { name: 'AbortError' });
  assert.deepEqual(calls, ['navigate']);
});

test('a proxy forced on the browser reports its own policy error without revisiting the page', async () => {
  let calls = 0;
  await assert.rejects(() => runOpenClawBrowser(navigation, new AbortController().signal, async () => {
    calls++;
    throw new Error('Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed');
  }), /浏览器.*单独指定.*代理/);
  assert.equal(calls, 1);
});

test('native command and gateway deadlines check the same HTTPS document once', async () => {
  const failures = [
    Object.assign(new Error('Command failed'), {code:null,killed:true,signal:'SIGTERM'}),
    new Error('gateway timeout after 30000ms'),
    new Error('gateway request timed out after 20000ms: browser.request'),
  ];
  for (const failure of failures) {
    for (const actual of [url, url.replace('keyword=', 'old='), 'https://other.example/',url.replace('https:', 'http:')]) {
      const calls: string[] = [];
      const result = runOpenClawBrowser(navigation, new AbortController().signal, async args => {
        calls.push(args[0]);
        if (args[0] === 'navigate') throw failure;
        return {result:{url:actual,ready:'interactive'}};
      });
      if (actual === url) assert.equal((await result).ok,true);
      else await assert.rejects(result,/超时/);
      assert.deepEqual(calls,['navigate','evaluate']);
    }
  }
});

test('output overflow is not a navigation deadline and does not trigger DOM recovery', async () => {
  let count = 0;
  await assert.rejects(runOpenClawBrowser(navigation,new AbortController().signal,async ()=>{
    count++;
    throw Object.assign(new Error('maxBuffer exceeded'),{killed:true,signal:'SIGTERM',code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
  }),/BROWSER_UNAVAILABLE/);
  assert.equal(count,1);
});

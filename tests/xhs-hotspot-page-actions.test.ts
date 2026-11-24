import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { applySearchFiltersCode, readSearchCardCode } from '../lib/server/xhs-browser-dom';

test('a visible checkpoint stops both batched page actions before filters or cards are touched', async () => {
  const document = { body: { innerText: '请完成验证' }, querySelectorAll: () => [] };
  const location = { hostname: 'www.xiaohongshu.com', pathname: '/search_result' };
  for (const code of [applySearchFiltersCode({ '排序依据': '最多点赞' }), readSearchCardCode('abcdef0123456789abcdef01')]) {
    const result = await runInNewContext('(' + code + ')()', { document, location });
    assert.equal(result.state.blocked, true);
  }
});

test('a card that vanished during rendering never opens a different note', async () => {
  const document = { body: { innerText: '结果' }, querySelectorAll: () => [] };
  const location = { hostname: 'www.xiaohongshu.com', pathname: '/search_result' };
  const result = await runInNewContext('(' + readSearchCardCode('abcdef0123456789abcdef01') + ')()', { document, location });
  assert.equal(result.clicked, false);
});

test('detail collection waits for real counts and the publication date after the placeholder appears', async () => {
  const id = 'abcdef0123456789abcdef01';
  const location = { hostname: 'www.xiaohongshu.com', pathname: '/search_result' };
  let ticks = 0;
  const cover = { scrollIntoView() {}, click() { location.pathname += '/' + id; } };
  const note = { querySelector: () => cover };
  const detail = {
    querySelectorAll: () => [],
    querySelector(selector: string) {
      const ready = ticks >= 3;
      const bySelector: Record<string, string> = {
        '.title': '旅行', '#detail-desc': ready ? '实际笔记正文' : '', '.author-container .username': ready ? '作者' : '',
        '.note-content .date': ready ? '11-19' : '刚刚', '.interact-container .like-wrapper .count': ready ? '6.7万' : '',
        '.interact-container .collect-wrapper .count': ready ? '1.9万' : '收藏', '.interact-container .chat-wrapper .count': ready ? '1161' : '评论',
      };
      return selector in bySelector ? { innerText: bySelector[selector] } : null;
    },
  };
  const document = { body: { innerText: '结果' }, querySelectorAll: (s: string) => s === 'section.note-item' ? [note] : [],
    querySelector: (s: string) => s === '#noteContainer' ? detail : null };
  const result = await runInNewContext('(' + readSearchCardCode(id) + ')()', { document, location, setTimeout: (callback: () => void) => { ticks++; callback(); } });
  assert.equal(result.detail.likes, '6.7万');
  assert.equal(result.detail.date, '11-19');
  assert.equal(result.detail.body, '实际笔记正文');
});

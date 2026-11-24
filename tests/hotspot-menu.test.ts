import test from "node:test";
import assert from "node:assert/strict";
import { placeHotspotMenu } from "../lib/hotspot-menu";

test("创作菜单贴近按钮，桌面向下展开且不超出右边界", () => {
  const view = { width: 1200, height: 800, left: 0, top: 0 };
  const normal = placeHotspotMenu({ left: 300, top: 200, bottom: 236 }, 124, view);
  assert.equal(normal.left, 300); assert.equal(normal.top, 242);
  const right = placeHotspotMenu({ left: 1150, top: 200, bottom: 236 }, 124, view);
  assert.ok(right.left + right.width <= 1192);
});

test("底部空间不足向上展开，窄屏和缩放可视区内全部可达", () => {
  for (const view of [{ width: 320, height: 568, left: 0, top: 0 }, { width: 220, height: 220, left: 10, top: 30 }]) {
    const anchor = { left: view.width - 30, top: view.top + view.height - 60, bottom: view.top + view.height - 16 };
    const menu = placeHotspotMenu(anchor, 148, view);
    assert.ok(menu.top < anchor.top);
    assert.ok(menu.left >= view.left + 8);
    assert.ok(menu.left + menu.width <= view.left + view.width - 8);
    assert.ok(menu.top >= view.top + 8);
    assert.ok(menu.top + Math.min(148, menu.maxHeight) <= view.top + view.height - 8);
  }
});

test("失败说明变长仍限于可视区，保留菜单内部滚动空间", () => {
  const menu = placeHotspotMenu({ left: 100, top: 140, bottom: 184 }, 600, { width: 320, height: 420, left: 0, top: 0 });
  assert.ok(menu.maxHeight > 140 && menu.maxHeight < 600);
  assert.ok(menu.top + menu.maxHeight <= 412);
});

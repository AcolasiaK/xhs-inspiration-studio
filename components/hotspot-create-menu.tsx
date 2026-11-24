"use client";

import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, LoaderCircle, NotebookPen, PenLine } from "lucide-react";
import { placeHotspotMenu, type HotspotDestination } from "@/lib/hotspot-menu";
import styles from "@/app/hotspots/hotspots.module.css";

const destinations = [
  { value: "personal", label: "个人创作", icon: PenLine },
  { value: "photo", label: "图文创作", icon: NotebookPen },
  { value: "video", label: "视频创作", icon: Clapperboard },
] as const;

/** One anchored, non-modal menu. Draft creation remains in the existing page handlers. */
export function HotspotCreateMenu({ id, anchor, last = false, busy, error, onClose, onChoose }: {
  id: string; anchor: HTMLButtonElement; last?: boolean; busy: HotspotDestination | null; error: string;
  onClose: (restoreFocus?: boolean) => void; onChoose: (destination: HotspotDestination) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    function position() {
      if (!element || !anchor.isConnected) { close.current(); return; }
      const rect = anchor.getBoundingClientRect(), view = window.visualViewport;
      const panel = anchor.closest<HTMLElement>('[data-hotspot-scroll]');
      if (panel && ['auto', 'scroll'].includes(getComputedStyle(panel).overflowY)) {
        const bounds = panel.getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0;
        if (rect.bottom <= bounds.top + inset || rect.top >= bounds.bottom) { close.current(); return; }
      }
      const viewport = { width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight, left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0 };
      if (rect.bottom < viewport.top || rect.top > viewport.top + viewport.height) { close.current(); return; }
      const placement = placeHotspotMenu(rect, element.scrollHeight, viewport);
      Object.assign(element.style, { left: `${placement.left}px`, top: `${placement.top}px`, width: `${placement.width}px`, maxHeight: `${placement.maxHeight}px`, visibility: "visible" });
    }
    position();
    const buttons = element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target) && !anchor.contains(event.target)) close.current();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(true); }
    };
    const observer = new ResizeObserver(position);
    observer.observe(element); observer.observe(anchor);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [anchor, last]);

  function keyboard(event: KeyboardEvent) {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    // Restore the trigger before normal Tab navigation; this is not a focus trap.
    if (event.key === "Tab") onClose(true);
  }

  return createPortal(<div ref={menu} id={id} className={styles.createMenu} role="menu" aria-label="选择创作方式" onKeyDown={keyboard}>
    {destinations.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="menuitem" tabIndex={-1}
      aria-disabled={Boolean(busy)} onClick={() => { if (!busy) onChoose(value); }}>
      {busy === value ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}<span>{label}</span>
    </button>)}
    {busy && <p className={styles.createMenuStatus} role="status">{busy === "personal" ? "正在保存新个人草稿…" : "正在前往创作页…"}</p>}
    {error && <p className={styles.createMenuError} role="alert">{error}</p>}
  </div>, document.body);
}

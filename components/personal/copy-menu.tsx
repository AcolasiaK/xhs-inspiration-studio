"use client";

import { isTitleWithinLimit } from "@/lib/xhs-title";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { formatPersonalAll, formatPersonalBodyAndTags } from "@/lib/personal/note-format";
import type { ContentResult } from "@/lib/schema";

/** A disclosure, not a selected title: both actions read the current edited result. */
export function PersonalCopyMenu({ result, disabled, onError }: {
  result: ContentResult | null; disabled: boolean; onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false), [copied, setCopied] = useState("");
  const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const copying = useRef(false), id = useId();
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2400);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy(all: boolean) {
    if (!result || disabled || copying.current) return;
    copying.current = true;
    try {
      const text = all ? formatPersonalAll(result) : formatPersonalBodyAndTags(result);
      await navigator.clipboard.writeText(text);
      setCopied(all ? "已复制全部文案" : "已复制正文与话题");
      setOpen(false); trigger.current?.focus();
    } catch {
      onError("复制失败，请允许浏览器访问剪贴板后重试。当前内容已保留。");
    } finally { copying.current = false; }
  }
  return <div className="personal-copy-menu" ref={container} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} className="secondary-button" type="button" disabled={disabled}
      aria-label="复制内容" title={copied || "复制内容"} aria-expanded={open && !disabled} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {copied ? <Check/> : <Copy/>}<span>{copied ? "已复制" : "复制内容"}</span><ChevronDown/>
    </button>
    <span className="sr-only" role="status">{copied}</span>
    <div id={id} className="personal-copy-options" role="group" aria-label="复制内容选项" hidden={!open || disabled}>
      <button type="button" disabled={disabled} onClick={() => void copy(false)}>
        <span>复制正文与话题</span><small>正文 + 10 个有效话题，不含标题</small>
      </button>
      <button type="button" disabled={disabled || !result?.titles.every(isTitleWithinLimit)} onClick={() => void copy(true)}>
        <span>复制全部文案</span><small>全部标题、正文、话题、封面及逐图配文</small>
      </button>
    </div>
  </div>;
}

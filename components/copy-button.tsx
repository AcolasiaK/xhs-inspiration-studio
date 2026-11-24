"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label = "复制", className = "", onError, disabled = false, describedBy, title }: { text: string; label?: string; className?: string; onError: (message: string) => void; disabled?: boolean; describedBy?: string; title?: string }) {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copied = copiedText !== null && copiedText === text;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedText(null), 1800);
    } catch { onError("复制未成功，请选中文本手动复制；剪贴板需要 HTTPS 或本机访问。"); }
  }
  return <button type="button" className={`copy-button ${className}`} onClick={copy} aria-label={label} title={title} aria-describedby={describedBy} disabled={disabled}>
    {copied ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{copied ? "已复制" : label}</span>
  </button>;
}

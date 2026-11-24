"use client";

import { useId, useRef, useState } from "react";
import { isTitleWithinLimit, titleLength, XHS_TITLE_LIMIT } from "@/lib/xhs-title";

/** Keep IME composition local until committed. Existing long titles can be shortened in stages. */
export function XhsTitleEditor({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (next: string) => void; multiline?: boolean;
}) {
  const hint = useId();
  const composing = useRef(false);
  const [composition, setComposition] = useState<string | null>(null);
  const [overLimit, setOverLimit] = useState(false);
  function commit(next: string) {
    const accepted = isTitleWithinLimit(next) || titleLength(next) < titleLength(value);
    setOverLimit(!accepted);
    if (accepted && next !== value) onChange(next);
  }
  const displayed = composition ?? value;
  const field = {
    "aria-label": label, "aria-describedby": hint, value: displayed,
    "aria-invalid": !isTitleWithinLimit(displayed),
    onCompositionStart: () => { composing.current = true; setComposition(value); },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false; setComposition(null); commit(e.currentTarget.value);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (composing.current) setComposition(e.currentTarget.value);
      else commit(e.currentTarget.value);
    },
  };
  return <span className="xhs-title-editor">
    {multiline ? <textarea {...field} rows={1}/> : <input {...field}/>}
    <small id={hint} role={overLimit ? "status" : undefined}>
      {overLimit ? `标题最多 ${XHS_TITLE_LIMIT} 字，` : ""}{titleLength(displayed)}/{XHS_TITLE_LIMIT}
    </small>
  </span>;
}

import { useId, useState } from "react";
import { Pencil } from "lucide-react";

/** Reading never modifies the draft. Long copy has an explicit, keyboard-accessible expansion. */
export function PlanText({ text, collapsible = false, empty = "未填写" }: { text: string; collapsible?: boolean; empty?: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = collapsible && text.length > 240;
  return <div className="plan-text">
    <p id={id}>{text.trim() ? (long && !expanded ? `${text.slice(0, 240)}…` : text) : empty}</p>
    {long && <button type="button" className="text-button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? "收起全文" : "展开全文"}</button>}
  </div>;
}

export function PlanEditButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" className="secondary-button" aria-label={label} disabled={disabled} onClick={onClick}><Pencil size={14} />编辑</button>;
}

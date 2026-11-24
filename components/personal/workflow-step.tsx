"use client";

import type { ReactNode } from "react";
import type { PersonalStep } from "@/lib/personal/presentation";

/** Hidden panels remain mounted: switching never resets edits or disclosures. */
export function WorkflowStep({ step, title, subtitle, status, active, children, feedback, actions }: {
  step: PersonalStep; title: string; subtitle: string; status: string;
  active: boolean; children: ReactNode; feedback?: ReactNode; actions?: ReactNode;
}) {
  return <section id={`personal-${step}`} className="personal-workflow-panel personal-anchor"
    role="tabpanel" tabIndex={0} aria-labelledby={`personal-tab-${step}`} hidden={!active}>
    <div className="personal-panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div>{actions??<span className="personal-panel-status">{status}</span>}</div>
    <div id={`personal-${step}-content`} className="personal-step-content">{children}</div>
    {feedback && <div className="personal-step-feedback-slot">{feedback}</div>}
  </section>;
}

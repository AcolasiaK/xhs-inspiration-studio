"use client";

import { useId } from "react";
import { usePersonalStyles } from "@/lib/personal/style-client";
import type { RuleSnapshot } from "@/lib/personal/style-rules";
import { PersonalStyleLoadStatus } from "./personal/style-load-status";
import "./writing-style-picker.css";

/** The same enabled versions used by personal creation; drafts retain their selected snapshot. */
export function WritingStylePicker({ value, disabled, onChange, onManage }: {
  value?: RuleSnapshot; disabled?: boolean;
  onChange: (snapshot: RuleSnapshot | undefined) => void; onManage: () => void;
}) {
  const { data, error, loading, retry } = usePersonalStyles();
  const name = useId();
  const choices = data?.styles.flatMap(style => {
    const active = style.versions.find(version => version.snapshot.versionId === style.activeVersionId);
    return active ? [active.snapshot] : [];
  });
  const active = choices?.find(snapshot => snapshot.styleId === value?.styleId);
  return <fieldset className="writing-style-picker" disabled={disabled} aria-label="写作风格">
    <legend><span>写作风格</span><button type="button" className="text-button" onClick={onManage}>管理风格</button></legend>
    <PersonalStyleLoadStatus loading={loading && !data} error={error} onRetry={retry} disabled={disabled} />
    <div className="writing-style-choices">
      {choices?.map(snapshot => <label key={snapshot.styleId} className={value?.styleId === snapshot.styleId ? "is-selected" : ""}>
        <input type="radio" name={name} checked={value?.styleId === snapshot.styleId} onChange={() => onChange(snapshot)} />
        <span>{snapshot.content.name}</span>
      </label>)}
    </div>
    {choices?.length === 0 && <p className="field-hint">暂无已启用风格，请到管理风格中启用。</p>}
    {value ? <div className="writing-style-status"><span>本稿：{value.content.name} · v{value.version}</span>
      {active && active.versionId !== value.versionId && <button type="button" className="text-button" onClick={() => onChange(active)}>采用已启用的 v{active.version}</button>}
      <button type="button" className="text-button" onClick={() => onChange(undefined)}>取消选择</button>
      {data && !active && <span>原风格已停用或删除，本稿保留原规则；可另选风格。</span>}
    </div> : <p className="field-hint">与个人创作共用风格；未选择时沿用本稿写作要求。</p>}
  </fieldset>;
}

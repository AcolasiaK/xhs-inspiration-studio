'use client';
import { useId } from 'react';
import { usePersonalStyles } from '@/lib/personal/style-client';
import { builtinRuleSnapshot, isBuiltinStyle, type RuleSnapshot } from '@/lib/personal/style-rules';
import type { PersonalInput } from '@/lib/personal/schema';
import { PersonalStyleLoadStatus } from './style-load-status';

type PickerProps = {input:PersonalInput;disabled?:boolean;legacy?:boolean;onChange:(snapshot:RuleSnapshot)=>void;onManage?:()=>void};
export function PersonalStylePicker(props:PickerProps){
  const library = usePersonalStyles();
  return <PersonalStyleChoices {...props} library={library}/>;
}
export function PersonalStyleChoices({input,disabled,legacy,onChange,onManage,library,showUpdate=true}:PickerProps & {library:ReturnType<typeof usePersonalStyles>;showUpdate?:boolean}){
  const {data,error,loading,retry}=library;
  const radioName=useId();
  const selected=input.styles.length===1?input.styles[0]:null;
  const record=data?.styles.find(s=>s.id===selected),active=record?.versions.find(v=>v.snapshot.versionId===record.activeVersionId)?.snapshot;
  const choices=data?.styles.filter(style=>style.activeVersionId);
  const pinned=input.ruleSnapshot||(legacy&&selected&&isBuiltinStyle(selected)?builtinRuleSnapshot(selected):undefined);
  function choose(snapshot:RuleSnapshot){if(input.styles.length!==1&&!window.confirm('旧稿包含多个风格。确认后仅为后续创作选择这一种；旧提示词、笔记和原生成依据保留，生成前需重新确认方向。'))return;onChange(snapshot);}
  return <fieldset className="personal-options personal-style-options" aria-label="写作风格" disabled={disabled}><legend className="personal-style-heading"><span>写作风格</span>
    {onManage&&<button type="button" className="personal-manage-styles" onClick={onManage}>管理风格</button>}</legend>
    <PersonalStyleLoadStatus loading={loading&&!data} error={error} onRetry={retry} disabled={disabled}/>
    {input.styles.length!==1&&<p className="storage-warning">这是旧的多风格或未选择风格记录。内容完整保留；请选择一种风格，并重新准备、确认创作提示词后再生成。</p>}
    <div className="personal-style-grid">{choices?.map(s=>{const version=s.versions.find(v=>v.snapshot.versionId===s.activeVersionId)!;return <label key={s.id} className={selected===s.id?'is-selected':''}><input type="radio" name={radioName} checked={selected===s.id} onChange={()=>choose(version.snapshot)}/><span>{version.snapshot.content.name}</span></label>;})}</div>
    {choices?.length===0&&<p className="field-hint">暂无已启用的风格，请到「管理风格」启用一个版本。</p>}
    {Boolean(choices?.length)&&selected&&!active&&<p className="field-hint">原选风格已停用或删除，请为新的创作提示词选择一个风格。</p>}
    {showUpdate&&selected&&pinned&&active&&pinned.versionId!==active.versionId&&<p className="field-hint">{pinned?`本稿规则：${pinned.content.name} · v${pinned.version}`:`下次准备提示词将使用：${active!.content.name} · v${active!.version}`}{pinned&&active&&pinned.versionId!==active.versionId&&<> · 已有启用版本 v{active.version} <button type="button" className="text-button" onClick={()=>{if(window.confirm('采用新的启用规则后，需要重新生成并确认创作提示词。旧结果及生成依据保留。'))onChange(active);}}>本稿采用新规则</button></>}</p>}
  </fieldset>;
}

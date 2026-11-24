import { ExternalLink, Trash2 } from "lucide-react";
import { hotspotReferenceLink, type PersonalHotspotReference } from "@/lib/personal/hotspot-reference";

function time(value: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "来源未提供";
}
export function HotspotReference({ value, disabled, onChange, onRemove }: {
  value: PersonalHotspotReference; disabled: boolean;
  onChange: (value: PersonalHotspotReference) => void; onRemove: () => void;
}) {
  const link = hotspotReferenceLink(value.url);
  return <details className="personal-details personal-hotspot-reference" open>
    <summary>热点参考<span>来自今日热点，可修改或移除</span></summary>
    <div className="personal-hotspot-fields">
      <p className="field-hint">这份公共资料不是你的亲身经历。请在上方补充真实经历或想法，再主动生成提示词。</p>
      <label className="field">热点标题<input value={value.title} maxLength={300} disabled={disabled} onChange={e => onChange({ ...value, title: e.target.value })} /></label>
      <label className="field">热点摘要<textarea rows={3} value={value.summary} maxLength={2000} disabled={disabled} onChange={e => onChange({ ...value, summary: e.target.value })} /></label>
      <label className="field">来源名称<input value={value.source} maxLength={200} disabled={disabled} onChange={e => onChange({ ...value, source: e.target.value })} /></label>
      <label className="field">原始来源链接<input type="text" inputMode="url" value={value.url} maxLength={2048} disabled={disabled} onChange={e => onChange({ ...value, url: e.target.value })} /></label>
      {value.url && !link && <p className="field-hint" role="status">链接尚未完整，原输入仍会保存；请使用 http 或 https 链接。</p>}
      {value.angle && <label className="field">参考创作角度<textarea rows={2} value={value.angle} maxLength={1000} disabled={disabled} onChange={e => onChange({ ...value, angle: e.target.value })} /></label>}
      <p className="field-hint">发布时间：{time(value.publishedAt)} · 获取时间：{time(value.collectedAt)}（北京时间）。公共摘要尚待核实。</p>
      <div className="personal-hotspot-actions">
        {link && <a href={link} target="_blank" rel="noopener noreferrer">查看原始来源 <ExternalLink size={14} /></a>}
        <button type="button" className="text-button" disabled={disabled} onClick={onRemove}><Trash2 size={14} />移除热点参考</button>
      </div>
    </div>
  </details>;
}

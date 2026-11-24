'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Settings2 } from 'lucide-react';
import { setAiSource } from '@/lib/ai-source';
import { useAiSource } from '../use-ai-source';
import { useAiProfiles } from './usage-status';
export function AiSelector({disabled=false,compact=false,onNavigate}:{disabled?:boolean;compact?:boolean;onNavigate?:(href:string)=>void}){
 const pathname=usePathname();
 const selected=useAiSource();
 const {data,error}=useAiProfiles();
 const current=data?.profiles.find(p=>p.id===(selected||data.defaultId));
 if(compact)return <div className="app-ai-settings-entry"><Link href="/settings/ai" className="app-ai-settings-link" aria-current={pathname==='/settings/ai'?'page':undefined} aria-disabled={disabled||undefined} onNavigate={e=>{if(disabled||onNavigate){e.preventDefault();if(!disabled)onNavigate?.('/settings/ai');}}}><Settings2 size={18} strokeWidth={1.7} aria-hidden="true"/><span>AI 配置</span><ChevronRight size={14} aria-hidden="true"/></Link></div>;
 return <section className="app-ai-source" aria-label="当前 AI 配置"><div className="app-ai-source-header"><label htmlFor="global-ai-source">当前使用的配置</label></div><select id="global-ai-source" value={selected} disabled={disabled||!data} onChange={e=>setAiSource(e.target.value)}>{selected==='none'&&<option value="none">尚未选择配置</option>}<option value="">{!data?'正在读取配置…':data.defaultId?'使用默认配置':'请选择配置'}</option>{selected&&selected!=='none'&&!data?.profiles.some(p=>p.id===selected)&&<option value={selected}>{data?'原配置已不可用，请重新选择':'正在读取配置…'}</option>}{data?.profiles.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select><p className="app-ai-source-description">{current?`${current.name} · ${current.model}`:!data?'正在读取配置…':'尚未选择可用配置'}<br/>{current?`图片理解：${({passed:'已验证',failed:'未通过',unsupported:'不支持',unverified:'未验证'}[current.imageTest.status])}`:data?'请在下方添加配置。':''}</p>{error&&<p role="alert" className="app-nav-error">{error}</p>}</section>;
}

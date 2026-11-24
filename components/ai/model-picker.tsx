'use client';
import { useState } from 'react';
import type { ModelListState } from '@/lib/ai-model-list-client';

export function ModelPicker({ state, value, canQuery, onQuery, onChange }: {
  state: ModelListState; value: string; canQuery: boolean;
  onQuery: () => void; onChange: (model: string) => void;
}) {
  const [search, setSearch] = useState('');
  const matches = state.models.filter(model => model.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="ai-model-picker">
    <button type="button" disabled={!canQuery || state.status === 'loading'} onClick={() => { setSearch(''); onQuery(); }}>
      {state.status === 'loading' ? '正在获取模型列表…' : '获取模型列表'}
    </button>
    <p className="ai-help">使用当前表单的地址与密钥查询，无需先填写模型或保存；查询不会修改已保存配置。</p>
    {state.message && <p role={state.status === 'error' ? 'alert' : 'status'} className={state.status === 'error' ? 'ai-error' : ''}>{state.message}</p>}
    {state.status === 'success' && <>
      <label>搜索可用模型<input type="search" autoComplete="off" value={search} onChange={e => setSearch(e.target.value)} placeholder="输入模型名称筛选" /></label>
      <label>选择可用模型<select size={5} value={matches.includes(value) ? value : ''} onChange={e => { if (e.target.value) onChange(e.target.value); }}>
        <option value="" disabled>请选择模型</option>
        {matches.map(model => <option value={model} key={model}>{model}</option>)}
      </select></label>
      {!matches.length && <p className="ai-help">没有匹配的模型，可修改搜索词或直接手动填写。</p>}
    </>}
    <label>模型 ID<input required value={value} onChange={e => onChange(e.target.value)} placeholder="选择上方模型，或手动输入模型 ID" /></label>
    <p className="ai-help">获取列表不代表模型已通过文字或图片测试；保存后可分别验证。</p>
  </div>;
}

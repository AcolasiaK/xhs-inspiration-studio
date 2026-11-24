'use client';

export function PersonalStyleLoadStatus({loading,error,onRetry,disabled=false}:{loading:boolean;error:string;onRetry:()=>void;disabled?:boolean}){
  if(error)return <p role="alert" className="storage-error">{error} <button type="button" className="text-button" disabled={disabled||loading} onClick={onRetry}>重新读取</button></p>;
  return loading?<p role="status" className="field-hint">正在读取个人风格…</p>:null;
}

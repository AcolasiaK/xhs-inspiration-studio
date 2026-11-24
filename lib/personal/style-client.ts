'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudFetch } from '../cloud/client';
import { useCloud } from '@/components/cloud/context';
import type { StyleRecord } from './style-rules';
import type { StyleTrial } from '../server/personal-style-store';
export type PersonalStyleList={styles:StyleRecord[];trials:StyleTrial[]};
export async function personalStyleAction(body:unknown){const r=await cloudFetch('/api/personal/styles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json();if(!r.ok)throw new Error(data.error?.message||'风格操作失败，请重试。');window.dispatchEvent(new Event('xhs-personal-styles-updated'));return data as {style:StyleRecord|null};}
export function usePersonalStyles(){
  const {user,cloud}=useCloud();
  const owner=cloud?user?.id||'signed-out':'local-owner';
  const [state,setState]=useState<{owner:string;data:PersonalStyleList|null;error:string;loading:boolean}>({owner,data:null,error:'',loading:true});
  const requestNumber=useRef(0);
  const load=useCallback(async(signal?:AbortSignal)=>{
    const current=++requestNumber.current;
    setState(old=>({owner,data:old.owner===owner?old.data:null,error:'',loading:true}));
    const active=()=>!signal?.aborted&&current===requestNumber.current;
    try{
      const timeout=AbortSignal.timeout(20_000);
      const response=await cloudFetch('/api/personal/styles',{cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      const list=await response.json();
      if(!response.ok)throw new Error(list.error?.message||'无法读取风格，已有内容保留。');
      if(active())setState({owner,data:list,error:'',loading:false});
      return list as PersonalStyleList;
    }catch(error){
      if(active())setState(old=>({...old,error:error instanceof Error&&error.name==='TimeoutError'?'读取风格超时，已有内容保留，请重新读取。':error instanceof Error?error.message:'无法读取风格，已有内容保留。',loading:false}));
      throw error;
    }
  },[owner]);
  const retry=useCallback(()=>{void load().catch(()=>{});},[load]);
  const invalidate=useCallback(()=>{++requestNumber.current;},[]);
  useEffect(()=>{const controller=new AbortController();const refresh=()=>{void load(controller.signal).catch(()=>{});};refresh();window.addEventListener('focus',refresh);window.addEventListener('xhs-personal-styles-updated',refresh);return()=>{invalidate();controller.abort();window.removeEventListener('focus',refresh);window.removeEventListener('xhs-personal-styles-updated',refresh);};},[load,invalidate]);
  return {data:state.owner===owner?state.data:null,error:state.owner===owner?state.error:'',loading:state.owner!==owner||state.loading,load,retry};
}

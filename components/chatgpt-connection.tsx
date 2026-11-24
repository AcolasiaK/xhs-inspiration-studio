"use client";

import { useCallback, useEffect, useState } from "react";

type State = "disconnected" | "pending" | "connected" | "reauthorize" | "error";
type Status = {state: State; message: string; model?: string};
type Model = {slug:string; displayName:string};

/** Credentials remain exclusively in the loopback server; this component only receives status and model names. */
export function ChatGPTConnection({onChange, disabled}: {onChange:(status:Status)=>void; disabled:boolean}) {
  const [status,setStatus] = useState<Status>({state:"disconnected",message:"尚未连接 ChatGPT。"});
  const [url,setUrl] = useState("");
  const [models,setModels] = useState<Model[]>([]);
  const [working,setWorking] = useState(false);
  const update=useCallback((next:Status)=>{setStatus(next);onChange(next);},[onChange]);
  const refresh=useCallback(async()=>{
    try {
      const response=await fetch("/api/local-chatgpt/status",{cache:"no-store"});
      const data=await response.json();
      if(!response.ok || !["disconnected","pending","connected","reauthorize","error"].includes(data?.state)) throw new Error();
      update({state:data.state,message:typeof data.message==="string"?data.message:"请检查连接状态。",...(typeof data.model==="string"?{model:data.model}:{})});
      if(data.state==="connected") {
        setUrl("");
        const result=await fetch("/api/local-chatgpt/models",{cache:"no-store"});
        const list=await result.json();
        if(!result.ok || !Array.isArray(list.models)) {
          setModels([]);
          const message=typeof list?.error?.message==="string"&&list.error.message.length<=500?list.error.message:"账号模型列表暂时不可用，请检查网络后刷新连接状态。";
          update(list?.error?.code==="SIWC_AUTH"?{state:"reauthorize",message}:{state:"connected",message});
          return;
        }
        setModels(list.models.filter((x:unknown):x is Model=>Boolean(x && typeof x==="object" && typeof (x as Model).slug==="string" && typeof (x as Model).displayName==="string")));
      }
    } catch (error) { update({state:"error",message:error instanceof Error && error.message.startsWith("账号模型列表") ? error.message : "无法读取本机 ChatGPT 连接状态，请检查本机服务。"}); }
  },[update]);
  useEffect(()=>{const timer=setTimeout(()=>void refresh(),0);return()=>clearTimeout(timer);},[refresh]);
  useEffect(()=>{const handler=()=>void refresh();window.addEventListener("xhs-siwc-refresh",handler);return()=>window.removeEventListener("xhs-siwc-refresh",handler);},[refresh]);
  useEffect(()=>{if(status.state!=="pending")return;const timer=setInterval(()=>void refresh(),2500);return()=>clearInterval(timer);},[status.state,refresh]);
  async function start(){
    if(working || disabled)return;setWorking(true);setUrl("");
    try{
      const response=await fetch("/api/local-chatgpt/start",{method:"POST"}); const data=await response.json();
      if(!response.ok || typeof data?.url!=="string") throw new Error(typeof data?.error?.message==="string"?data.error.message:"无法开始授权，请稍后重试。");
      const candidate=new URL(data.url);
      if(candidate.origin!=="https://auth.openai.com" || candidate.pathname!=="/api/accounts/authorize") throw new Error("授权地址不正确，已停止连接。");
      setUrl(candidate.toString());update({state:"pending",message:"请打开 OpenAI 官方页面完成授权。"});
    }catch(error){update({state:"error",message:error instanceof Error?error.message:"无法开始授权，请稍后重试。"});}
    finally{setWorking(false);}
  }
  async function disconnect(){
    if(working || disabled)return;setWorking(true);
    try{
      const response=await fetch("/api/local-chatgpt/disconnect",{method:"POST"});const data=await response.json();if(!response.ok)throw new Error();
      setModels([]);setUrl("");update({state:"disconnected",message:data.remoteRevoked?"已断开并撤销授权。":"本机已断开；如需撤销远端授权，请在 ChatGPT 设置中管理已连接应用。"});
    } catch {update({state:"error",message:"断开失败，请稍后重试。"});} finally{setWorking(false);}
  }
  async function renew(){
    if(working||disabled)return;setWorking(true);
    try{
      const response=await fetch("/api/local-chatgpt/refresh",{method:"POST"});const data=await response.json();
      if(!response.ok){update({state:data?.error?.code==="SIWC_AUTH"?"reauthorize":"error",message:typeof data?.error?.message==="string"?data.error.message:"连接更新失败，请稍后重试。"});return;}
      await refresh();
    }catch{update({state:"error",message:"连接更新失败，请检查网络后重试。"});}finally{setWorking(false);}
  }
  async function choose(model:string){
    if(working||disabled)return;setWorking(true);
    try{
      const response=await fetch("/api/local-chatgpt/models",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model})});
      if(!response.ok)throw new Error();update({...status,model,message:"模型已选择；图片及结构化输出需通过实际生成验证。"});
    }catch{update({...status,message:"模型选择失败，请重试。"});}finally{setWorking(false);}
  }
  return <section className="chatgpt-connection" aria-label="ChatGPT 订阅连接">
    <p role="status"><strong>{status.state==="connected"?"已连接":status.state==="pending"?"等待授权":status.state==="reauthorize"?"需要重新授权":status.state==="error"?"连接失败":"未连接"}</strong>：{status.message}</p>
    <p className="field-hint">使用你的 ChatGPT 套餐额度，需要联网。失败不会自动切换中转 API。热点榜单独立采集；个人创作的联网检索方式以该页说明和实际来源为准。</p>
    {status.state!=="connected" && <button type="button" className="secondary-button" disabled={working||disabled||status.state==="pending"} onClick={()=>void start()}>连接 ChatGPT</button>}
    {url && <p><a href={url} target="_blank" rel="noopener noreferrer">Continue with ChatGPT · 打开 OpenAI 官方授权页面</a></p>}
    {status.state==="pending" && <button type="button" className="text-button" disabled={working||disabled} onClick={()=>void disconnect()}>取消连接</button>}
    {(status.state==="reauthorize" || status.state==="error") && <button type="button" className="text-button" disabled={working||disabled} onClick={()=>void renew()}>尝试更新连接</button>}
    {status.state==="connected" && <><label htmlFor="chatgpt-model">账号可用模型</label><select id="chatgpt-model" disabled={working||disabled} value={status.model??""} onChange={e=>void choose(e.target.value)}><option value="">请选择模型</option>{models.map(model=><option value={model.slug} key={model.slug}>{model.displayName}</option>)}</select><p className="field-hint">模型出现在列表中不代表已验证图片与结构化输出。</p><button type="button" className="text-button" disabled={working||disabled} onClick={()=>void disconnect()}>断开 ChatGPT 连接</button></>}
    {status.state!=="pending" && <button type="button" className="text-button" disabled={working||disabled} onClick={()=>void refresh()}>刷新连接状态</button>}
  </section>;
}

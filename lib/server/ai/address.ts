import "server-only";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { AppError } from "@/lib/errors";
import { publicIP } from "./ip";
import { resolvePublicAddresses } from "./resolver";
import { aiHttpsAgent, resolveAiProxy } from './proxy-agent';
export { publicIP } from "./ip";
export function normalizeBaseUrl(value:string,provider?:string){
  let u:URL;try{u=new URL(value.trim());}catch{throw new AppError("INVALID_BASE_URL","请输入完整的 API 基础地址。",400);}
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash||/%|\\/.test(value)||u.pathname.replace(/\/+$/u,'').includes('//'))throw new AppError("INVALID_BASE_URL","地址只支持 http/https，不能包含账号、密码、查询参数或片段。",400);
  const path=u.pathname.replace(/\/+$/u,"");
  if(/\/(responses|chat\/completions|models)$/i.test(path)||/\/v1\/v1/i.test(path))throw new AppError("INVALID_BASE_URL","请填写基础地址，可包含 /v1；不要填写 /responses、/chat/completions 或重复 /v1。",400);
  const host=u.hostname.replace(/^\[|\]$/g,"");
  if(host==="localhost"||!host.includes('.')&&!isIP(host)||host.endsWith('.local')||host.endsWith('.internal')||isIP(host)&&!publicIP(host))throw new AppError("INVALID_BASE_URL","API 地址必须是公开服务地址，不能访问本机或内网。",400);
  const result=u.origin+path;
  if(provider==="openai"&&result!=="https://api.openai.com/v1"||provider==="deepseek"&&!["https://api.deepseek.com","https://api.deepseek.com/v1"].includes(result))throw new AppError("INVALID_BASE_URL","官方服务请使用预填地址；其他地址请选择自定义／中转站并填写对应密钥。",400);
  return result;
}
/** Resolve once and pin the socket to a checked IP; never follow redirects. */
export const safeFetch: typeof fetch = async (input,init) => {
  const req=new Request(input,init),u=new URL(req.url);
  normalizeBaseUrl(u.origin);
  const proxy=await resolveAiProxy(req.signal);
  if(proxy&&u.protocol!=='https:')throw new AppError('NETWORK_CONFIG','使用本机 AI 代理时仅允许 HTTPS 服务地址，避免明文发送密钥。',400);
  const host=u.hostname.replace(/^\[|\]$/g,"");
  req.signal.throwIfAborted();
  const addresses=await resolvePublicAddresses(host,req.signal,proxy);
  req.signal.throwIfAborted();
  const address=addresses[0],body=req.method==="GET"?undefined:Buffer.from(await req.arrayBuffer());
  const agent=u.protocol==="https:"?aiHttpsAgent(address.address,host,Number(u.port||443),req.signal,proxy):new http.Agent({keepAlive:false});
  try { return await new Promise<Response>((resolve,reject)=>{
    // Node forwards socket options, though http.RequestOptions omits this net option.
    const socketOptions:https.RequestOptions&{autoSelectFamily:false}={agent,rejectUnauthorized:true,method:req.method,headers:Object.fromEntries(req.headers),signal:req.signal,autoSelectFamily:false,family:address.family,lookup:(_h,_o,cb)=>cb(null,address.address,address.family)};
    const r=(u.protocol==="https:"?https:http).request(u,socketOptions,res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(c:Buffer)=>{size+=c.length;if(size>2*1024*1024){r.destroy(new Error('RESPONSE_LIMIT'));return;}chunks.push(c);});
      res.on('error',reject);res.on('end',()=>{const status=res.statusCode||502;resolve(new Response([204,304].includes(status)?null:Buffer.concat(chunks),{status,headers:{'content-type':String(res.headers['content-type']||'application/json')}}));});
    });r.on('error',reject);r.end(body);
  }); } finally { agent.destroy(); }
};

import "server-only";
import { createHash, randomBytes, randomUUID, createPublicKey, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { verify } from "jsonwebtoken";
import { AppError } from "@/lib/errors";
import { isCloudMode } from "@/lib/cloud/mode";

const ISSUER = "https://auth.openai.com", RESOURCE = "https://api.openai.com/v1";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`, TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`, DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const REQUIRED = ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{4,200}$/u;
const MODEL = /^[A-Za-z0-9_.-]{1,128}$/u;
type RecordFile = { version:1; hostId:string; clientId?:string; subject?:string; email?:string; accessToken?:string; refreshToken?:string; idToken?:string; scopes?:string[]; expiresAt?:number; model?:string };
type Pending = { state:string; nonce:string; verifier:string; redirect:string; expectedClient?:string; expectedSubject?:string; server:Server; expires:number; timer:ReturnType<typeof setTimeout>; used:boolean };
type State = { pending?:Pending; starting?:boolean; error?:string; needsReauth?:boolean; queue:Promise<unknown>; generation:number; active:Set<AbortController> };
const shared = globalThis as typeof globalThis & { __xhsSiwc?:State };
const memory = shared.__xhsSiwc ??= {queue:Promise.resolve(),generation:0,active:new Set()};
memory.active ??= new Set();

/** These operations can only be used by explicitly loopback-only personal mode. */
export function assertPersonalMode() {
  if (isCloudMode() || process.env.APP_MODE !== "local" || process.env.APP_LOCAL_ONLY !== "1" || process.env.VERCEL) throw new AppError("NOT_FOUND", "此功能只在本机个人模式可用。", 404);
}
function dir() { return process.env.NODE_ENV === "test" && process.env.SIWC_TEST_DIR ? process.env.SIWC_TEST_DIR : path.join(process.cwd(), ".local-data", "chatgpt-auth"); }
function filename() { return path.join(dir(), "connection.json"); }
async function ensureDir() {
  assertPersonalMode(); await mkdir(dir(), {recursive:true,mode:0o700});
  const info=await lstat(dir()); if(!info.isDirectory() || info.isSymbolicLink()) throw new AppError("SIWC_STORAGE", "本机授权目录不可用。", 500);
  await chmod(dir(),0o700);
}
async function load():Promise<RecordFile|null> {
  await ensureDir();
  try {
    const info=await lstat(filename()); if(!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)!==0) throw new Error("UNSAFE_FILE");
    const raw=JSON.parse(await readFile(filename(),"utf8")) as RecordFile;
    if(raw.version!==1 || !/^urn:uuid:[0-9a-f-]{36}$/iu.test(raw.hostId) || (raw.clientId && !CLIENT.test(raw.clientId))) throw new Error("INVALID_FILE");
    return raw;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AppError("SIWC_STORAGE", "本机授权信息无法安全读取，请重新连接。", 500);
  }
}
async function save(data:RecordFile) {
  await ensureDir(); const tmp=path.join(dir(),`.write-${randomUUID()}`);
  try { const file=await open(tmp,"wx",0o600); try {await file.writeFile(JSON.stringify(data),"utf8");await file.sync();} finally {await file.close();} await rename(tmp,filename()); }
  finally {await unlink(tmp).catch(()=>undefined);}
}
function serialized<T>(operation:()=>Promise<T>):Promise<T> {
  const next=memory.queue.catch(()=>undefined).then(operation); memory.queue=next; return next;
}
/** Serialize rotating refresh tokens across local server processes. */
async function withCredentialLock<T>(operation:()=>Promise<T>):Promise<T> {
  await ensureDir();const lock=path.join(dir(),"refresh.lock"),started=Date.now();
  while(true){
    let file;
    try {
      file=await open(lock,"wx",0o600);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      try {
        const stat=await lstat(lock);
        if(stat.isFile()&&!stat.isSymbolicLink()&&Date.now()-stat.mtimeMs>60_000){
          const item=JSON.parse(await readFile(lock,"utf8")) as {pid?:unknown};
          if(typeof item.pid==="number"&&Number.isInteger(item.pid)&&item.pid>0){
            let alive=true;try{process.kill(item.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==="ESRCH")alive=false;}
            if(!alive){const again=await lstat(lock);if(again.ino===stat.ino)await unlink(lock);}
          }
        }
      }catch{/* A concurrent process may have removed the lock. */}
      if(Date.now()-started>20_000)throw new AppError("SIWC_BUSY","本机授权正在更新，请稍后重试。",409);
      await new Promise(resolve=>setTimeout(resolve,100));
      continue;
    }
    try {await file.writeFile(JSON.stringify({pid:process.pid}));await file.close();return await operation();}
    finally {await file.close().catch(()=>undefined);await unlink(lock).catch(()=>undefined);}
  }
}
function random() {return randomBytes(32).toString("base64url");}
function equal(a:string,b:string) {const x=createHash("sha256").update(a).digest(), y=createHash("sha256").update(b).digest();return timingSafeEqual(x,y);}
function closePending() {const p=memory.pending;if(p){clearTimeout(p.timer);p.server.close();memory.pending=undefined;}}
async function boundedFetch(url:string, init:RequestInit={}, maxBytes=256_000) {
  const signal=init.signal??AbortSignal.timeout(15_000);let onAbort:(()=>void)|undefined;
  if(signal.aborted)throw new DOMException("请求中止","AbortError");
  const stopped=new Promise<never>((_,reject)=>{onAbort=()=>reject(new DOMException("请求中止","AbortError"));if(signal.aborted)onAbort();else signal.addEventListener("abort",onAbort,{once:true});});
  try {
    const response=await Promise.race([fetch(url,{...init,redirect:"error",signal}),stopped]);
    const length=Number(response.headers.get("content-length"));if(Number.isFinite(length)&&length>maxBytes){void response.body?.cancel().catch(()=>undefined);throw new Error("TOO_LARGE");}
    if(!response.body){if(!response.ok)throw new RemoteHttpError(response.status,"");throw new Error("EMPTY_RESPONSE");}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
    try {while(true){const part=await Promise.race([reader.read(),stopped]);if(part.done)break;total+=part.value.byteLength;if(total>maxBytes)throw new Error("TOO_LARGE");chunks.push(part.value);}}
    finally {void reader.cancel().catch(()=>undefined);}
    const text=Buffer.concat(chunks.map(value=>Buffer.from(value))).toString("utf8");
    if(!response.ok){
      // OAuth error codes are inspected only for classification; response bodies are never logged or surfaced.
      let code="";try{const body=JSON.parse(text) as {error?:unknown};if(body.error==="invalid_grant")code="invalid_grant";}catch{/* Unparseable response has no trusted OAuth code. */}
      throw new RemoteHttpError(response.status,code);
    }
    return JSON.parse(text) as Record<string,unknown>;
  } finally {if(onAbort)signal.removeEventListener("abort",onAbort);}
}
class RemoteHttpError extends Error {constructor(public status:number,public oauthCode:string){super("REMOTE_HTTP_ERROR");}}
/** Verify signature with pinned OpenAI JWKS, issuer, audience, nonce and time. */
export async function validateIdentity(idToken:string,clientId:string,nonce:string,jwks?:unknown) {
  if(idToken.length>32_000||!CLIENT.test(clientId))throw new Error("INVALID_ID_TOKEN");
  const [encoded]=idToken.split(".");const header=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8")) as {alg?:unknown;kid?:unknown};
  if(header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length>256)throw new Error("INVALID_ID_TOKEN");
  const result=(jwks ?? await boundedFetch(JWKS)) as {keys?:unknown};
  if(!Array.isArray(result.keys))throw new Error("INVALID_JWKS");
  const keys=result.keys.filter((key:Record<string,unknown>)=>key && key.kid===header.kid && key.kty==="RSA" && (!key.alg || key.alg==="RS256") && (!key.use || key.use==="sig"));
  if(keys.length!==1)throw new Error("UNKNOWN_SIGNING_KEY");
  const key=createPublicKey({key:keys[0],format:"jwk"});
  const claims=verify(idToken,key,{algorithms:["RS256"],issuer:ISSUER,audience:clientId,clockTolerance:5});
  const now=Math.floor(Date.now()/1000);
  if(typeof claims==="string"||typeof claims.sub!=="string"||!claims.sub||claims.nonce!==nonce||typeof claims.exp!=="number"||typeof claims.iat!=="number"||claims.iat>now+5 || (Array.isArray(claims.aud)&&claims.aud.length>1&&claims.azp!==clientId))throw new Error("INVALID_IDENTITY");
  return {subject:claims.sub,email:typeof claims.email==="string"&&claims.email.length<=320?claims.email:undefined};
}
function tokens(data:Record<string,unknown>,old?:RecordFile) {
  const scope=typeof data.scope==="string"?data.scope.split(/\s+/u).filter(Boolean):old?.scopes??[];
  if(!REQUIRED.every(s=>scope.includes(s)) || typeof data.access_token!=="string" || !data.access_token || typeof data.refresh_token!=="string" || !data.refresh_token || String(data.token_type).toLowerCase()!=="bearer" || typeof data.expires_in!=="number" || data.expires_in<=0 || data.expires_in>86400)throw new Error("INVALID_TOKEN_RESPONSE");
  return {accessToken:data.access_token,refreshToken:data.refresh_token,scopes:scope,expiresAt:Date.now()+data.expires_in*1000};
}
async function exchange(params:URLSearchParams) {
  return boundedFetch(TOKEN,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString()});
}
async function complete(p:Pending,query:URLSearchParams,generation:number) {
  try {
    if(query.getAll("state").length!==1 || !equal(query.get("state")??"",p.state))throw new Error("STATE_MISMATCH");
    if(query.has("error"))throw new Error("DENIED");
    const code=query.get("code")??"", supplied=query.get("client_id")??"", clientId=p.expectedClient??supplied;
    if(query.getAll("code").length!==1 || code.length<1 || code.length>8192 || !CLIENT.test(clientId) || (p.expectedClient && supplied && supplied!==p.expectedClient))throw new Error("BAD_CALLBACK");
    const current=await load(); if(!current)throw new Error("HOST_MISSING");
    const data=await exchange(new URLSearchParams({grant_type:"authorization_code",client_id:clientId,code,code_verifier:p.verifier,redirect_uri:p.redirect,resource:RESOURCE}));
    if(typeof data.id_token!=="string")throw new Error("MISSING_ID_TOKEN");
    const identity=await validateIdentity(data.id_token,clientId,p.nonce);
    if(p.expectedSubject && identity.subject!==p.expectedSubject)throw new Error("IDENTITY_MISMATCH");
    const issuedTokens=tokens(data);
    if(memory.generation!==generation)return;
    await serialized(()=>withCredentialLock(async()=>{
      if(memory.generation!==generation)return;
      const latest=await load();if(!latest||latest.hostId!==current.hostId||(p.expectedClient&&latest.clientId!==p.expectedClient))throw new Error("REGISTRATION_CHANGED");
      await save({...latest,clientId,subject:identity.subject,email:identity.email,idToken:data.id_token as string,...issuedTokens});
    }));
    if(memory.generation===generation){memory.error=undefined;memory.needsReauth=false;}
  } catch {if(memory.generation===generation)memory.error="授权未完成或身份验证失败，请重新连接。";} finally {if(memory.pending===p)closePending();}
}
export async function startAuthorization() {
  assertPersonalMode(); if(memory.pending || memory.starting)throw new AppError("SIWC_BUSY","已有授权正在进行，请先完成或取消。",409);
  memory.starting=true;
  try {
  let current=await load();if(!current){current={version:1,hostId:`urn:uuid:${randomUUID()}`};await save(current);}
  const state=random(),nonce=random(),verifier=random(),generation=++memory.generation;
  // The listener may receive a request before the pending record is initialized.
  // eslint-disable-next-line prefer-const
  let pending!:Pending;
  const server=createServer((request,response)=>{
    const host=request.headers.host??"";
    const headers={"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"};
    if(!pending || request.method!=="GET" || host!==`127.0.0.1:${new URL(pending.redirect).port}` || !request.url || request.url.length>12000){response.writeHead(400,headers);response.end("请求无效。");return;}
    const url=new URL(request.url,pending.redirect);
    if(url.pathname!=="/auth/callback" || pending.used || Date.now()>pending.expires){response.writeHead(400,headers);response.end("授权已结束，请回到工作台重试。");return;}
    if(!equal(url.searchParams.get("state")??"",pending.state)){response.writeHead(400,headers);response.end("授权状态不匹配。");return;}
    pending.used=true;
    response.writeHead(200,headers);response.end("<!doctype html><meta charset=utf-8><title>返回工作台</title><p>已收到授权结果，请返回工作台查看连接状态。</p><script>history.replaceState(null,'','/auth/callback')</script>");
    void complete(pending,url.searchParams,generation);
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve());});
  if(memory.generation!==generation){server.close();throw new AppError("CANCELLED","授权已取消。",499);}
  const address=server.address();if(!address || typeof address==="string"){server.close();throw new Error("LISTENER_FAILED");}
  const redirect=`http://127.0.0.1:${address.port}/auth/callback`;
  const timer=setTimeout(()=>{if(memory.pending===pending){memory.error="授权等待超时，请重新连接。";closePending();}},5*60_000);timer.unref();
  pending={state,nonce,verifier,redirect,server,timer,expires:Date.now()+5*60_000,used:false,expectedClient:current.clientId,expectedSubject:current.subject};memory.pending=pending;memory.error=undefined;
  const query=new URLSearchParams({client_id:current.clientId??"dynamic_agent_client",ext_agent_host_id:current.hostId,response_type:"code",redirect_uri:redirect,scope:"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",resource:RESOURCE,state,nonce,code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url")});
  if(!current.clientId)query.set("agent_name_hint","小红书灵感工作台");
  return {url:`${AUTHORIZE}?${query.toString()}`};
  } finally {memory.starting=false;}
}
/** Disconnect immediately aborts requests already in flight. */
export function trackInference(signal?:AbortSignal) {
  assertPersonalMode();const controller=new AbortController();memory.active.add(controller);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  return {signal:combined,release:()=>memory.active.delete(controller)};
}
export async function connectionStatus() {
  assertPersonalMode(); if(memory.pending)return {state:"pending",message:"请在 OpenAI 官方页面完成授权。"};
  if(memory.needsReauth)return {state:"reauthorize",message:"ChatGPT 授权已失效，请重新连接。"};
  if(memory.error)return {state:"error",message:memory.error};
  const item=await load();if(!item?.accessToken || !item.refreshToken)return {state:"disconnected",message:"尚未连接 ChatGPT 订阅。"};
  if(!item.scopes || !REQUIRED.every(scope=>item.scopes?.includes(scope)))return {state:"reauthorize",message:"授权权限不足，请重新连接。",model:item.model};
  if(!item.expiresAt || item.expiresAt<=Date.now())return {state:"reauthorize",message:"连接需要更新；再次使用时会尝试安全刷新。",model:item.model};
  return {state:"connected",message:"已连接 ChatGPT 订阅；图片及结构化能力以实际请求为准。",model:item.model};
}
export async function accessToken() {
  assertPersonalMode();return serialized(async()=>{
    const first=await load();if(!first?.accessToken||!first.refreshToken||!first.clientId||!first.expiresAt||!first.scopes||!REQUIRED.every(scope=>first.scopes?.includes(scope)))throw new AppError("SIWC_AUTH","请先连接 ChatGPT 订阅并授予使用权限。",401);
    if(first.expiresAt>Date.now()+60_000)return first;
    return withCredentialLock(async()=>{
      const current=await load();if(!current?.accessToken||!current.refreshToken||!current.clientId||!current.expiresAt)throw new AppError("SIWC_AUTH","请先连接 ChatGPT 订阅。",401);
      if(current.expiresAt>Date.now()+60_000)return current;
      try {
        const data=await exchange(new URLSearchParams({grant_type:"refresh_token",client_id:current.clientId,refresh_token:current.refreshToken,resource:RESOURCE}));
        const next={...current,...tokens(data,current)};await save(next);memory.error=undefined;memory.needsReauth=false;return next;
      }catch(error) {
        if(error instanceof RemoteHttpError&&(error.status===401||error.oauthCode==="invalid_grant")){markNeedsReauth();throw new AppError("SIWC_AUTH","ChatGPT 授权已失效，请重新连接。",401);}
        if(error instanceof RemoteHttpError&&error.status===403)throw new AppError("SIWC_PERMISSION","当前账号或工作区暂不允许更新订阅授权，请检查使用权限。",403);
        if(error instanceof RemoteHttpError)throw new AppError("SIWC_ERROR","授权服务暂时无法更新连接，请稍后重试。",502);
        throw new AppError("PROVIDER_NETWORK","无法更新 ChatGPT 连接，请检查网络后重试。",502);
      }
    });
  });
}
export async function listModels(signal?:AbortSignal) {
  const auth=await accessToken();let data:Record<string,unknown>;
  try {data=await boundedFetch(`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${auth.accessToken}`},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):undefined},2*1024*1024);}catch(error){if(signal?.aborted)throw new AppError("CANCELLED","本次生成已取消，已有内容保留。",499);if(error instanceof RemoteHttpError&&error.status===401){markNeedsReauth();throw new AppError("SIWC_AUTH","ChatGPT 授权已失效，请重新连接。",401);}if(error instanceof RemoteHttpError&&error.status===403)throw new AppError("SIWC_PERMISSION","当前账号或工作区无权访问模型列表，请检查使用权限。",403);throw new AppError("SIWC_MODELS","无法读取账号可用模型，请检查网络后重试。",502);}
  if(!Array.isArray(data.models))throw new AppError("SIWC_MODELS","账号模型列表不可用，请稍后重试。",502);
  const models=(data.models as Record<string,unknown>[]).filter(item=>item?.visibility==="list"&&typeof item.slug==="string"&&MODEL.test(item.slug)&&typeof item.display_name==="string").slice(0,100).map(item=>({slug:item.slug as string,displayName:String(item.display_name).slice(0,100)}));
  return {models,selectedModel:auth.model};
}
export async function refreshConnection() { await accessToken();return connectionStatus(); }
export function markNeedsReauth() {memory.needsReauth=true;memory.error=undefined;}
export async function selectModel(model:string) {
  if(!MODEL.test(model))throw new AppError("INVALID_FORM","请选择账号可用模型。",400);
  const available=await listModels();if(!available.models.some(item=>item.slug===model))throw new AppError("SIWC_MODELS","该模型不在当前账号可用列表中。",400);
  await serialized(()=>withCredentialLock(async()=>{const current=await load();if(!current?.accessToken)throw new AppError("SIWC_AUTH","请先连接 ChatGPT。",401);await save({...current,model});}));
}
export async function disconnect() {
  assertPersonalMode();++memory.generation;closePending();memory.error=undefined;memory.needsReauth=false;for(const controller of memory.active)controller.abort();memory.active.clear();
  return serialized(()=>withCredentialLock(async()=>{
    const current=await load();if(!current)return {ok:true,remoteRevoked:true};let remoteRevoked=!current.refreshToken;
    if(current.refreshToken&&current.clientId){try{
      // The discovery document is fetched only from the pinned OpenAI issuer. Reject
      // an unexpected issuer or endpoint before sending any credential.
      const discovery=await boundedFetch(DISCOVERY,{signal:AbortSignal.timeout(8_000)});
      if(discovery.issuer!==ISSUER||typeof discovery.revocation_endpoint!=="string")throw new Error("INVALID_DISCOVERY");
      const revoke=new URL(discovery.revocation_endpoint);
      if(revoke.protocol!=="https:"||revoke.hostname!=="auth.openai.com"||revoke.username||revoke.password||revoke.port||revoke.search||revoke.hash)throw new Error("INVALID_REVOCATION_ENDPOINT");
      const response=await fetch(revoke.href,{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:current.refreshToken,token_type_hint:"refresh_token",client_id:current.clientId}).toString(),signal:AbortSignal.timeout(8_000)});remoteRevoked=response.status===200;
    }catch{remoteRevoked=false;}}
    const keep:RecordFile={version:1,hostId:current.hostId,clientId:current.clientId,subject:current.subject,email:current.email,model:current.model};await save(keep);
    return {ok:true,remoteRevoked};
  }));
}

import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GET, POST } from "../app/api/cloud/auth/[action]/route";
import { gateCookieName, hashSecret, userCookieName } from "../lib/cloud/server/auth";
import { createRepository, getRepository, type Transaction } from "../lib/cloud/server/repository";

const originalEnv={...process.env}; let directory="";
const origin="http://127.0.0.1:3212";
const gate="testing-old-gate-passphrase", nextGate="testing-new-gate-passphrase", bootstrap="testing-bootstrap-passphrase", adminPass="testing-admin-password", tempPass="testing-temp-password", userPass="testing-user-password";
const context=(action:string)=>({params:Promise.resolve({action})});
before(async()=>{directory=await mkdtemp(join(tmpdir(),"xhs-admin-controls-"));process.env={...process.env,NODE_ENV:"test",APP_MODE:"cloud",APP_ORIGIN:origin,CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(directory,"test.sqlite"),SITE_ACCESS_HASH:await hashSecret(gate),ADMIN_BOOTSTRAP_HASH:await hashSecret(bootstrap)};});
after(async()=>{process.env=originalEnv;await rm(directory,{recursive:true,force:true});});
function req(action:string,data:unknown,cookie="",id="",requestOrigin=origin) {return new Request(`${origin}/api/cloud/auth/${action}`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json",...(cookie?{cookie}:{}),...(id?{"x-workspace-user":id}:{})},body:JSON.stringify(data)});}
function get(action:string,cookie="",id=""){return new Request(`${origin}/api/cloud/auth/${action}`,{headers:{...(cookie?{cookie}:{}),...(id?{"x-workspace-user":id}:{})}});}
const call=(action:string,data:unknown,cookie="",id="",requestOrigin=origin)=>POST(req(action,data,cookie,id,requestOrigin),context(action));
function cookie(response:Response,name:string){const match=(response.headers.get("set-cookie")||"").match(new RegExp(`(?:^|,\\s*)(${name}=[^;]+)`));assert.ok(match);return match[1];}
const both=(a:string,b:string)=>`${a}; ${b}`;
async function status(cookies:string){const r=await GET(get("status",cookies),context("status"));assert.equal(r.status,200);return r.json();}

test("唯一管理员创建、停用、启用与重置普通账号均按身份校验",async()=>{
 const gateCookie=cookie(await call("gate",{secret:gate}),gateCookieName());
 const setupAttempts=await Promise.all([call("setup",{bootstrapSecret:bootstrap,username:"admin",password:adminPass},gateCookie),call("setup",{bootstrapSecret:bootstrap,username:"admin",password:adminPass},gateCookie)]);
 assert.deepEqual(setupAttempts.map(r=>r.status).sort(),[200,409]);
 const adminCookie=cookie(setupAttempts.find(r=>r.status===200)!,userCookieName());
 const admin=(await status(both(gateCookie,adminCookie))).user;
 assert.equal((await call("create",{username:"friend",password:tempPass,role:"admin"},both(gateCookie,adminCookie),admin.id)).status,400);
 assert.equal((await call("create",{username:"friend",password:tempPass},both(gateCookie,adminCookie),admin.id,"https://evil.invalid")).status,403);
 assert.equal((await call("create",{username:"friend",password:tempPass},both(gateCookie,adminCookie),admin.id)).status,200);
 assert.equal((await call("create",{username:"FRIEND",password:tempPass},both(gateCookie,adminCookie),admin.id)).status,409);
 const login=await call("login",{username:"friend",password:tempPass},gateCookie);assert.equal(login.status,200);
 const oldCookie=cookie(login,userCookieName()), friend=(await status(both(gateCookie,oldCookie))).user;
 assert.equal(friend.mustChange,true);
 assert.equal((await GET(get("users",both(gateCookie,oldCookie),friend.id),context("users"))).status,403);
 assert.equal((await call("change",{oldPassword:tempPass,newPassword:userPass},both(gateCookie,oldCookie),friend.id)).status,200);
 const friendCookie=cookie(await call("login",{username:"friend",password:userPass},gateCookie),userCookieName());
 assert.equal((await call("toggle",{userId:friend.id,enabled:false},both(gateCookie,friendCookie),friend.id)).status,403);
 assert.equal((await call("toggle",{userId:admin.id,enabled:false},both(gateCookie,adminCookie),admin.id)).status,403);
 assert.equal((await call("reset",{userId:admin.id,password:tempPass},both(gateCookie,adminCookie),admin.id)).status,403);
 assert.equal((await call("toggle",{userId:friend.id,enabled:false},both(gateCookie,adminCookie),admin.id)).status,200);
 assert.equal((await status(both(gateCookie,friendCookie))).user,null);
 assert.equal((await call("login",{username:"friend",password:userPass},gateCookie)).status,401);
 const list=await GET(get("users",both(gateCookie,adminCookie),admin.id),context("users"));const users=await list.json();
 assert.equal(users.users.find((u:{id:string})=>u.id===friend.id).disabled,true);
 assert.doesNotMatch(JSON.stringify(users),/password|hash|testing-/);
 assert.equal((await call("toggle",{userId:friend.id,enabled:true},both(gateCookie,adminCookie),admin.id)).status,200);
 assert.equal((await status(both(gateCookie,friendCookie))).user,null);
 const fresh=await call("login",{username:"friend",password:userPass},gateCookie);assert.equal(fresh.status,200);
 assert.equal((await call("reset",{userId:friend.id,password:tempPass},both(gateCookie,adminCookie),admin.id)).status,200);
 assert.equal((await status(both(gateCookie,cookie(fresh,userCookieName())))).user,null);
});

test("更换统一口令使旧验证失效，账号登录状态不被延长",async()=>{
 const gateCookie=cookie(await call("gate",{secret:gate}),gateCookieName());
 const adminCookie=cookie(await call("login",{username:"admin",password:adminPass},gateCookie),userCookieName());
 const admin=(await status(both(gateCookie,adminCookie))).user;
 assert.equal((await call("gate-change",{currentSecret:"wrong-password",newSecret:nextGate},both(gateCookie,adminCookie),admin.id)).status,401);
 assert.equal((await call("gate-change",{currentSecret:gate,newSecret:nextGate},both(gateCookie,adminCookie),admin.id)).status,200);
 assert.equal((await status(both(gateCookie,adminCookie))).gateVerified,false);
 assert.equal((await call("gate",{secret:gate})).status,401);
 const newGateCookie=cookie(await call("gate",{secret:nextGate}),gateCookieName());
 assert.equal((await status(both(newGateCookie,adminCookie))).user.username,"admin");
 const serialized=JSON.stringify(await (await getRepository()).scan("system"));
 for(const secret of [gate,nextGate,bootstrap,adminPass,tempPass,userPass])assert.ok(!serialized.includes(secret));
});

test("统一口令覆盖及保护标记存入数据库，可由重建的仓库读取",async()=>{
 const reopened=await createRepository();
 const marker=await reopened.get<{enabled:boolean}>("system","gate_secret_active");
 const stored=await reopened.get<{hash:string}>("system","gate_secret");
 assert.equal(marker?.enabled,true);assert.ok(stored?.hash.startsWith("scrypt:"));
 assert.notEqual(stored?.hash,gate);assert.notEqual(stored?.hash,nextGate);
});

test("旧版已有口令覆盖但无标记时，成功验证会安全补齐标记",async()=>{
 const db=await getRepository();await db.remove("system","gate_secret_active");
 try {
  assert.equal((await call("gate",{secret:nextGate})).status,200);
  assert.deepEqual(await db.get("system","gate_secret_active"),{enabled:true});
 } finally {await db.put("system","gate_secret_active",{enabled:true});}
});

test("管理员初始化标记损坏时，已有账号阻止创建第二个管理员",async()=>{
 const gateCookie=cookie(await call("gate",{secret:nextGate}),gateCookieName());
 const db=await getRepository(), marker=await db.get("system","admin_bootstrapped");assert.ok(marker);
 try {
  await db.put("system","admin_bootstrapped",null);
  assert.equal((await call("setup",{bootstrapSecret:bootstrap,username:"secondadmin",password:adminPass},gateCookie)).status,409);
  assert.equal(await db.get("user_names","secondadmin"),null);
 } finally {await db.put("system","admin_bootstrapped",marker);}
});

test("口令覆盖记录丢失时拒绝回退旧口令",async()=>{
 const db=await getRepository(), replacement=await db.get("system","gate_secret");assert.ok(replacement);
 try {
  await db.put("system","gate_secret",null);
  assert.equal((await call("gate",{secret:gate})).status,503);
  assert.equal((await call("gate",{secret:nextGate})).status,503);
 } finally {await db.put("system","gate_secret",replacement);}
});

test("会话或账号记录缺少必要字段时一律拒绝登录状态",async()=>{
 const gateCookie=cookie(await call("gate",{secret:nextGate}),gateCookieName());
 const adminCookie=cookie(await call("login",{username:"admin",password:adminPass},gateCookie),userCookieName());
 const admin=(await status(both(gateCookie,adminCookie))).user,db=await getRepository();
 const key=(cookieValue:string)=>createHash("sha256").update(cookieValue.slice(cookieValue.indexOf("=")+1)).digest("hex");
 const userKey=key(adminCookie),gateKey=key(gateCookie),session=await db.get<Record<string,unknown>>("user_sessions",userKey),gateSession=await db.get<Record<string,unknown>>("gate_sessions",gateKey),user=await db.get<Record<string,unknown>>("users",admin.id);
 assert.ok(session&&gateSession&&user);
 try {
  const damagedSession={...session};delete damagedSession.expiresAt;await db.put("user_sessions",userKey,damagedSession);
  assert.equal((await status(both(gateCookie,adminCookie))).user,null);
  await db.put("user_sessions",userKey,session);
  const damagedGate={...gateSession};delete damagedGate.expiresAt;await db.put("gate_sessions",gateKey,damagedGate);
  assert.equal((await status(both(gateCookie,adminCookie))).gateVerified,false);
  await db.put("gate_sessions",gateKey,gateSession);
  const damagedUser={...user};delete damagedUser.mustChange;await db.put("users",admin.id,damagedUser);
  assert.equal((await status(both(gateCookie,adminCookie))).user,null);
 } finally {await db.put("user_sessions",userKey,session);await db.put("gate_sessions",gateKey,gateSession);await db.put("users",admin.id,user);}
});

test("管理员会话在写入前失效时，不能继续创建账号",async()=>{
 const gateCookie=cookie(await call("gate",{secret:nextGate}),gateCookieName());
 const adminCookie=cookie(await call("login",{username:"admin",password:adminPass},gateCookie),userCookieName());
 const admin=(await status(both(gateCookie,adminCookie))).user,db=await getRepository();
 const original=db.transaction.bind(db);let calls=0;
 const interceptor=mock.method(db,"transaction",async <T>(work:(tx:Transaction)=>Promise<T>):Promise<T>=>{
  calls++;
  if(calls===2){const user=await db.get<{version:number}>("users",admin.id);assert.ok(user);await db.put("users",admin.id,{...user,version:user.version+1});}
  return original(work);
 });
 try {
  assert.equal((await call("create",{username:"latefriend",password:tempPass},both(gateCookie,adminCookie),admin.id)).status,409);
  assert.equal(await db.get("user_names","latefriend"),null);
 } finally {interceptor.mock.restore();}
});

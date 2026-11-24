import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../app/api/cloud/auth/[action]/route";
import { cloudConfig, SEVEN_DAYS } from "../lib/cloud/server/config";
import { gateCookieName, hashSecret, requireUser, userCookieName, cookieOptions } from "../lib/cloud/server/auth";
import { getRepository } from "../lib/cloud/server/repository";

// Entire suite uses an isolated temp database and dummy credentials. No real keys or account data are read.
const originalEnv={...process.env}; let directory="";
const gateSecret="test gate phrase 1234", bootstrapSecret="test bootstrap phrase 123456789", adminPass="test-admin-password-123", alicePass="test-alice-password-123", bobPass="test-bob-password-123";
const origin="http://127.0.0.1:3207";
before(async()=>{directory=await mkdtemp(join(tmpdir(),"xhs-cloud-auth-"));process.env={...process.env,NODE_ENV:"test",APP_MODE:"cloud",APP_ORIGIN:origin,CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(directory,"test.sqlite"),SITE_ACCESS_HASH:await hashSecret(gateSecret),ADMIN_BOOTSTRAP_HASH:await hashSecret(bootstrapSecret)};});
after(async()=>{process.env=originalEnv;await rm(directory,{recursive:true,force:true});});
function request(action:string,body:unknown,cookie="",userId="",overrideOrigin=origin) {return new Request(`${origin}/api/cloud/auth/${action}`,{method:"POST",headers:{origin:overrideOrigin,"content-type":"application/json",...(cookie?{cookie}:{}),...(userId?{"x-workspace-user":userId}:{})},body:JSON.stringify(body)});}
function get(action:string,cookie="",userId=""){return new Request(`${origin}/api/cloud/auth/${action}`,{headers:{...(cookie?{cookie}:{}),...(userId?{"x-workspace-user":userId}:{})}});}
const ctx=(action:string)=>({params:Promise.resolve({action})});
async function call(action:string,body:unknown,cookie="",userId="",overrideOrigin=origin){return POST(request(action,body,cookie,userId,overrideOrigin),ctx(action));}
function cookieFrom(response:Response,name:string){const header=response.headers.get("set-cookie")||"";const match=header.match(new RegExp(`(?:^|,\\s*)(${name}=[^;]+)`));assert.ok(match,`missing cookie ${name}`);assert.match(header,/HttpOnly/i);assert.match(header,/SameSite=lax/i);assert.match(header,/Max-Age=604800/i);return match[1];}
const combine=(gate:string,user:string)=>`${gate}; ${user}`;
async function status(cookie=""){const r=await GET(get("status",cookie),ctx("status"));assert.equal(r.status,200);return r.json();}

test("匿名及格式错误的会话不查询数据库，候选会话只在验证后读取初始化状态",async()=>{
 const db=await getRepository();
 const spy=mock.method(db,"get");
 try {
  const anonymous={gateVerified:false,user:null,bootstrapComplete:false};
  assert.deepEqual(await status(),anonymous);
  assert.deepEqual(await status(`${gateCookieName()}=not-a-valid-token`),anonymous);
  assert.deepEqual(await status(`${gateCookieName()}=${"a".repeat(43)}; ${gateCookieName()}=${"b".repeat(43)}`),anonymous);
  assert.equal(spy.mock.callCount(),0);
  assert.deepEqual(await status(`${gateCookieName()}=${"a".repeat(43)}`),anonymous);
  assert.equal(spy.mock.callCount(),1);
  assert.equal(spy.mock.calls[0].arguments[0],"gate_sessions");
  const gate=cookieFrom(await call("gate",{secret:gateSecret}),gateCookieName());
  spy.mock.resetCalls();
  assert.deepEqual(await status(gate),{gateVerified:true,user:null,bootstrapComplete:false});
  assert.deepEqual(spy.mock.calls.map(call=>call.arguments[0]),["gate_sessions","system","system","system"]);
 } finally {spy.mock.restore();}
});

test("统一口令、两个独立用户、管理员重置与账号隔离均由服务端控制",async()=>{
 assert.equal((await status()).gateVerified,false);
 await assert.rejects(requireUser(get("status")),/统一访问/);
 assert.equal((await call("register",{username:"alice",password:alicePass})).status,401);
 assert.equal((await call("gate",{secret:gateSecret},"","","https://evil.example")).status,403);
 assert.equal((await call("gate",{secret:"wrong"})).status,401);
 const gateResponse=await call("gate",{secret:gateSecret});assert.equal(gateResponse.status,200);const gate=cookieFrom(gateResponse,gateCookieName());assert.equal((await status(gate)).gateVerified,true);
 assert.equal((await call("register",{username:"alice",password:alicePass},gate)).status,403);
 assert.equal((await call("setup",{bootstrapSecret:"wrong",username:"admin",password:adminPass},gate)).status,401);
 const setup=await call("setup",{bootstrapSecret,username:"admin",password:adminPass},gate);assert.equal(setup.status,200);const adminCookie=cookieFrom(setup,userCookieName());const admin=await status(combine(gate,adminCookie));assert.equal(admin.user.role,"admin");assert.equal(admin.bootstrapComplete,true);
 assert.equal((await call("setup",{bootstrapSecret,username:"admin2",password:adminPass},gate)).status,409);
 assert.equal((await call("register",{username:"imposter",password:alicePass,role:"admin"},gate)).status,400);
 const created=await call("register",{username:"Alice",password:alicePass},gate);assert.equal(created.status,200);const aliceCookie=cookieFrom(created,userCookieName());const alice=await status(combine(gate,aliceCookie));assert.equal(alice.user.role,"user");
 assert.equal((await call("register",{username:"alice",password:alicePass},gate)).status,409);
 const simultaneous=await Promise.all([call("register",{username:"duplicate",password:alicePass},gate),call("register",{username:"DUPLICATE",password:alicePass},gate)]);assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
 const bobCreated=await call("register",{username:"bob",password:bobPass},gate);assert.equal(bobCreated.status,200);const bobCookie=cookieFrom(bobCreated,userCookieName());const bob=await status(combine(gate,bobCookie));assert.notEqual(alice.user.id,bob.user.id);
 assert.equal((await GET(get("users",combine(gate,aliceCookie),alice.user.id),ctx("users"))).status,403);
 assert.equal((await call("reset",{userId:bob.user.id,password:"test-temp-password-456"},combine(gate,aliceCookie),alice.user.id)).status,403);
 assert.equal((await call("logout",{},combine(gate,bobCookie),alice.user.id)).status,409);
 assert.equal((await status(combine(gate,bobCookie))).user.username,"bob");
 await assert.rejects(requireUser(get("status",combine(gate,aliceCookie),bob.user.id),{requireIdentity:true}),/账号已变化/);
 const list=await GET(get("users",combine(gate,adminCookie),admin.user.id),ctx("users"));assert.equal(list.status,200);const users=await list.json();assert.ok(users.users.some((u:{username:string})=>u.username==="Alice"));assert.doesNotMatch(JSON.stringify(users),/password|hash|test-admin-password/);
 const temp="test-temp-password-456",next="test-new-alice-password-789";
 assert.equal((await call("reset",{userId:alice.user.id,password:temp},combine(gate,adminCookie),admin.user.id)).status,200);
 assert.equal((await status(combine(gate,aliceCookie))).user,null);
 assert.equal((await call("login",{username:"Alice",password:alicePass},gate)).status,401);
 const tempLogin=await call("login",{username:"Alice",password:temp},gate);assert.equal(tempLogin.status,200);const tempCookie=cookieFrom(tempLogin,userCookieName());assert.equal((await status(combine(gate,tempCookie))).user.mustChange,true);
 await assert.rejects(requireUser(get("status",combine(gate,tempCookie),alice.user.id),{requireIdentity:true}),/临时密码/);
 assert.equal((await call("change",{oldPassword:temp,newPassword:temp},combine(gate,tempCookie),alice.user.id)).status,400);
 const changed=await call("change",{oldPassword:temp,newPassword:next},combine(gate,tempCookie),alice.user.id);assert.equal(changed.status,200);assert.equal((await status(combine(gate,tempCookie))).user,null);
 const finalLogin=await call("login",{username:"Alice",password:next},gate);assert.equal(finalLogin.status,200);const finalCookie=cookieFrom(finalLogin,userCookieName());assert.equal((await status(combine(gate,finalCookie))).user.mustChange,false);
 assert.equal((await call("logout",{},combine(gate,finalCookie),alice.user.id)).status,200);assert.equal((await status(combine(gate,finalCookie))).user,null);assert.equal((await status(combine(gate,bobCookie))).user.username,"bob");
 const records=JSON.stringify(await (await getRepository()).scan("users"));for(const secret of [gateSecret,bootstrapSecret,adminPass,alicePass,bobPass,temp,next])assert.ok(!records.includes(secret));
});

test("未知账号共用限流记录，不因任意用户名产生无限数据库条目",async()=>{
 const gate=cookieFrom(await call("gate",{secret:gateSecret}),gateCookieName());
 for(const username of ["ghost01","ghost02","ghost03"])assert.equal((await call("login",{username,password:"test-invalid-password"},gate)).status,401);
 const db=await getRepository(),digest=(v:string)=>createHash("sha256").update(v).digest("hex");
 assert.equal((await db.get<{count:number}>("auth_rate",digest("login_unknown")))?.count,3);
 for(const username of ["ghost01","ghost02","ghost03"])assert.equal(await db.get("auth_rate",digest(`login:${username}`)),null);
});

test("统一验证和个人登录各自精确过期，重新通过统一验证不延长个人会话",async()=>{
 let now=Date.now();mock.method(Date,"now",()=>now);
 try {
  const gate=cookieFrom(await call("gate",{secret:gateSecret}),gateCookieName());now+=60_000;
  const login=await call("login",{username:"bob",password:bobPass},gate);assert.equal(login.status,200);const userCookie=cookieFrom(login,userCookieName());
  now+=SEVEN_DAYS-30_000;assert.equal((await status(combine(gate,userCookie))).gateVerified,false);
  const freshGate=cookieFrom(await call("gate",{secret:gateSecret}),gateCookieName());assert.equal((await status(combine(freshGate,userCookie))).user.username,"bob");
  now+=31_000;const expired=await status(combine(freshGate,userCookie));assert.equal(expired.gateVerified,true);assert.equal(expired.user,null);
 }finally{mock.restoreAll();}
});

test("公开部署 cookie 仅 HTTPS，开发设置不能通过任意公网地址启用 SQLite",()=>{
 const saved={...process.env};try{process.env={...process.env,NODE_ENV:"production"};process.env.APP_ORIGIN="https://demo.example";delete process.env.CLOUD_LOCAL_TEST;process.env.CLOUD_BACKEND="cloudbase";process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED="1";assert.equal(cookieOptions().secure,true);assert.match(gateCookieName(),/^__Host-/);assert.equal(cookieOptions().sameSite,"lax");process.env.CLOUD_LOCAL_TEST="1";process.env.CLOUD_BACKEND="sqlite";assert.throws(()=>cloudConfig(),/测试存储/);}finally{process.env=saved;}
});

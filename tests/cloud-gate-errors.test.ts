import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST, GET } from "../app/api/cloud/auth/[action]/route";
import { getRepository } from "../lib/cloud/server/repository";
import { gateCookieName, hashSecret } from "../lib/cloud/server/auth";

const origin="http://localhost:3003", secret=" test gate key ";
const oldEnv={...process.env}; let directory="", validHash="";
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),"xhs-gate-errors-"));
  validHash=await hashSecret(secret);
  process.env={...oldEnv,NODE_ENV:"test",APP_MODE:"cloud",APP_ORIGIN:origin,CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:join(directory,"auth.sqlite"),SITE_ACCESS_HASH:validHash,ADMIN_BOOTSTRAP_HASH:validHash};
});
after(async()=>{process.env=oldEnv;await rm(directory,{recursive:true,force:true});});
const context=(action:string)=>({params:Promise.resolve({action})});
function gate(value:string) {
  return POST(new Request(`${origin}/api/cloud/auth/gate`,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({secret:value})}),context("gate"));
}
test("统一口令按原样校验；空输入与错误输入给出不同的安全分类",async()=>{
  for(const value of ["", "  \n"]) { const response=await gate(value); assert.equal(response.status,400); assert.equal((await response.json()).error.code,"GATE_EMPTY"); }
  const wrong=await gate(secret.trim()); assert.equal(wrong.status,401); assert.equal((await wrong.json()).error.code,"GATE_INVALID");
  const right=await gate(secret); assert.equal(right.status,200);
  const cookie=right.headers.get("set-cookie") || "";
  assert.ok(cookie.startsWith(`${gateCookieName()}=`)); assert.match(cookie,/HttpOnly/i); assert.match(cookie,/SameSite=lax/i); assert.match(cookie,/Max-Age=604800/i);
  // Subsequent requests see the same gate session without resubmitting a secret.
  const status=await GET(new Request(`${origin}/api/cloud/auth/status`,{headers:{cookie:cookie.split(";")[0]}}),context("status"));
  assert.equal((await status.json()).gateVerified,true);
});
test("未配置或无效口令哈希不会误报口令错误，也不会回显提交内容",async()=>{
  for(const configured of ["", "invalid-format",validHash.replace("scrypt:","scrypt$")]) {
    process.env.SITE_ACCESS_HASH=configured;
    const response=await gate("synthetic-input-never-echo"); const raw=await response.text();
    assert.equal(response.status,503); assert.equal(JSON.parse(raw).error.code,"CLOUD_CONFIG"); assert.ok(!raw.includes("synthetic-input-never-echo"));
  }
  process.env.SITE_ACCESS_HASH=validHash;
});
test("使用统一美元符分隔的合法部署格式仍可通过",async()=>{
  process.env.SITE_ACCESS_HASH=validHash.replaceAll(":","$");
  const response=await gate(secret); assert.equal(response.status,200);
  process.env.SITE_ACCESS_HASH=validHash;
});
test("短时间请求过多返回可区分的限流错误",async()=>{
  const db=await getRepository(), id=createHash("sha256").update("gate").digest("hex");
  await db.put("auth_rate",id,{count:30,expiresAt:Date.now()+60_000});
  const response=await gate(secret); assert.equal(response.status,429); assert.equal((await response.json()).error.code,"RATE_LIMIT");
  await db.remove("auth_rate",id);
});

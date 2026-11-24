import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CloudBase SDK 依赖可加载并阻止已知原型污染路径",()=>{
 const require=createRequire(import.meta.url), fromDb=createRequire(require.resolve("@cloudbase/database"));
 const set=fromDb("lodash.set") as (object:object,path:string,value:unknown)=>object;
 assert.deepEqual(set({},"safe.value",1),{safe:{value:1}});
 set({},"__proto__.xhs_polluted",true);assert.equal(({} as Record<string,unknown>).xhs_polluted,undefined);
 assert.equal(fromDb("axios/package.json").version,"1.21.0");
 const sdk=require("@cloudbase/node-sdk");assert.equal(typeof sdk.init,"function");
 const app=sdk.init({env:"test-only",secretId:"test-only",secretKey:"test-only"});
 assert.equal(typeof app.database().runTransaction,"function");assert.equal(typeof app.uploadFile,"function");
});

test("源码部署包仅包含白名单，不含现有密钥、草稿、热点缓存或测试产物",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"xhs-package-test-"));const archive=join(dir,"source.tgz");
 try {
  execFileSync("sh",["scripts/package-cloud-source.sh",archive],{stdio:"pipe"});
  const list=execFileSync("tar",["-tzf",archive],{encoding:"utf8"}).split("\n");
  assert.ok(list.includes("Dockerfile"));assert.ok(list.includes("deployment/cloudbase/start.cjs"));assert.ok(list.includes("scripts/cloud-secrets.mjs"));
  assert.ok(!list.some(path=>/(^|\/)\.env|(^|\/)\.local-data|(^|\/)\.cloud-dev|(^|\/)test-results|(^|\/)node_modules/.test(path)));
  assert.throws(()=>execFileSync("sh",["scripts/package-cloud-source.sh",archive],{stdio:"pipe"}));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("即使源码目录嵌套私有配置、数据库或缓存，白名单打包也会排除",async()=>{
 const root=await mkdtemp(join(tmpdir(),"xhs-package-nested-"));
 try {
  for(const dir of ["app/.local-data","app/.cloud-dev","app/node_modules","components","lib","deployment","vendor","scripts"])await mkdir(join(root,dir),{recursive:true});
  for(const file of ["instrumentation.ts","package.json","package-lock.json","next.config.ts","tsconfig.json","postcss.config.mjs","Dockerfile",".dockerignore","scripts/cloud-secrets.mjs","app/page.tsx","app/.env.local","app/.npmrc","app/user.sqlite","app/private.key","app/private.p12","app/credentials-test.json","app/.local-data/private.json","app/.cloud-dev/private.db","app/node_modules/private.js"])await writeFile(join(root,file),"test-only");
  const script=await readFile("scripts/package-cloud-source.sh","utf8");await writeFile(join(root,"scripts/package-cloud-source.sh"),script);
  const archive=join(root,"safe.tgz");execFileSync("sh",["scripts/package-cloud-source.sh",archive],{cwd:root,stdio:"pipe"});
  const entries=execFileSync("tar",["-tzf",archive],{encoding:"utf8"}).split("\n");
  assert.ok(entries.includes("app/page.tsx"));
  assert.ok(!entries.some(path=>/(^|\/)\.env|\.npmrc|\.sqlite|\.key$|\.p12$|credentials-test|\.local-data|\.cloud-dev|node_modules/.test(path)));
 }finally{await rm(root,{recursive:true,force:true});}
});

test("公网容器拒绝本机模式和测试存储开关",()=>{
 for(const env of [{APP_MODE:"local",APP_LOCAL_ONLY:"1"},{APP_MODE:"cloud",APP_LOCAL_ONLY:"0",CLOUD_LOCAL_TEST:"1"}]){
  const result=spawnSync(process.execPath,["deployment/cloudbase/start.cjs"],{env:{PATH:process.env.PATH||"",NODE_ENV:"test",...env},encoding:"utf8",timeout:2000});
  assert.equal(result.status,1);assert.match(result.stderr,/不安全/);
 }
});

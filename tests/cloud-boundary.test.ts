import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashSecret } from "../lib/cloud/server/auth";
import { POST as generate } from "../app/api/generate/route";
import { POST as rewrite } from "../app/api/rewrite/route";
import { POST as partial } from "../app/api/partial-rewrite/route";
import { POST as video } from "../app/api/video/route";
import { GET as hotspots,POST as update } from "../app/api/hotspots/route";
import { GET as data,POST as write } from "../app/api/cloud/data/route";
import { GET as image } from "../app/api/cloud/images/[id]/route";
import { GET as job } from "../app/api/cloud/jobs/[id]/route";
import { GET as auth } from "../app/api/cloud/auth/[action]/route";
import { POST as cron } from "../app/api/cloud/cron/route";

test("未通过统一口令时，页面之外的全部受保护接口仍拒绝直接访问",async()=>{
 const old={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-cloud-boundary-")),origin="http://127.0.0.1:3002";
 try {
  process.env={...process.env,NODE_ENV:"test",APP_MODE:"cloud",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",APP_ORIGIN:origin,CLOUD_SQLITE_PATH:join(dir,"data.sqlite"),CLOUD_BLOB_PATH:join(dir,"blobs"),SITE_ACCESS_HASH:await hashSecret("test-gate-only"),ADMIN_BOOTSTRAP_HASH:await hashSecret("test-bootstrap-only"),OPENAI_API_KEY:"test-only",OPENAI_MODEL:"test-model",CLOUD_CRON_SECRET:"test-cron-secret-long-enough-only"};
  const get=(path:string)=>new Request(origin+path,{headers:{host:"127.0.0.1:3002","x-workspace-user":"test-user"}});
  const post=(path:string)=>new Request(origin+path,{method:"POST",headers:{host:"127.0.0.1:3002",origin,"content-type":"application/json","x-workspace-user":"test-user"},body:"{}"});
  const results=await Promise.all([generate(post("/api/generate")),rewrite(post("/api/rewrite")),partial(post("/api/partial-rewrite")),video(post("/api/video")),hotspots(get("/api/hotspots")),update(post("/api/hotspots")),data(get("/api/cloud/data?kind=photo-workspace")),write(post("/api/cloud/data")),image(get("/api/cloud/images/00000000-0000-4000-8000-000000000000"),{params:Promise.resolve({id:"00000000-0000-4000-8000-000000000000"})}),job(get("/api/cloud/jobs/00000000-0000-4000-8000-000000000000"),{params:Promise.resolve({id:"00000000-0000-4000-8000-000000000000"})}),auth(get("/api/cloud/auth/users"),{params:Promise.resolve({action:"users"})}),cron(post("/api/cloud/cron"))]);
  for(const result of results){assert.ok([401,403].includes(result.status),`protected route returned ${result.status}`);const body=await result.text();assert.doesNotMatch(body,/test-gate-only|test-bootstrap-only|test-only|test-cron-secret/);}
 } finally {process.env=old;await rm(dir,{recursive:true,force:true});}
});

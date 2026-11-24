import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../lib/errors";
import { pageAuthForDisplay } from "../lib/cloud/server/page-auth-display";

test("服务端渲染遇到配置错误时仅降级为匿名显示，其他异常不被隐藏",async()=>{
  const safe=await pageAuthForDisplay(async()=>{throw new AppError("CLOUD_CONFIG","private configuration details",503);});
  assert.deepEqual(safe,{state:{gateVerified:false,user:null,bootstrapComplete:false},configurationError:true});
  assert.ok(!JSON.stringify(safe).includes("private configuration details"));
  await assert.rejects(()=>pageAuthForDisplay(async()=>{throw new AppError("CLOUD_ERROR","temporary server issue",503);}),{code:"CLOUD_ERROR"});
  await assert.rejects(()=>pageAuthForDisplay(async()=>{throw new Error("unexpected");}),/unexpected/);
});
test("服务端页面的已有认证状态被原样保留",async()=>{
  const state={gateVerified:true,user:{id:"synthetic",username:"tester",role:"user" as const,mustChange:false},bootstrapComplete:true};
  assert.deepEqual(await pageAuthForDisplay(async()=>state),{state,configurationError:false});
});

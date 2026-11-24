import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudConfig } from "../lib/cloud/server/config";
import { getPublicConfig, getServerConfig } from "../lib/server/config";

test("公网不能开启本地测试数据库或绕过私有资源确认",()=>{
 const old={...process.env};
 try {
  process.env={...process.env,APP_MODE:"cloud",NODE_ENV:"production",APP_LOCAL_ONLY:"1",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",APP_ORIGIN:"http://127.0.0.1:3002"};
  assert.throws(()=>cloudConfig());assert.equal(getServerConfig().localOnly,false);
  process.env.APP_ORIGIN="https://example.com";process.env.CLOUD_BACKEND="cloudbase";delete process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED;
  assert.throws(()=>cloudConfig(),/私有权限/);
  process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED="1";
  assert.equal(cloudConfig().backend,"cloudbase");assert.equal(cloudConfig().secure,true);
  process.env.OPENAI_API_KEY="test-server-only";process.env.OPENAI_MODEL="test-model";delete process.env.OPENAI_BASE_URL;
  assert.equal(getPublicConfig().liveAvailable,true);assert.ok(!JSON.stringify(getPublicConfig()).includes("test-server-only"));
 } finally {process.env=old;}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRepository, type Repository } from "../lib/cloud/server/repository";
import { cleanupExpiredAuthRecords } from "../lib/cloud/server/auth";

test("过期账号记录按索引有界清理；旧版记录、未过期记录和并发续期内容不会被删除", async () => {
 const prior={...process.env},dir=await mkdtemp(join(tmpdir(),"xhs-auth-cleanup-")),file=join(dir,"records.sqlite"),now=54_000_000_000;
 process.env={...prior,NODE_ENV:"test",APP_MODE:"cloud",APP_ORIGIN:"http://127.0.0.1:3003",CLOUD_LOCAL_TEST:"1",CLOUD_BACKEND:"sqlite",CLOUD_SQLITE_PATH:file};
 try {
  // Simulate an old SQLite database without the top-level expiry column.
  const legacy=new DatabaseSync(file);legacy.exec("CREATE TABLE records (bucket TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bucket,id))");legacy.prepare("INSERT INTO records VALUES (?,?,?,?)").run("gate_sessions","legacy","",JSON.stringify({expiresAt:now-1}));legacy.close();
  const db=await createRepository();
  await db.put("gate_sessions","g1",{expiresAt:now-5});await db.put("gate_sessions","g2",{expiresAt:now-2});await db.put("gate_sessions","future",{expiresAt:now+1});await db.put("user_sessions","u1",{expiresAt:now-1});await db.put("auth_rate","r1",{expiresAt:now-1});
  const query=await db.scanExpired("gate_sessions",now,1);assert.equal(query.length,1);assert.equal(query[0].id,"g1");
  await assert.rejects(db.scanExpired("gate_sessions",now,101),/INVALID_EXPIRY_QUERY/);
  assert.equal(await cleanupExpiredAuthRecords(now,2,db),2);assert.equal(await db.get("gate_sessions","g1"),null);assert.equal(await db.get("gate_sessions","g2"),null);
  assert.ok(await db.get("gate_sessions","legacy"));assert.ok(await db.get("gate_sessions","future"));
  const counts=await Promise.all([cleanupExpiredAuthRecords(now,2,db),cleanupExpiredAuthRecords(now,2,db)]);assert.equal(counts[0]+counts[1],2);assert.equal(await db.get("user_sessions","u1"),null);assert.equal(await db.get("auth_rate","r1"),null);
  await db.put("gate_sessions","renewed",{expiresAt:now-100});let updated=false;
  const race:Repository={...db,async scanExpired<T>(bucket:string,time:number,limit:number){const rows=await db.scanExpired<T>(bucket,time,limit);if(bucket==="gate_sessions"&&!updated&&rows.some(row=>row.id==="renewed")){updated=true;await db.put(bucket,"renewed",{expiresAt:now+100_000});}return rows;}};
  assert.equal(await cleanupExpiredAuthRecords(now,3,race),0);assert.deepEqual(await db.get("gate_sessions","renewed"),{expiresAt:now+100_000});
 } finally {process.env=prior;await rm(dir,{recursive:true,force:true});}
});

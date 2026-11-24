import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyGate } from "../lib/cloud/server/concurrency";
test("并发大草稿受每人和全局短时限制，释放后立即恢复，不设置每日限额",()=>{
 const gate=new ConcurrencyGate(4,2),a=gate.enter("a"),b=gate.enter("a");
 assert.throws(()=>gate.enter("a"),/当前内容仍保留/);
 const c=gate.enter("b"),d=gate.enter("c");assert.throws(()=>gate.enter("d"));
 a();a();const again=gate.enter("d");again();b();c();d();
 for(let i=0;i<100;i++){const release=gate.enter("a");release();}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDeleted, storageReadError } from "../lib/cloud/server/blobs";
test("云存储删除必须确认指定对象的成功结果；上游错误、丢响应和部分结果均不视作已删除",()=>{
 const ref="cloud://test/private-image";
 assert.doesNotThrow(()=>assertDeleted(ref,{fileList:[{fileID:ref,code:"SUCCESS"}]}));
 for(const value of [null,{}, {code:"SERVICE_ERROR"}, {fileList:[]}, {fileList:[{fileID:ref,code:"FAILED"}]}, {fileList:[{fileID:"cloud://other",code:"SUCCESS"}]}, {fileList:[{fileID:ref,code:"SUCCESS"},{fileID:"extra",code:"SUCCESS"}]}]) assert.throws(()=>assertDeleted(ref,value));
});
test("只把确切的文件不存在归类为损坏图片，不泄漏上游信息，也不把网络错误当作缺图",()=>{
 for(const code of ["ENOENT","STORAGE_FILE_NONEXIST","BLOB_NOT_FOUND"]) {
  const error=storageReadError({code,message:"https://example.invalid/private-token"});
  assert.equal("code" in error && error.code,"BLOB_NOT_FOUND");assert.doesNotMatch(error.message,/example|token/);
 }
 assert.equal(storageReadError({code:"ECONNRESET",message:"private details"}).message,"DOWNLOAD_FAILED");
});

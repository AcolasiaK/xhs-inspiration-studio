import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setCloudIdentity } from "../lib/cloud/client";
import { CloudStorageError, getCloudThumbnail, isCorruptCloudRecord, makeCloudPhotoStore } from "../lib/cloud/store";

test("云端草稿初始化只读取摘要，不预取大量历史缩略图",async()=>{
 const uid=randomUUID(),now=new Date().toISOString(),drafts=Array.from({length:650},(_,i)=>({id:randomUUID(),name:`测试 ${i}`,updatedAt:now,contentMode:null,thumbnailId:randomUUID(),damaged:false}));setCloudIdentity(uid,true);
 const outbound=mock.method(globalThis,"fetch",async(input:RequestInfo|URL,options?:RequestInit)=>{assert.match(String(input),/photo-workspace/);assert.equal(new Headers(options?.headers).get("X-Workspace-User"),uid);return Response.json({drafts,templates:[],activeId:drafts[0].id});});
 try {const result=await makeCloudPhotoStore(uid).readWorkspace();assert.equal(result.summaries.length,650);assert.equal(result.drafts.length,0);assert.equal(outbound.mock.callCount(),1);}
 finally {mock.restoreAll();setCloudIdentity("",false);}
});

test("单张缩略图失败不污染缓存，重新请求成功；并发请求只下载一次",async()=>{
 const uid=randomUUID(),id=randomUUID();setCloudIdentity(uid,true);let count=0;
 const outbound=mock.method(globalThis,"fetch",async()=>{count++;if(count===1)return Response.json({error:{code:"NOT_FOUND",message:"图片不存在"}},{status:404});return new Response(new Blob(["test"],{type:"image/jpeg"}));});
 try {await assert.rejects(getCloudThumbnail(uid,id),/图片不存在/);const [a,b]=await Promise.all([getCloudThumbnail(uid,id),getCloudThumbnail(uid,id)]);assert.equal(a.size,4);assert.equal(a,b);assert.equal(outbound.mock.callCount(),2);}
 finally {mock.restoreAll();setCloudIdentity("",false);}
});

test("身份失效与网络故障不能被视作损坏记录或空草稿",async()=>{
 const uid=randomUUID();setCloudIdentity(uid,true);
 const outbound=mock.method(globalThis,"fetch",async()=>Response.json({error:{code:"LOGIN_REQUIRED",message:"登录已失效"}},{status:401}));
 try{
  await assert.rejects(makeCloudPhotoStore(uid).readWorkspace(),error=>error instanceof CloudStorageError&&error.code==="LOGIN_REQUIRED"&&!isCorruptCloudRecord(error));
  outbound.mock.mockImplementation(async()=>{throw new TypeError("test network failure");});
  await assert.rejects(makeCloudPhotoStore(uid).readWorkspace(),error=>error instanceof CloudStorageError&&error.code==="NETWORK_ERROR"&&!isCorruptCloudRecord(error));
  assert.ok(isCorruptCloudRecord(new CloudStorageError("图片缺失","INVALID_IMAGE")));
  assert.ok(isCorruptCloudRecord(new CloudStorageError("记录损坏","CORRUPT_RECORD")));
 }finally{mock.restoreAll();setCloudIdentity("",false);}
});

test("图文元数据损坏先标记为坏记录并跳过图片请求；认证和网络错误不被吞掉",async()=>{
 const uid=randomUUID(),id=randomUUID(),imageId=randomUUID(),now=new Date().toISOString();setCloudIdentity(uid,true);let imageCalls=0,record:unknown;
 const {emptyBrief}=await import('../lib/schema');
 const valid={version:2,revision:1,id,name:'测试',createdAt:now,updatedAt:now,brief:{...emptyBrief},mode:'demo',imageIds:[imageId],resultImageIds:[],assets:[{id:imageId,name:'test.png',lastModified:0,width:12,height:10,type:'image/png'}],generation:null,generatedInput:null,selectedTitleIndex:0,hasUserEdits:false};
 const outbound=mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{if(String(input).includes('/images/')){imageCalls++;return new Response(new Blob(['x'],{type:'image/png'}));}return Response.json(record);});
 try{
  for(const corrupt of [{...valid,assets:undefined},{...valid,assets:[null]},{...valid,assets:[{...valid.assets[0],id:'not-a-uuid'}]},{...valid,assets:[{...valid.assets[0],type:'text/plain'}]},{...valid,imageIds:[]},{...valid,id:randomUUID()}]){
   record=corrupt;await assert.rejects(makeCloudPhotoStore(uid).getDraft(id),e=>e instanceof CloudStorageError&&e.code==='CORRUPT_RECORD'&&isCorruptCloudRecord(e));assert.equal(imageCalls,0);
  }
  record=valid;outbound.mock.mockImplementation(async(input:RequestInfo|URL)=>String(input).includes('/images/')?Response.json({error:{code:'LOGIN_REQUIRED',message:'登录已失效'}},{status:401}):Response.json(record));
  await assert.rejects(makeCloudPhotoStore(uid).getDraft(id),e=>e instanceof CloudStorageError&&e.code==='LOGIN_REQUIRED'&&!isCorruptCloudRecord(e));
  outbound.mock.mockImplementation(async(input:RequestInfo|URL)=>{if(String(input).includes('/images/'))throw new TypeError('network');return Response.json(record);});
  await assert.rejects(makeCloudPhotoStore(uid).getDraft(id),e=>e instanceof CloudStorageError&&e.code==='NETWORK_ERROR'&&!isCorruptCloudRecord(e));
  outbound.mock.mockImplementation(async(input:RequestInfo|URL)=>String(input).includes('/images/')?new Response(new Blob(['x'],{type:'image/png'})):Response.json(record));
  assert.equal((await makeCloudPhotoStore(uid).getDraft(id)).assets[0].id,imageId);
 }finally{mock.restoreAll();setCloudIdentity('',false);}
});

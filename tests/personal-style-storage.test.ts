import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalStyleStorage, ensureLocalAiStorage } from '../scripts/local-style-storage.mjs';
import { listPersonalStyles, savePersonalStyle, activatePersonalStyle, resolvePersonalStyle, bindPersonalRules } from '../lib/server/personal-style-store';
import { emptyPersonalInput } from '../lib/personal/schema';
import { AppError } from '../lib/errors';

const filename=(owner:string)=>createHash('sha256').update(owner).digest('hex')+'.json';
async function fixture(){
  const base=await mkdtemp(join(tmpdir(),'xhs-style-storage-'));
  const project=join(base,'Documents/project'),root=join(base,'Application Support/workbench');
  const source=join(project,'.local-data/personal-styles');
  await mkdir(source,{recursive:true});
  return {base,project,root,source};
}

test('真实格式的多版本风格迁移逐字节保留；旧地址继续读写，重复迁移不覆盖新版',async()=>{
  const f=await fixture(),env={...process.env},owner=randomUUID();
  try{
    Object.assign(process.env,{APP_MODE:'local',PERSONAL_STYLES_DIR:f.source});delete process.env.VERCEL;
    const initial=await listPersonalStyles(owner);
    const v1=initial.styles[3].versions[0].snapshot;
    const saved=await savePersonalStyle(owner,'daily',1,{...v1.content,name:'我的日常个人规则'});
    await activatePersonalStyle(owner,'daily',saved.revision,saved.draftVersionId);
    const file=join(f.source,filename(owner)),before=await readFile(file);
    const migrated=await ensureLocalStyleStorage(f.project,f.root);
    assert.equal(migrated.migrated,true);
    assert.equal(await readlink(f.source),migrated.target);
    assert.deepEqual(await readFile(file),before);
    assert.deepEqual(await readFile(join(migrated.backup!,filename(owner))),before);
    assert.equal((await stat(join(migrated.target,filename(owner)))).mode&0o777,0o600);
    assert.equal((await stat(migrated.target)).mode&0o777,0o700);
    const snapshot=await resolvePersonalStyle(owner,'daily');
    assert.equal(snapshot.version,2);
    const record=(await listPersonalStyles(owner)).styles[3];
    await savePersonalStyle(owner,'daily',record.revision,{...snapshot.content,name:'迁移之后的新草稿'});
    assert.equal((await ensureLocalStyleStorage(f.project,f.root)).migrated,false);
    assert.equal((await listPersonalStyles(owner)).styles[3].versions.length,3);
    assert.deepEqual(await readFile(join(migrated.backup!,filename(owner))),before);
    assert.equal((await listPersonalStyles('another-owner')).styles[3].versions.length,1);
  }finally{process.env=env;await rm(f.base,{recursive:true,force:true});}
});

test('列表、旧版本解析、正式请求规则绑定不重写文件，也不改变记录时间或规则版本',async()=>{
  const owner=randomUUID(),dir=process.env.PERSONAL_STYLES_DIR!,env={...process.env};
  try{
    process.env.APP_MODE='local';delete process.env.VERCEL;
    const first=await listPersonalStyles(owner),file=join(dir,filename(owner));
    const raw=JSON.parse(await readFile(file,'utf8'));
    // Older optional fields need not be inserted merely by opening the page.
    delete raw.deletedVersionHashes;
    await writeFile(file,JSON.stringify(raw,null,2));
    const before=await readFile(file),metadata=await stat(file);
    assert.deepEqual(await listPersonalStyles(owner),first);
    const snapshot=await resolvePersonalStyle(owner,'daily');
    await bindPersonalRules({action:'generate',input:{...emptyPersonalInput,experience:'合成测试素材',ruleSnapshot:snapshot},imageIds:[],confirmedPrompt:'合成测试方向'},owner);
    assert.deepEqual(await readFile(file),before);
    assert.equal((await stat(file)).mtimeMs,metadata.mtimeMs);
    assert.equal((await stat(file)).ino,metadata.ino);
  }finally{process.env=env;}
});

test('损坏格式与文件无法读取分别报错，均不生成默认内容覆盖原记录',async()=>{
  const env={...process.env},dir=process.env.PERSONAL_STYLES_DIR!,owner=randomUUID(),file=join(dir,filename(owner));
  try{
    process.env.APP_MODE='local';delete process.env.VERCEL;await mkdir(dir,{recursive:true});
    await writeFile(file,'{"version":1,"styles":');
    await assert.rejects(listPersonalStyles(owner),(e:unknown)=>e instanceof AppError&&e.code==='STYLE_RECORD_INVALID');
    assert.equal(await readFile(file,'utf8'),'{"version":1,"styles":');
    const unreadable=randomUUID(),other=join(dir,filename(unreadable));await mkdir(other);
    await assert.rejects(listPersonalStyles(unreadable),(e:unknown)=>e instanceof AppError&&e.code==='STYLE_STORAGE'&&!e.message.includes(dir));
    assert.equal((await lstat(other)).isDirectory(),true);
  }finally{process.env=env;}
});

test('迁移遇到不同数据、写入锁或无效 JSON 时停止，不覆盖双方数据',async()=>{
  for(const kind of ['conflict','lock','invalid']){
    const f=await fixture();
    try{
      const file=join(f.source,filename('owner')),original=kind==='invalid'?'{bad':JSON.stringify({version:1,styles:[],trials:[]});
      await writeFile(file,original);
      if(kind==='lock')await mkdir(file+'.lock');
      if(kind==='conflict'){const target=join(f.root,'data/personal-styles');await mkdir(target,{recursive:true});await writeFile(join(target,filename('owner')),JSON.stringify({version:1,styles:[{marker:'do-not-overwrite'}],trials:[]}));}
      await assert.rejects(ensureLocalStyleStorage(f.project,f.root));
      assert.equal((await lstat(f.source)).isDirectory(),true);
      assert.equal(await readFile(file,'utf8'),original);
      if(kind==='conflict')assert.match(await readFile(join(f.root,'data/personal-styles',filename('owner')),'utf8'),/do-not-overwrite/);
    }finally{await rm(f.base,{recursive:true,force:true});}
  }
});

test('迁移中断后已有完整副本可接回；断裂或外部链接不能触发空库初始化',async()=>{
  const f=await fixture();
  try{
    const target=join(f.root,'data/personal-styles');await mkdir(target,{recursive:true});
    const bytes=JSON.stringify({version:1,styles:[],trials:[]});
    await writeFile(join(target,filename('owner')),bytes);
    await writeFile(join(f.source,filename('owner')),bytes);
    const migrated=await ensureLocalStyleStorage(f.project,f.root);
    assert.equal(migrated.migrated,true);
    await rm(f.source);await symlink(join(f.base,'missing'),f.source);
    await assert.rejects(ensureLocalStyleStorage(f.project,f.root),/链接需要检查/);
    assert.equal(await readFile(join(target,filename('owner')),'utf8'),bytes);
  }finally{await rm(f.base,{recursive:true,force:true});}
});

test('只有历史备份时不会当成首次安装而创建空风格库',async()=>{
  const f=await fixture();
  try{
    await rm(f.source,{recursive:true});
    await mkdir(f.source+'.before-local-storage-test');
    await assert.rejects(ensureLocalStyleStorage(f.project,f.root),/历史备份/);
    await assert.rejects(lstat(join(f.root,'data/personal-styles')),{code:'ENOENT'});
  }finally{await rm(f.base,{recursive:true,force:true});}
});

test('同根因的 AI 存储迁移原样保留加密字节和配套密钥，重复执行不改写',async()=>{
  const f=await fixture();
  try{
    const source=join(f.project,'.local-data/ai-config'),name=filename('owner').replace('.json','.enc');
    await mkdir(source,{mode:0o700});
    const encrypted=Buffer.from('synthetic encrypted fixture'),key=Buffer.alloc(32,7);
    await writeFile(join(source,name),encrypted);await writeFile(join(source,'master.key'),key);
    const migrated=await ensureLocalAiStorage(f.project,f.root);
    for(const [file,bytes] of [[name,encrypted],['master.key',key]] as const){
      assert.deepEqual(await readFile(join(source,file)),bytes);
      assert.deepEqual(await readFile(join(migrated.backup!,file)),bytes);
      assert.equal((await stat(join(migrated.target,file))).mode&0o777,0o600);
    }
    assert.equal((await ensureLocalAiStorage(f.project,f.root)).migrated,false);
  }finally{await rm(f.base,{recursive:true,force:true});}
});

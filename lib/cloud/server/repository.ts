import "server-only";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { cloudConfig } from "./config";
export type Row<T> = { id: string; owner: string; value: T };
export interface Transaction {
  get<T>(bucket: string, id: string): Promise<T | null>;
  put(bucket: string, id: string, value: unknown, owner?: string): Promise<void>;
  remove(bucket: string, id: string): Promise<void>;
}
export interface Repository extends Transaction {
  scan<T>(bucket: string, owner?: string): Promise<Row<T>[]>;
  /** Only draft/template listings may isolate a single malformed JSON record. */
  scanSafe<T>(bucket: "photos" | "videos" | "photo_summaries" | "video_summaries" | "templates" | "personal_summaries" | "personal_completed_summaries", owner: string): Promise<Row<T | null>[]>;
  scanExpired<T>(bucket: string, now: number, limit: number): Promise<Row<T>[]>;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}
function expiryOf(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("expiresAt" in value)) return null;
  const expiry = value.expiresAt;
  return typeof expiry === "number" && Number.isFinite(expiry) ? expiry : null;
}
function validateExpiryQuery(now: number, limit: number) {
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_EXPIRY_QUERY");
}
function parseRecordOrNull<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
const globalRepo = globalThis as typeof globalThis & { __xhsCloudRepo?: Promise<Repository> };
export async function getRepository(): Promise<Repository> { return globalRepo.__xhsCloudRepo ??= createRepository(); }
export async function cloudApp() {
  const { default: sdk } = await import("@cloudbase/node-sdk");
  if (!process.env.CLOUDBASE_ENV_ID) throw new Error("CLOUD_ENV_MISSING");
  // Preserve explicit key-pair configuration. Otherwise pass the injected API
  // key explicitly: this SDK's context-based fallback can miss the variable.
  const credentials = process.env.CLOUDBASE_SECRET_ID && process.env.CLOUDBASE_SECRET_KEY
    ? { secretId: process.env.CLOUDBASE_SECRET_ID, secretKey: process.env.CLOUDBASE_SECRET_KEY }
    : process.env.CLOUDBASE_APIKEY ? { accessKey: process.env.CLOUDBASE_APIKEY } : {};
  return sdk.init({ env: process.env.CLOUDBASE_ENV_ID, ...credentials });
}
export async function createRepository(): Promise<Repository> {
  if (cloudConfig().backend === "sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    const path = resolve(process.env.CLOUD_SQLITE_PATH || ".cloud-dev/database.sqlite");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id)); CREATE INDEX IF NOT EXISTS owner_idx ON records(bucket,owner);");
    // Existing local test databases may predate the optional expiry index. Missing expiry is intentionally retained.
    if (!db.prepare("PRAGMA table_info(records)").all().some(column => column.name === "expires_at")) {
      try { db.exec("ALTER TABLE records ADD COLUMN expires_at REAL"); }
      catch (error) { if (!db.prepare("PRAGMA table_info(records)").all().some(column => column.name === "expires_at")) throw error; }
    }
    db.exec("CREATE INDEX IF NOT EXISTS expiry_idx ON records(bucket,expires_at)");
    const tx: Transaction = {
      async get<T>(bucket: string, id: string) { const row = db.prepare("SELECT value FROM records WHERE bucket=? AND id=?").get(bucket,id); return row ? JSON.parse(String(row.value)) as T : null; },
      async put(bucket,id,value,owner="") { db.prepare("INSERT INTO records(bucket,id,owner,value,expires_at) VALUES (?,?,?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET owner=excluded.owner,value=excluded.value,expires_at=excluded.expires_at").run(bucket,id,owner,JSON.stringify(value),expiryOf(value)); },
      async remove(bucket,id) { db.prepare("DELETE FROM records WHERE bucket=? AND id=?").run(bucket,id); },
    };
    let queue = Promise.resolve<unknown>(undefined);
    const serialize = <T>(fn: () => Promise<T>) => { const next = queue.catch(()=>undefined).then(fn); queue=next; return next; };
    return { get:(b,id)=>serialize(()=>tx.get(b,id)), put:(b,id,v,o)=>serialize(()=>tx.put(b,id,v,o)), remove:(b,id)=>serialize(()=>tx.remove(b,id)),
      scan:<T>(bucket:string,owner?:string)=>serialize(async()=>{ const rows = owner === undefined ? db.prepare("SELECT * FROM records WHERE bucket=? ORDER BY id").all(bucket) : db.prepare("SELECT * FROM records WHERE bucket=? AND owner=? ORDER BY id").all(bucket,owner); return rows.map(r=>({id:String(r.id),owner:String(r.owner),value:JSON.parse(String(r.value)) as T})); }),
      scanSafe:<T>(bucket:"photos"|"videos"|"photo_summaries"|"video_summaries"|"templates"|"personal_summaries" | "personal_completed_summaries",owner:string)=>serialize(async()=>db.prepare("SELECT * FROM records WHERE bucket=? AND owner=? ORDER BY id").all(bucket,owner).map(r=>({id:String(r.id),owner:String(r.owner),value:parseRecordOrNull<T>(r.value)}))),
      scanExpired:<T>(bucket:string,now:number,limit:number)=>serialize(async()=>{validateExpiryQuery(now,limit);return db.prepare("SELECT * FROM records WHERE bucket=? AND expires_at <= ? ORDER BY expires_at ASC,id ASC LIMIT ?").all(bucket,now,limit).map(r=>({id:String(r.id),owner:String(r.owner),value:JSON.parse(String(r.value)) as T}));}),
      transaction:<T>(work:(t:Transaction)=>Promise<T>)=>serialize(async()=>{db.exec("BEGIN IMMEDIATE");try{const value=await work(tx);db.exec("COMMIT");return value;}catch(e){db.exec("ROLLBACK");throw e;}}),
    };
  }
  const app=await cloudApp(), db=app.database();
  const collection=process.env.CLOUDBASE_COLLECTION || "xhs_records";
  const docId=(bucket:string,id:string)=>createHash("sha256").update(`${bucket}:${id}`).digest("hex");
  type DatabaseLike = Pick<typeof db,"collection">;
  function ensure<T>(r:T):T { if (r && typeof r === "object" && "code" in r && r.code) throw new Error("CLOUD_DATABASE_FAILED"); return r; }
  const access=(d:DatabaseLike):Transaction=>({
    async get<T>(bucket:string,id:string) { const r=ensure(await d.collection(collection).doc(docId(bucket,id)).get()); const rows=r.data as unknown; const row=(Array.isArray(rows)?rows[0]:rows) as {json?:string}|undefined; if (row && typeof row.json !== "string") throw new Error("CLOUD_DATABASE_CORRUPT"); return row?.json ? JSON.parse(row.json) as T : null; },
    async put(bucket,id,value,owner="") { const expiresAt=expiryOf(value);ensure(await d.collection(collection).doc(docId(bucket,id)).set({bucket,id,owner,json:JSON.stringify(value),...(expiresAt === null ? {} : {expiresAt})})); },
    async remove(bucket,id) { ensure(await d.collection(collection).doc(docId(bucket,id)).remove()); },
  });
  return { ...access(db),
    async scan<T>(bucket:string,owner?:string) { const rows:Row<T>[]=[];let skip=0;while(true){const r=ensure(await db.collection(collection).where(owner===undefined?{bucket}:{bucket,owner}).orderBy("_id","asc").skip(skip).limit(100).get());const batch=r.data as {id:string;owner:string;json:string}[];if(!Array.isArray(batch))throw new Error("CLOUD_DATABASE_FAILED");rows.push(...batch.map(v=>({id:v.id,owner:v.owner,value:JSON.parse(v.json) as T})));if(batch.length<100)break;skip+=100;}return rows; },
    async scanSafe<T>(bucket:"photos"|"videos"|"photo_summaries"|"video_summaries"|"templates"|"personal_summaries" | "personal_completed_summaries",owner:string) { const rows:Row<T|null>[]=[];let skip=0;while(true){const r=ensure(await db.collection(collection).where({bucket,owner}).orderBy("_id","asc").skip(skip).limit(100).get());const batch=r.data as {id:string;owner:string;json:unknown}[];if(!Array.isArray(batch))throw new Error("CLOUD_DATABASE_FAILED");rows.push(...batch.map(v=>({id:v.id,owner:v.owner,value:parseRecordOrNull<T>(v.json)})));if(batch.length<100)break;skip+=100;}return rows; },
    async scanExpired<T>(bucket:string,now:number,limit:number) {validateExpiryQuery(now,limit);const r=ensure(await db.collection(collection).where({bucket,expiresAt:db.command.lte(now)}).orderBy("expiresAt","asc").limit(limit).get());const batch=r.data as {id:string;owner:string;json:string}[];if(!Array.isArray(batch))throw new Error("CLOUD_DATABASE_FAILED");return batch.map(v=>({id:v.id,owner:v.owner,value:JSON.parse(v.json) as T}));},
    async transaction<T>(work:(t:Transaction)=>Promise<T>) { return db.runTransaction(async (t:unknown)=>work(access(t as DatabaseLike)),2) as Promise<T>; },
  };
}

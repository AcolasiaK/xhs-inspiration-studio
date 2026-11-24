import "server-only";
import { mkdir,readFile,writeFile,unlink } from "node:fs/promises";
import { resolve,dirname } from "node:path";
import { cloudConfig } from "./config";
import { cloudApp } from "./repository";
export interface BlobStorage { put(key:string,bytes:Buffer):Promise<string>; get(ref:string):Promise<Buffer>; remove(ref:string):Promise<void> }
export class BlobNotFound extends Error { readonly code = "BLOB_NOT_FOUND"; constructor() { super("BLOB_NOT_FOUND"); } }
/** Preserve only a verified not-found category, never SDK messages or temporary URLs. */
export function storageReadError(error:unknown):Error {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return code === "STORAGE_FILE_NONEXIST" || code === "ENOENT" || code === "BLOB_NOT_FOUND" ? new BlobNotFound() : new Error("DOWNLOAD_FAILED");
}
/** A failed or incomplete cloud response is never evidence that an object was deleted. */
export function assertDeleted(ref:string, result:unknown) {
  if (!result || typeof result !== "object" || ("code" in result && result.code) || !("fileList" in result) || !Array.isArray(result.fileList) || result.fileList.length !== 1) throw new Error("DELETE_FAILED");
  const item = result.fileList[0] as {fileID?:unknown;code?:unknown};
  if (!item || item.fileID !== ref || item.code !== "SUCCESS") throw new Error("DELETE_FAILED");
}
let storage:Promise<BlobStorage>|undefined;
export function getBlobs() { return storage ??= make(); }
async function make():Promise<BlobStorage> {
  if(cloudConfig().backend==="sqlite") {
    const root=resolve(process.env.CLOUD_BLOB_PATH||".cloud-dev/blobs");
    function path(key:string){if(!/^[a-zA-Z0-9/_-]+\.[a-z]+$/.test(key)||key.includes(".."))throw new Error("INVALID_STORAGE_KEY");return resolve(root,key);}
    return {async put(key,bytes){const p=path(key);await mkdir(dirname(p),{recursive:true,mode:0o700});await writeFile(p,bytes,{mode:0o600});return key;},async get(ref){try{return await readFile(path(ref));}catch(error){throw storageReadError(error);}},async remove(ref){try{await unlink(path(ref));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}};
  }
  const app=await cloudApp();
  return {async put(key,bytes){const r=await app.uploadFile({cloudPath:key,fileContent:bytes});if(("code" in r && r.code)||!r.fileID)throw new Error("UPLOAD_FAILED");return r.fileID;},async get(ref){try{const r=await app.downloadFile({fileID:ref});if(!r.fileContent)throw storageReadError(r);return Buffer.from(r.fileContent);}catch(error){throw storageReadError(error);}},async remove(ref){const r=await app.deleteFile({fileList:[ref]});assertDeleted(ref,r);}};
}

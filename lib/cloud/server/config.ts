import "server-only";
import { AppError } from "@/lib/errors";
export function cloudConfig() {
  const origin = process.env.APP_ORIGIN || "";
  let url: URL;
  try { url = new URL(origin); } catch { throw new AppError("CLOUD_CONFIG", "联网版本尚未完成服务器配置。", 503); }
  // Test-only cookies/storage must never be usable in a production container,
  // even if an operator accidentally copies local test environment variables.
  const localTest = process.env.NODE_ENV !== "production" && !process.env.VERCEL && process.env.CLOUD_LOCAL_TEST === "1" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.origin !== origin || (!localTest && url.protocol !== "https:")) throw new AppError("CLOUD_CONFIG", "联网地址配置不正确。", 503);
  const backend = process.env.CLOUD_BACKEND || "cloudbase";
  if (backend !== "cloudbase" && !(backend === "sqlite" && localTest)) throw new AppError("CLOUD_CONFIG", "测试存储不能用于公网服务。", 503);
  // CloudBase storage is public-read by default. This explicit deployment gate
  // is an operator attestation, not a substitute for testing actual permissions.
  if (backend === "cloudbase" && process.env.CLOUD_PRIVATE_RESOURCES_CONFIRMED !== "1") throw new AppError("CLOUD_CONFIG", "云数据库和图片存储的私有权限尚未确认，联网服务未开放。", 503);
  return { origin, localTest, backend, secure: !localTest, gateHash: process.env.SITE_ACCESS_HASH || "", bootstrapHash: process.env.ADMIN_BOOTSTRAP_HASH || "", cronSecret: process.env.CLOUD_CRON_SECRET || "" };
}
export const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
// Four schema-bounded video plans with worst-case JSON escaping fit within this limit.
// CloudBase Run documents a 20 MB request limit; this stays below that limit.
export const MAX_CLOUD_DATA_BYTES = 8 * 1024 * 1024;
export function cloudError(error: unknown) {
  const e = error instanceof AppError ? error : new AppError("CLOUD_ERROR", "服务暂时不可用，请稍后重试。当前内容未被覆盖。", 503);
  return Response.json({error:{code:e.code,message:e.message}},{status:e.status,headers:{"Cache-Control":"no-store"}});
}
export function assertOrigin(request: Request) {
  if (request.headers.get("origin") !== cloudConfig().origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("INVALID_ORIGIN", "请从本站页面操作。", 403);
}
export async function readJson(request: Request, maxBytes = 32 * 1024): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AppError("INVALID_FORM", "请使用 JSON 提交。", 415);
  if (Number(request.headers.get("content-length")) > maxBytes) throw new AppError("TOO_LARGE", "提交内容过大。", 413);
  const reader = request.body?.getReader(); if (!reader) throw new AppError("INVALID_FORM", "没有收到内容。");
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > maxBytes) { await reader.cancel(); throw new AppError("TOO_LARGE", "提交内容过大。", 413); } chunks.push(r.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AppError("INVALID_FORM", "提交格式不正确。"); }
}

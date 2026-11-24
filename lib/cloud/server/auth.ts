import "server-only";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { cloudConfig, SEVEN_DAYS } from "./config";
import { getRepository, type Repository, type Transaction } from "./repository";

const HASH_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const scrypt = (secret: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scryptCallback(secret, salt, 32, HASH_OPTIONS, (error, key) => error ? reject(error) : resolve(key)));
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export type CloudUser = { id: string; username: string; role: "admin" | "user"; mustChange: boolean };
type UserRow = CloudUser & { normalized: string; passwordHash: string; version: number; createdAt: string; disabled?: boolean };
type GateOverride = { hash: string };
type GateSession = { expiresAt: number; version: string };
type UserSession = { expiresAt: number; userId: string; version: number };
export type AuthState = { gateVerified: boolean; user: CloudUser | null; bootstrapComplete: boolean };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The verifier accepts either all ':' or all '$'; mixed separators cannot be
// verified and must be reported as broken configuration rather than a bad key.
const SECRET_HASH = /^scrypt([:$])32768\1(?:8)\1(?:3)\1[A-Za-z0-9_-]{22}\1[A-Za-z0-9_-]{43}$/;
function validGateSession(value: GateSession | null, now=Date.now()): value is GateSession {
  return Boolean(value && Number.isSafeInteger(value.expiresAt) && value.expiresAt>now && typeof value.version==="string" && /^[a-f0-9]{64}$/i.test(value.version));
}
function validUserSession(value: UserSession | null, now=Date.now()): value is UserSession {
  return Boolean(value && Number.isSafeInteger(value.expiresAt) && value.expiresAt>now && typeof value.userId==="string" && UUID.test(value.userId) && Number.isSafeInteger(value.version) && value.version>0);
}
function validUser(value: UserRow | null): value is UserRow {
  if(!value || typeof value.id!=="string" || !UUID.test(value.id) || typeof value.username!=="string" || typeof value.normalized!=="string" || typeof value.passwordHash!=="string" || !SECRET_HASH.test(value.passwordHash)) return false;
  if((value.role!=="admin"&&value.role!=="user") || typeof value.mustChange!=="boolean" || (value.disabled!==undefined&&typeof value.disabled!=="boolean") || !Number.isSafeInteger(value.version) || value.version<1 || typeof value.createdAt!=="string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
  try { return normalizeUsername(value.username)===value.normalized; } catch { return false; }
}
/** A durable marker prevents partial corruption from restoring an old environment passphrase. */
async function effectiveGateHash(source: Pick<Transaction,"get">, fallback: string): Promise<string> {
  const marker=await source.get<{enabled?:unknown}>("system","gate_secret_active");
  const override=await source.get<GateOverride>("system","gate_secret");
  if(marker!==null && (marker.enabled!==true || override===null)) throw new AppError("CLOUD_CONFIG","统一访问配置损坏，服务已暂停，请恢复安全备份。",503);
  if(override!==null && (typeof override.hash!=="string" || !SECRET_HASH.test(override.hash))) throw new AppError("CLOUD_CONFIG","统一访问配置损坏，服务已暂停，请恢复安全备份。",503);
  return override?.hash ?? fallback;
}
export const gateCookieName = () => cloudConfig().secure ? "__Host-xhs-gate" : "xhs-dev-gate";
export const userCookieName = () => cloudConfig().secure ? "__Host-xhs-user" : "xhs-dev-user";
export const cookieOptions = () => ({ httpOnly: true, secure: cloudConfig().secure, sameSite: "lax" as const, path: "/", maxAge: SEVEN_DAYS / 1000 });
export function getRequestCookie(request: Request, name: string): string {
  const values = (request.headers.get("cookie") || "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  // Reject duplicates so a path-scoped cookie cannot shadow the expected value.
  if (values.length !== 1) return "";
  const v = values[0].slice(name.length + 1);
  return TOKEN_RE.test(v) ? v : "";
}
function cleanUser(row: UserRow): CloudUser { return { id: row.id, username: row.username, role: row.role, mustChange: row.mustChange }; }
export function normalizeUsername(input: string) {
  const value = input.normalize("NFKC").trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(value)) throw new AppError("INVALID_USERNAME", "用户名须为 3～24 位字母、数字或下划线。");
  return value.toLowerCase();
}
export function validatePassword(password: string) {
  const length = Array.from(password).length;
  if (length < 12 || length > 128 || !password.trim()) throw new AppError("INVALID_PASSWORD", "密码须为 12～128 个字符，不能全为空格。");
}
export async function hashSecret(secret: string) {
  const salt = randomBytes(16);
  const out = await scrypt(secret, salt);
  return `scrypt:32768:8:3:${salt.toString("base64url")}:${out.toString("base64url")}`;
}
export async function verifySecret(secret: string, stored: string) {
  const parts = stored.split(stored.startsWith("scrypt:") ? ":" : "$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "32768" || parts[2] !== "8" || parts[3] !== "3" || !/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5]) || secret.length > 256) return false;
  const expected = Buffer.from(parts[5], "base64url");
  const value = await scrypt(secret, Buffer.from(parts[4], "base64url"));
  return expected.length === value.length && timingSafeEqual(expected, value);
}
// Persistent, transactional short-window throttling: deliberately no daily per-user quota.
export async function authLimit(key: string, limit: number, windowMs: number) {
  const db = await getRepository(), now = Date.now(), id = hash(key);
  await db.transaction(async tx => {
    const old = await tx.get<{ count: number; expiresAt: number }>("auth_rate", id);
    if (old && old.expiresAt > now && old.count >= limit) throw new AppError("RATE_LIMIT", "操作太频繁，请稍后再试。", 429);
    await tx.put("auth_rate", id, old && old.expiresAt > now ? { ...old, count: old.count + 1 } : { count: 1, expiresAt: now + windowMs });
  });
}
/** Bound each cron pass and recheck inside a transaction so an extended record survives. */
export async function cleanupExpiredAuthRecords(now = Date.now(), limit = 24, repository?: Repository) {
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_CLEANUP_LIMIT");
  const db = repository ?? await getRepository();
  const buckets = ["gate_sessions", "user_sessions", "auth_rate"];
  const offset = Math.floor(now / 900_000) % buckets.length;
  const ordered = [...buckets.slice(offset), ...buckets.slice(0, offset)];
  let removed = 0, inspected = 0;
  for (const bucket of ordered) {
    if (inspected >= limit) break;
    const rows = await db.scanExpired<{expiresAt?: unknown}>(bucket, now, limit - inspected);
    inspected += rows.length;
    for (let i = 0; i < rows.length; i += 4) {
      // Small batches reduce cloud round trips without unbounded concurrent writes.
      const results = await Promise.all(rows.slice(i, i + 4).map(row => db.transaction(async tx => {
        const current = await tx.get<{expiresAt?: unknown}>(bucket, row.id);
        if (!current || typeof current.expiresAt !== "number" || current.expiresAt > now) return false;
        await tx.remove(bucket, row.id); return true;
      })));
      removed += results.filter(Boolean).length;
    }
  }
  return removed;
}
async function stateFromTokens(gateToken: string, userToken: string): Promise<AuthState> {
  const config = cloudConfig(), now = Date.now();
  if (!config.gateHash) throw new AppError("CLOUD_CONFIG", "联网版尚未完成服务端安全配置。", 503);
  // Anonymous visitors need only the gate screen. Do not read the database until
  // a syntactically valid session is presented, and never disclose setup status.
  const anonymous: AuthState = { gateVerified: false, user: null, bootstrapComplete: false };
  if (!TOKEN_RE.test(gateToken)) return anonymous;
  const db = await getRepository();
  const gate = await db.get<GateSession>("gate_sessions", hash(gateToken));
  if (!validGateSession(gate,now)) return anonymous;
  if (gate.version !== hash(await effectiveGateHash(db,config.gateHash))) return anonymous;
  const complete = Boolean(await db.get("system", "admin_bootstrapped"));
  if (!complete && !config.bootstrapHash) throw new AppError("CLOUD_CONFIG", "联网版尚未完成服务端安全配置。", 503);
  if (!TOKEN_RE.test(userToken)) return { gateVerified: true, user: null, bootstrapComplete: complete };
  const session = await db.get<UserSession>("user_sessions", hash(userToken));
  if (!validUserSession(session,now)) return { gateVerified: true, user: null, bootstrapComplete: complete };
  const user = await db.get<UserRow>("users", session.userId);
  if (!validUser(user) || user.id!==session.userId || user.disabled || user.version !== session.version) return { gateVerified: true, user: null, bootstrapComplete: complete };
  return { gateVerified: true, user: cleanUser(user), bootstrapComplete: complete };
}
export async function getRequestAuthState(request: Request) { return stateFromTokens(getRequestCookie(request, gateCookieName()), getRequestCookie(request, userCookieName())); }
export async function getPageAuthState() {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  try { return await stateFromTokens(jar.get(gateCookieName())?.value || "", jar.get(userCookieName())?.value || ""); }
  catch (error) {
    if (error instanceof AppError) throw error;
    // Server rendering may otherwise let framework logs print raw database/SDK errors.
    throw new AppError("CLOUD_ERROR", "账号服务暂不可用，请稍后重试。", 503);
  }
}
export async function requireGate(request: Request) {
  const state = await getRequestAuthState(request);
  if (!state.gateVerified) throw new AppError("GATE_REQUIRED", "请先通过统一访问验证。", 401);
  return state;
}
export async function requireUser(request: Request, options: { requireIdentity?: boolean; admin?: boolean; allowPasswordChange?: boolean } = {}): Promise<CloudUser> {
  const { user } = await requireGate(request);
  if (!user) throw new AppError("LOGIN_REQUIRED", "登录已失效，请重新登录。", 401);
  if (options.requireIdentity && request.headers.get("x-workspace-user") !== user.id) throw new AppError("ACCOUNT_CHANGED", "当前账号已变化，请先复制未保存内容并刷新页面。", 409);
  if (user.mustChange && !options.allowPasswordChange) throw new AppError("PASSWORD_CHANGE_REQUIRED", "请先修改临时密码。", 403);
  if (options.admin && user.role !== "admin") throw new AppError("FORBIDDEN", "没有权限执行此操作。", 403);
  return user;
}
export async function requirePageUser(options: { admin?: boolean; allowPasswordChange?: boolean } = {}) {
  const state = await getPageAuthState();
  const { redirect } = await import("next/navigation");
  if (!state.gateVerified || !state.user) return redirect("/entry");
  const user = state.user;
  if (user.mustChange && !options.allowPasswordChange) return redirect("/account");
  if (options.admin && user.role !== "admin") return redirect("/");
  return user;
}
export async function issueGate(secret: string) {
  const config = cloudConfig();
  // A missing or malformed deployment value is an operator error, not a wrong
  // visitor passphrase. The environment value remains required even when an
  // administrator has updated the active value in the database.
  if (!config.gateHash) throw new AppError("CLOUD_CONFIG", "服务端统一访问口令尚未正确配置，请联系管理员。", 503);
  await authLimit("gate", 30, 10 * 60_000);
  const db = await getRepository(), effective = await effectiveGateHash(db,config.gateHash);
  if (!SECRET_HASH.test(effective)) throw new AppError("CLOUD_CONFIG", "服务端统一访问口令尚未正确配置，请联系管理员。", 503);
  if (!await verifySecret(secret, effective)) throw new AppError("GATE_INVALID", "访问口令不正确，请重试。", 401);
  const value = token();
  await db.transaction(async tx => {
    if (await effectiveGateHash(tx,config.gateHash) !== effective) throw new AppError("GATE_INVALID", "统一访问口令已更新，请重新验证。", 401);
    // Preview builds may have stored an override before the corruption marker existed.
    // Upgrade that record atomically when a valid passphrase is next presented.
    const marker=await tx.get("system","gate_secret_active"),override=await tx.get<GateOverride>("system","gate_secret");
    if (marker===null && override!==null) await tx.put("system","gate_secret_active",{enabled:true});
    await tx.put("gate_sessions", hash(value), { expiresAt: Date.now() + SEVEN_DAYS, version: hash(effective) } satisfies GateSession);
  });
  return value;
}
function newUser(username: string, normalized: string, passwordHash: string, role: "admin" | "user"): UserRow { return { id: randomUUID(), username: username.normalize("NFKC").trim(), normalized, passwordHash, role, version: 1, mustChange: false, createdAt: new Date().toISOString() }; }
/** Prevent an old gate session from authorizing a write after the gate changed. */
async function assertActiveGate(tx: Transaction, request: Request) {
  const gateToken=getRequestCookie(request,gateCookieName());
  const gate=gateToken?await tx.get<GateSession>("gate_sessions",hash(gateToken)):null;
  const gateHash=await effectiveGateHash(tx,cloudConfig().gateHash);
  if (!validGateSession(gate) || gate.version!==hash(gateHash)) throw new AppError("GATE_REQUIRED","统一访问口令已变化，请重新验证。",401);
}
export async function bootstrapAdmin(request: Request, bootstrapSecret: string, username: string, password: string) {
  await requireGate(request); await authLimit("bootstrap", 8, 15 * 60_000);
  if (!await verifySecret(bootstrapSecret, cloudConfig().bootstrapHash)) throw new AppError("BOOTSTRAP_INVALID", "管理员初始化凭据不正确。", 401);
  const normalized = normalizeUsername(username); validatePassword(password); const passwordHash = await hashSecret(password);
  const db = await getRepository(), user = newUser(username, normalized, passwordHash, "admin");
  // Existing users imply initialization has happened even if its marker is corrupted or missing.
  // Two simultaneous first-time bootstraps are still serialized by the transaction below.
  if ((await db.scan("users")).length) throw new AppError("BOOTSTRAP_CLOSED", "已有账号，不能重复初始化管理员。", 409);
  await db.transaction(async tx => {
    await assertActiveGate(tx,request);
    if (await tx.get("system", "admin_bootstrapped")) throw new AppError("BOOTSTRAP_CLOSED", "管理员已经创建，不能重复初始化。", 409);
    if (await tx.get("user_names", normalized)) throw new AppError("USERNAME_TAKEN", "用户名已存在，请换一个。", 409);
    await tx.put("user_names", normalized, { userId: user.id }); await tx.put("users", user.id, user); await tx.put("system", "admin_bootstrapped", { createdAt: user.createdAt });
  });
  return createUserSession(user);
}
async function createUserSession(user: UserRow) {
  const value = token(), db = await getRepository();
  await db.transaction(async tx => {
    const current = await tx.get<UserRow>("users", user.id);
    if (!validUser(current) || current.id!==user.id || current.disabled || current.version !== user.version || current.passwordHash !== user.passwordHash) throw new AppError("LOGIN_CHANGED", "账号状态已变化，请重新登录。", 409);
    await tx.put("user_sessions", hash(value), { userId: user.id, version: user.version, expiresAt: Date.now() + SEVEN_DAYS } satisfies UserSession, user.id);
  });
  return value;
}
export async function registerUser(request: Request, username: string, password: string) {
  const gate = await requireGate(request); if (!gate.bootstrapComplete) throw new AppError("SETUP_REQUIRED", "请先由管理员完成初始化。", 403);
  await authLimit("register", 12, 15 * 60_000);
  const normalized = normalizeUsername(username); validatePassword(password); const passwordHash = await hashSecret(password);
  const user = newUser(username, normalized, passwordHash, "user"), db = await getRepository();
  await db.transaction(async tx => {
    await assertActiveGate(tx,request);
    if (await tx.get("user_names", normalized)) throw new AppError("USERNAME_TAKEN", "用户名已存在，请换一个。", 409);
    await tx.put("user_names", normalized, { userId: user.id }); await tx.put("users", user.id, user);
  });
  return createUserSession(user);
}
let dummyHash: Promise<string> | undefined;
export async function loginUser(request: Request, username: string, password: string) {
  await requireGate(request); await authLimit("login_global", 60, 60_000);
  const normalized = normalizeUsername(username);
  const db = await getRepository(), name = await db.get<{userId:string}>("user_names", normalized);
  // Unknown names share one rate bucket; arbitrary guesses cannot create unbounded records.
  await authLimit(name ? `login:${normalized}` : "login_unknown", name ? 8 : 30, 15 * 60_000);
  const user = name ? await db.get<UserRow>("users", name.userId) : null;
  const fallback = await (dummyHash ??= hashSecret("dummy only, never an account password"));
  const ok = await verifySecret(password, validUser(user) ? user.passwordHash : fallback);
  if (!validUser(user) || user.disabled || !ok) throw new AppError("INVALID_LOGIN", "用户名或密码不正确，或账号已停用。", 401);
  return createUserSession(user);
}
export async function logoutUser(request: Request) {
  const value = getRequestCookie(request, userCookieName());
  if (!value) return;
  const db = await getRepository();
  await db.transaction(async tx => {
    const session = await tx.get<UserSession>("user_sessions", hash(value));
    if (session && request.headers.get("x-workspace-user") !== session.userId) throw new AppError("ACCOUNT_CHANGED", "当前账号已变化，请刷新页面。", 409);
    await tx.remove("user_sessions", hash(value));
  });
}
export async function listUsers(request: Request) {
  await requireUser(request, { requireIdentity: true, admin: true });
  return (await (await getRepository()).scan<UserRow>("users")).map(({value}) => {
    if(!validUser(value))throw new AppError("CLOUD_ERROR","账号数据异常，请联系管理员检查安全备份。",503);
    const {id,username,role,mustChange,createdAt,disabled}=value;
    return {id,username,role,mustChange,createdAt,disabled:Boolean(disabled)};
  });
}
/** Recheck the same authenticated admin inside each mutation transaction. */
async function assertActiveAdmin(tx: Transaction, request: Request, adminId: string) {
  await assertActiveGate(tx,request);
  const userToken=getRequestCookie(request,userCookieName());
  const session=userToken?await tx.get<UserSession>("user_sessions",hash(userToken)):null;
  const active=await tx.get<UserRow>("users",adminId);
  if (!validUser(active) || active.id!==adminId || active.role!=="admin" || active.disabled || active.mustChange || !validUserSession(session) || session.userId!==adminId || session.version!==active.version) throw new AppError("LOGIN_CHANGED","账号状态已变化，请重新登录。",409);
}
/** Only ordinary users can be provisioned; the bootstrap flow remains the sole admin creation path. */
export async function createManagedUser(request: Request, username: string, password: string) {
  const admin = await requireUser(request, { requireIdentity: true, admin: true });
  await authLimit(`admin_create:${admin.id}`, 30, 10 * 60_000);
  const normalized = normalizeUsername(username); validatePassword(password);
  const user = {...newUser(username, normalized, await hashSecret(password), "user"), mustChange: true};
  await (await getRepository()).transaction(async tx => {
    await assertActiveAdmin(tx,request,admin.id);
    if (await tx.get("user_names", normalized)) throw new AppError("USERNAME_TAKEN", "用户名已存在，请换一个。", 409);
    await tx.put("user_names", normalized, {userId:user.id}); await tx.put("users", user.id, user);
  });
}
export async function setUserEnabled(request: Request, userId: string, enabled: boolean) {
  const admin = await requireUser(request, { requireIdentity: true, admin: true });
  await authLimit(`admin_toggle:${admin.id}`, 60, 10 * 60_000);
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new AppError("NOT_FOUND", "用户不存在。", 404);
  await (await getRepository()).transaction(async tx => {
    await assertActiveAdmin(tx,request,admin.id);
    const old = await tx.get<UserRow>("users", userId);
    if (!validUser(old) || old.id!==userId) throw new AppError("NOT_FOUND", "用户不存在或数据异常。", 404);
    if (old.role !== "user") throw new AppError("FORBIDDEN", "不能停用或修改管理员账号。", 403);
    if (Boolean(old.disabled) !== !enabled) await tx.put("users", userId, {...old, disabled:!enabled, version:old.version + 1});
  });
}
export async function changeGateSecret(request: Request, currentSecret: string, newSecret: string) {
  const admin = await requireUser(request, { requireIdentity: true, admin: true });
  await authLimit(`gate_change:${admin.id}`, 8, 15 * 60_000);
  validatePassword(newSecret);
  if (currentSecret === newSecret) throw new AppError("INVALID_PASSWORD", "新口令需要与当前口令不同。");
  const db = await getRepository(), config = cloudConfig(), previous = await effectiveGateHash(db,config.gateHash);
  if (!await verifySecret(currentSecret, previous)) throw new AppError("GATE_INVALID", "当前统一访问口令不正确。", 401);
  const newHash = await hashSecret(newSecret);
  await db.transaction(async tx => {
    if (await effectiveGateHash(tx,config.gateHash) !== previous) throw new AppError("GATE_CHANGED", "统一访问口令已改变，请重新验证。", 409);
    await assertActiveAdmin(tx,request,admin.id);
    await tx.put("system", "gate_secret", {hash:newHash} satisfies GateOverride);
    await tx.put("system", "gate_secret_active", {enabled:true});
  });
}
export async function resetPassword(request: Request, userId: string, password: string) {
  const admin=await requireUser(request, { requireIdentity: true, admin: true }); await authLimit("admin_reset", 30, 10 * 60_000); validatePassword(password);
  if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new AppError("INVALID_FORM", "用户不存在。", 404);
  const passwordHash = await hashSecret(password), db = await getRepository();
  await db.transaction(async tx => { await assertActiveAdmin(tx,request,admin.id); const old = await tx.get<UserRow>("users", userId); if (!validUser(old) || old.id!==userId) throw new AppError("NOT_FOUND", "用户不存在或数据异常。", 404); if (old.role !== "user") throw new AppError("FORBIDDEN", "请通过修改密码功能管理管理员账号。", 403); await tx.put("users", userId, { ...old, passwordHash, version: old.version + 1, mustChange: true }); });
}
export async function changePassword(request: Request, oldPassword: string, newPassword: string) {
  const user = await requireUser(request, { requireIdentity: true, allowPasswordChange: true }); validatePassword(newPassword);
  if (oldPassword === newPassword) throw new AppError("INVALID_PASSWORD", "新密码需要与当前密码不同。");
  await authLimit(`change:${user.id}`, 8, 15 * 60_000);
  const db = await getRepository(), row = await db.get<UserRow>("users", user.id);
  if (!validUser(row) || row.id!==user.id || !await verifySecret(oldPassword, row.passwordHash)) throw new AppError("INVALID_LOGIN", "当前密码不正确。", 401);
  const passwordHash = await hashSecret(newPassword);
  await db.transaction(async tx => {
    await assertActiveGate(tx,request);
    const current = await tx.get<UserRow>("users", user.id);
    const value=getRequestCookie(request,userCookieName());
    const session=value?await tx.get<UserSession>("user_sessions",hash(value)):null;
    if (!validUser(current) || current.id!==user.id || current.disabled || current.version !== row.version || current.passwordHash !== row.passwordHash || !validUserSession(session) || session.userId!==user.id || session.version!==current.version) throw new AppError("LOGIN_CHANGED", "账号状态已变化，请重新登录。", 409);
    await tx.put("users", user.id, { ...current, passwordHash, version: current.version + 1, mustChange: false });
  });
}

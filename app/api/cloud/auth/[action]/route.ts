import { NextResponse } from "next/server";
import { z } from "zod";
import { isCloudMode } from "@/lib/cloud/mode";
import { assertOrigin, cloudError, readJson } from "@/lib/cloud/server/config";
import { bootstrapAdmin, changePassword, changeGateSecret, cookieOptions, createManagedUser, gateCookieName, getRequestAuthState, issueGate, listUsers, loginUser, logoutUser, registerUser, resetPassword, setUserEnabled, userCookieName } from "@/lib/cloud/server/auth";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
const text = z.string().max(256);
const schemas = {
  gate: z.object({ secret: text }).strict(),
  setup: z.object({ bootstrapSecret: text, username: text, password: text }).strict(),
  register: z.object({ username: text, password: text }).strict(),
  login: z.object({ username: text, password: text }).strict(),
  logout: z.object({}).strict(),
  reset: z.object({ userId: text, password: text }).strict(),
  change: z.object({ oldPassword: text, newPassword: text }).strict(),
  create: z.object({ username: text, password: text }).strict(),
  toggle: z.object({ userId: text, enabled: z.boolean() }).strict(),
  "gate-change": z.object({ currentSecret: text, newSecret: text }).strict(),
};
const response = (value: unknown) => NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
function invalid() { return new AppError("INVALID_FORM", "请检查输入后重试。"); }
export async function GET(request: Request, { params }: Context) {
  try {
    if (!isCloudMode()) throw new AppError("NOT_FOUND", "页面不存在。", 404);
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("INVALID_ORIGIN", "请从本站页面操作。", 403);
    const { action } = await params;
    if (action === "status") return response(await getRequestAuthState(request));
    if (action === "users") return response({ users: await listUsers(request) });
    throw new AppError("NOT_FOUND", "页面不存在。", 404);
  } catch (error) { return cloudError(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    if (!isCloudMode()) throw new AppError("NOT_FOUND", "页面不存在。", 404);
    assertOrigin(request);
    const { action } = await params;
    const payload = await readJson(request);
    if (action === "gate") {
      const input = schemas.gate.safeParse(payload); if (!input.success) throw invalid();
      // Only reject an empty input. Nonempty secrets must be checked exactly as
      // entered; silently trimming them could change a valid passphrase.
      if (!input.data.secret.trim()) throw new AppError("GATE_EMPTY", "请输入统一访问口令。", 400);
      const token = await issueGate(input.data.secret); const result = response({ ok: true }); result.cookies.set(gateCookieName(), token, cookieOptions()); return result;
    }
    if (action === "setup") {
      const input = schemas.setup.safeParse(payload); if (!input.success) throw invalid();
      const token = await bootstrapAdmin(request, input.data.bootstrapSecret, input.data.username, input.data.password); const result = response({ ok: true }); result.cookies.set(userCookieName(), token, cookieOptions()); return result;
    }
    if (action === "register" || action === "login") {
      const input = schemas[action].safeParse(payload); if (!input.success) throw invalid();
      const token = action === "register" ? await registerUser(request, input.data.username, input.data.password) : await loginUser(request, input.data.username, input.data.password);
      const result = response({ ok: true }); result.cookies.set(userCookieName(), token, cookieOptions()); return result;
    }
    if (action === "logout") {
      if (!schemas.logout.safeParse(payload).success) throw invalid();
      await logoutUser(request); const result = response({ ok: true }); result.cookies.set(userCookieName(), "", { ...cookieOptions(), maxAge: 0 }); return result;
    }
    if (action === "reset") {
      const input = schemas.reset.safeParse(payload); if (!input.success) throw invalid();
      await resetPassword(request, input.data.userId, input.data.password); return response({ ok: true });
    }
    if (action === "change") {
      const input = schemas.change.safeParse(payload); if (!input.success) throw invalid();
      await changePassword(request, input.data.oldPassword, input.data.newPassword); const result = response({ ok: true }); result.cookies.set(userCookieName(), "", { ...cookieOptions(), maxAge: 0 }); return result;
    }
    if (action === "create") {
      const input = schemas.create.safeParse(payload); if (!input.success) throw invalid();
      await createManagedUser(request,input.data.username,input.data.password); return response({ok:true});
    }
    if (action === "toggle") {
      const input = schemas.toggle.safeParse(payload); if (!input.success) throw invalid();
      await setUserEnabled(request,input.data.userId,input.data.enabled); return response({ok:true});
    }
    if (action === "gate-change") {
      const input = schemas["gate-change"].safeParse(payload); if (!input.success) throw invalid();
      await changeGateSecret(request,input.data.currentSecret,input.data.newSecret); const result=response({ok:true}); result.cookies.set(gateCookieName(),"",{...cookieOptions(),maxAge:0}); return result;
    }
    throw new AppError("NOT_FOUND", "页面不存在。", 404);
  } catch (error) { return cloudError(error); }
}

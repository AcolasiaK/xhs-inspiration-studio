import { cloudFetch } from "./client";

/** Send the typed value exactly as entered; only whitespace-only input is empty. */
export async function verifyGate(secret: string, request: typeof fetch = cloudFetch, timeoutMs = 15_000) {
  if (!secret.trim()) throw new Error("请输入统一访问口令。");
  const deadline = AbortSignal.timeout(timeoutMs);
  async function send(url: string, init: RequestInit) {
    try { return await request(url, { ...init, signal: deadline }); }
    catch {
      if (deadline.aborted) throw new Error("请求超时，请检查网络后重试；也可以刷新页面确认是否已经通过。");
      throw new Error("网络连接失败，请检查网络后重试。");
    }
  }
  async function read(response: Response) {
    try { return await response.json(); }
    catch {
      if (deadline.aborted) throw new Error("请求超时，请检查网络后重试；也可以刷新页面确认是否已经通过。");
      throw new Error("服务端返回的信息无法读取，请稍后重试。");
    }
  }
  function errorFor(response: Response, result: { error?: { code?: unknown } } | null) {
    const code = result?.error?.code;
    if (code === "GATE_INVALID") return "口令验证失败，请检查输入的大小写和空格。";
    if (code === "RATE_LIMIT" || response.status === 429) return "尝试过于频繁，请稍后再试。";
    if (code === "CLOUD_CONFIG") return "服务端访问配置未完成或异常，请联系管理员检查。";
    if (code === "INVALID_ORIGIN") return "访问地址与服务器配置不一致，请从管理员提供的网址打开。";
    if (response.status >= 500) return "服务暂时不可用，请稍后重试或联系管理员。";
    return "访问验证未完成，请稍后重试。";
  }
  const response = await send("/api/cloud/auth/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
  const result = await read(response);
  if (!response.ok) throw new Error(errorFor(response, result));
  // An accepted passphrase is not enough if a proxy or browser rejected its cookie.
  const check = await send("/api/cloud/auth/status", { method: "GET" });
  const state = await read(check);
  if (!check.ok) throw new Error(errorFor(check, state));
  if (state?.gateVerified === false) throw new Error("口令已通过，但访问状态未保存。请允许本站 Cookie，并使用管理员提供的网址重试。");
  if (state?.gateVerified !== true) throw new Error("无法确认访问状态，请刷新页面或稍后重试。");
}

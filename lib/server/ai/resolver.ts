import "server-only";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { AppError } from "@/lib/errors";
import { publicIP } from "./ip";
import { aiHttpsAgent, resolveAiProxy } from './proxy-agent';

export type ResolvedAddress = { address: string; family: number };
const resolutionError = () => new AppError("DNS_RESOLUTION_FAILED", "服务地址解析失败，请检查后端网络与 DNS 设置；请求尚未进入 API 认证阶段。", 502);
const canonical = (name: string) => name.toLowerCase().replace(/\.$/, "");

/** Fixed, TLS-verified resolver only. No API headers, keys or content reach DNS. */
async function queryDoh(host: string, type: 1 | 28, signal: AbortSignal, proxy: URL | null): Promise<ResolvedAddress[]> {
  const url = new URL("https://1.1.1.1/dns-query");
  url.searchParams.set("name", host);
  url.searchParams.set("type", String(type));
  const agent = aiHttpsAgent('1.1.1.1', '1.1.1.1', 443, signal, proxy);
  try {
    const data: unknown = await new Promise((resolve, reject) => {
      const request = https.request(url, { agent, signal, rejectUnauthorized: true, headers: { accept: "application/dns-json" } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(resolutionError()); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32 * 1024) { request.destroy(resolutionError()); return; }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(resolutionError()); }
        });
      });
      request.on("error", reject);
      request.end();
    });
    if (!data || typeof data !== "object") throw resolutionError();
    const result = data as { Status?: unknown; TC?: unknown; Question?: unknown; Answer?: unknown };
    if (result.Status !== 0 || result.TC === true || !Array.isArray(result.Question) || result.Question.length !== 1) throw resolutionError();
    const question = result.Question[0];
    if (!question || typeof question.name !== "string" || canonical(question.name) !== canonical(host) || question.type !== type) throw resolutionError();
    if (result.Answer === undefined) return [];
    if (!Array.isArray(result.Answer)) throw resolutionError();
    // Permit CNAME chains, but do not accept unrelated answer records.
    const names = new Set([canonical(host)]);
    for (let i = 0; i < result.Answer.length; i++) {
      for (const answer of result.Answer) {
        if (answer?.type === 5 && typeof answer.name === "string" && typeof answer.data === "string" && names.has(canonical(answer.name))) names.add(canonical(answer.data));
      }
    }
    const addresses: ResolvedAddress[] = [];
    for (const answer of result.Answer) {
      if (!answer || typeof answer.name !== "string" || !names.has(canonical(answer.name))) throw resolutionError();
      if (answer.type === 5 && typeof answer.data === "string") continue;
      if (answer.type !== type || typeof answer.data !== "string" || isIP(answer.data) !== (type === 1 ? 4 : 6)) throw resolutionError();
      addresses.push({ address: answer.data, family: type === 1 ? 4 : 6 });
    }
    return addresses;
  } finally { agent.destroy(); }
}

async function systemLookup(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  // lookup cannot be cancelled; ignore its eventual result after cancellation.
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    void lookup(host, { all: true }).then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** Fail closed: never fall back to a different DNS mode or an unchecked IP. */
export async function resolvePublicAddresses(host: string, signal: AbortSignal, proxy?: URL | null): Promise<ResolvedAddress[]> {
  signal.throwIfAborted();
  const networkProxy = proxy === undefined ? await resolveAiProxy(signal) : proxy;
  const mode = process.env.AI_DNS_MODE || "system";
  if (mode !== "system" && mode !== "cloudflare-doh") throw new AppError("NETWORK_CONFIG", "AI 网络解析配置无效，请将 AI_DNS_MODE 设置为 system 或 cloudflare-doh。", 503);
  const pending = new AbortController();
  const deadline = AbortSignal.any([signal, pending.signal, AbortSignal.timeout(8000)]);
  let addresses: ResolvedAddress[];
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
      : mode === "system" ? await systemLookup(host, deadline)
      : (await Promise.all([queryDoh(host, 1, deadline, networkProxy), queryDoh(host, 28, deadline, networkProxy)])).flat();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError && ['NETWORK_CONFIG', 'AI_PROXY_UNAVAILABLE'].includes(error.code)) throw error;
    throw resolutionError();
  } finally { pending.abort(); }
  signal.throwIfAborted();
  if (!addresses.length) throw resolutionError();
  if (addresses.some(address => !publicIP(address.address))) throw new AppError("UNSAFE_ADDRESS", "服务地址解析到了非公开网络，请求已在网络校验阶段停止，尚未验证密钥。请检查后端 DNS、代理或 Fake-IP 设置；手动填写模型无法解决此网络拦截。", 400);
  return addresses;
}

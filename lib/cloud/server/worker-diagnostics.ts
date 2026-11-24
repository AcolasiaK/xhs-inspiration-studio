import "server-only";
import { AppError } from "@/lib/errors";

export type WorkerStage = "configuration" | "repository_init" | "storage_init" | "queue_read" | "queue_claim" | "poll";
type Category = "configuration" | "credentials" | "permission" | "network" | "rate_limit" | "service" | "unknown";
export type WorkerDiagnostic = { stage: WorkerStage; category: Category; code: string; httpStatus?: number };

/** Keep the original exception inside the process; only the classifier may inspect it. */
class WorkerStageError extends Error {
  constructor(readonly stage: WorkerStage, readonly cause: unknown) { super("Cloud worker stage failed"); }
}
export async function atWorkerStage<T>(stage: WorkerStage, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new WorkerStageError(stage, error); }
}

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  // A malformed SDK exception must not break error handling or execute a getter.
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function statusOf(error: unknown): number | undefined {
  const status = field(error, "statusCode") ?? field(error, "status") ?? field(field(error, "response"), "status");
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Never return SDK messages, arbitrary codes, URLs, headers, response bodies or IDs. */
export function classifyWorkerError(error: unknown, fallback: WorkerStage = "poll"): WorkerDiagnostic {
  let stage = fallback, current = error;
  const seen = new Set<unknown>();
  let httpStatus: number | undefined;
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    if (current instanceof WorkerStageError) stage = current.stage;
    httpStatus ??= statusOf(current);
    const code = field(current, "code");
    const result = (category: Category, safeCode: string): WorkerDiagnostic => ({ stage, category, code: safeCode, ...(httpStatus === undefined ? {} : { httpStatus }) });
    if (current instanceof AppError && (code === "CLOUD_CONFIG" || code === "CLOUD_ENV_MISSING")) return result("configuration", code === "CLOUD_CONFIG" ? "CONFIG_INCOMPLETE" : "ENVIRONMENT_MISSING");
    if (typeof code === "string") {
      if (["CREDENTIALS_ERROR", "INVALID_CREDENTIAL", "INVALID_CREDENTIALS", "INVALID_SECRET_ID", "INVALID_SECRET_KEY", "AUTH_FAILURE", "AuthFailure", "AuthFailure.SecretIdNotFound", "AuthFailure.SignatureFailure", "SIGNATURE_INVALID", "UNAUTHENTICATED"].includes(code)) return result("credentials", "CREDENTIALS_REJECTED");
      if (["ACCESS_DENIED", "AccessDenied", "PERMISSION_DENIED", "PermissionDenied", "UnauthorizedOperation", "DATABASE_PERMISSION_DENIED", "STORAGE_PERMISSION_DENIED"].includes(code)) return result("permission", "ACCESS_DENIED");
      if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) return result("network", "CONNECTION_TIMEOUT");
      if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_NETWORK"].includes(code)) return result("network", "CONNECTION_FAILED");
    }
    // This SDK sometimes uses INVALID_PARAM (or no code) for missing credentials.
    // Match only known credential diagnostics; the original message is never emitted.
    const message = field(current, "message");
    if (typeof message === "string" && /missing secretId or secretKey|secretId or secretKey not found|getCredential failed/iu.test(message.slice(0, 2048))) return result("credentials", "CREDENTIALS_UNAVAILABLE");
    current = field(current, "cause");
  }
  const category: Category = httpStatus === 401 ? "credentials" : httpStatus === 403 ? "permission" : httpStatus === 429 ? "rate_limit" : httpStatus !== undefined && httpStatus >= 500 ? "service" : "unknown";
  const code = { credentials: "CREDENTIALS_REJECTED", permission: "ACCESS_DENIED", rate_limit: "RATE_LIMITED", service: "SERVICE_UNAVAILABLE", unknown: "UNCLASSIFIED", configuration: "CONFIG_INCOMPLETE", network: "CONNECTION_FAILED" }[category];
  return { stage, category, code, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function workerLogLine(diagnostic: WorkerDiagnostic, elapsedMs: number): string {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
  return `[cloud-worker] event=${diagnostic.category === "configuration" ? "paused" : "failed"} stage=${diagnostic.stage} category=${diagnostic.category} code=${diagnostic.code} httpStatus=${diagnostic.httpStatus ?? "none"} elapsedMs=${elapsed}`;
}

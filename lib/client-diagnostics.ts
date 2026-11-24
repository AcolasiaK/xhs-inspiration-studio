/** 前端只记录固定字段：关联 ID、受控阶段/结果/错误码、耗时和 HTTP 状态。 */
export const SERVER_STAGES = {
  read_upload: "读取上传", access_check: "访问检查", input_validation: "图片与表单校验", generation: "生成准备", demo: "演示生成",
  initial_request: "正文生成", initial_validation: "正文结果校验", tag_repair_request: "话题补全", tag_validation: "话题结果校验",
} as const;
export type ServerStage = keyof typeof SERVER_STAGES;
export type ClientPhase = "save_copy" | "image_compression" | "api_request";
export type DiagnosticResult = "success" | "failed" | "cancelled" | "timeout" | "skipped";

const CODES = new Set([
  "NONE", "UNKNOWN", "TIMEOUT", "CANCELLED", "NETWORK_ERROR", "COMPRESSION_FAILED", "CLIENT_VALIDATION_FAILED", "STORAGE_FAILED",
  "PROVIDER_UNAVAILABLE", "INVALID_KEY", "PROVIDER_QUOTA", "PROVIDER_LIMIT", "MODEL_UNAVAILABLE", "INVALID_BASE_URL",
  "ENDPOINT_NOT_FOUND", "ENDPOINT_REDIRECT", "PROVIDER_INCOMPATIBLE", "PROVIDER_NETWORK", "NOT_CONFIGURED",
  "VISION_UNVERIFIED", "VISION_UNSUPPORTED", "STRUCTURED_UNSUPPORTED",
  "UNSAFE_ADDRESS", "NETWORK_CONFIG", "AI_PROXY_UNAVAILABLE", "DNS_RESOLUTION_FAILED", "DNS_LOOKUP_FAILED", "INVALID_KEY_FORMAT",
  "ACCESS_NOT_CONFIGURED", "UNAUTHORIZED", "RATE_LIMIT", "INVALID_ORIGIN", "INVALID_FORM", "INVALID_RESULT", "TOO_LARGE",
  "INVALID_IMAGE", "INVALID_IMAGE_TYPE", "INVALID_IMAGES", "EMPTY_FORM", "IMAGE_MISMATCH", "HASHTAG_COUNT", "CONSTRAINT_FAILED",
  "VISION_UNVERIFIED", "VISION_UNSUPPORTED", "STRUCTURED_UNSUPPORTED", "PROTOCOL_UNSUPPORTED", "OUTPUT_BUDGET_UNSUPPORTED",
  "REFUSAL", "INCOMPLETE", "SERVER_ERROR",
  "SIWC_AUTH", "SIWC_QUOTA", "SIWC_POLICY", "SIWC_PERMISSION", "SIWC_MODELS", "SIWC_MODEL", "SIWC_INTERRUPTED", "SIWC_FAILED", "SIWC_STORAGE", "SIWC_BUSY", "SIWC_ERROR",
]);
const PHASES = new Set<ClientPhase>(["save_copy", "image_compression", "api_request"]);
const RESULTS = new Set<DiagnosticResult>(["success", "failed", "cancelled", "timeout", "skipped"]);
export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}
export function safeErrorCode(value: unknown): string { return typeof value === "string" && CODES.has(value) ? value : "UNKNOWN"; }
export function safeServerStage(value: unknown): ServerStage | undefined {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SERVER_STAGES, value) ? value as ServerStage : undefined;
}
export function recordClientDiagnostic(data: { requestId: string; phase: ClientPhase; result: DiagnosticResult; elapsedMs: number; code?: string; httpStatus?: number }) {
  if (!isRequestId(data.requestId) || !PHASES.has(data.phase) || !RESULTS.has(data.result)) return;
  const elapsed = Number.isFinite(data.elapsedMs) ? Math.max(0, Math.round(data.elapsedMs)) : 0;
  const status = Number.isInteger(data.httpStatus) && data.httpStatus! >= 100 && data.httpStatus! <= 599 ? String(data.httpStatus) : "none";
  const code = data.code === undefined ? "NONE" : safeErrorCode(data.code);
  console.info(`[generate_client] requestId=${data.requestId} phase=${data.phase} result=${data.result} elapsedMs=${elapsed} code=${code} httpStatus=${status}`);
}
export async function measurePreservation(requestId: string, save: () => Promise<boolean>): Promise<boolean> {
  const started = performance.now();
  let saved = false;
  try { saved = await save(); return saved; }
  finally { recordClientDiagnostic({ requestId, phase: "save_copy", result: saved ? "success" : "failed", elapsedMs: performance.now() - started, code: saved ? undefined : "STORAGE_FAILED" }); }
}

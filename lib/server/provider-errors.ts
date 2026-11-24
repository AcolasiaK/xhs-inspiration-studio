import "server-only";
import OpenAI from "openai";
import { ZodError } from "zod";
import { AppError } from "../errors";

/** Only application-authored, safe network messages may cross the SDK cause boundary. */
export function safeNetworkCause(error: unknown): AppError | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof AppError && ["UNSAFE_ADDRESS", "NETWORK_CONFIG", "AI_PROXY_UNAVAILABLE", "DNS_RESOLUTION_FAILED", "DNS_LOOKUP_FAILED"].includes(current.code)) return current;
    if (!(current instanceof Error)) return;
    current = current.cause;
  }
}

// 只用供应商返回值做分类，不把原文、响应头、请求体或密钥回传/记录。
export function providerError(error: unknown, providerName: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof SyntaxError || error instanceof ZodError) return new AppError("INVALID_RESULT", "模型返回的 JSON 不符合完整结构，请检查服务的结构化输出兼容性。已有内容已保留。", 502);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new AppError("TIMEOUT", "生成超时，请稍后重试。已有内容已保留。", 504);
  if (error instanceof OpenAI.APIUserAbortError) return new AppError("CANCELLED", "本次生成已取消。", 499);
  if (error instanceof OpenAI.APIConnectionError) {
    const safeCause = safeNetworkCause(error);
    if (safeCause) return safeCause;
  }
  if (error instanceof OpenAI.APIConnectionError) return new AppError("PROVIDER_NETWORK", "暂时无法连接 AI 服务，请检查服务器网络后重试。", 502);
  if (error instanceof OpenAI.APIError) {
    const code = String(error.code || "").toLowerCase();
    const type = String(error.type || "").toLowerCase();
    const detail = `${code} ${type} ${error.message}`.slice(0, 8000).toLowerCase();
    const status = error.status ?? 0;
    const quota = ["insufficient_quota", "credit_balance_exhausted", "organization_usage_limit_exceeded", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "insufficient_balance", "quota_exceeded", "balance_not_enough"];
    if (status === 402 || quota.some((value) => code === value || type === value) || /insufficient (?:balance|quota|credit)|余额不足|额度不足|配额不足/.test(detail)) {
      return new AppError("PROVIDER_QUOTA", `${providerName} API 账户可用额度不足，请在对应服务控制台检查余额和用量额度，处理后再生成。重复点击不会恢复额度。`, 429);
    }
    if (["unsupported_image", "image_not_supported", "vision_not_supported"].includes(code)) return new AppError("VISION_UNSUPPORTED", "服务明确返回该模型不支持图片，请选择其他已验证的图片配置。", 400);
    if (["unsupported_response_format", "json_schema_not_supported"].includes(code)) return new AppError("STRUCTURED_UNSUPPORTED", "服务明确返回不支持此结构化输出格式，请核对高级设置与模型能力。", 400);
    if (status === 401 || ["invalid_api_key", "invalid_key", "invalid_token"].includes(code)) return new AppError("INVALID_KEY", `${providerName} 密钥无效或已失效，请检查本地配置中是否填写了该服务新建的正确密钥。`, 503);
    if (status === 429) return new AppError("PROVIDER_LIMIT", "AI 服务请求过于频繁，请稍等片刻再生成。已有内容已保留。", 429);
    if (status >= 300 && status < 400) return new AppError("ENDPOINT_REDIRECT", "API 地址返回了重定向，已停止发送。请核对服务的 API 基础地址。", 502);
    if (status === 403 || ["model_not_found", "model_not_available", "model_access_denied", "permission_denied"].includes(code)
      || /model.{0,70}(?:not found|does not exist|no access|not available)|无权.{0,20}模型|模型.{0,20}(?:不存在|权限|不可用)/.test(detail)) {
      return new AppError("MODEL_UNAVAILABLE", providerName === "Right Code" ? "当前密钥的渠道或模型权限不可用，请确认绑定了 Codex 外接渠道，并有权使用配置的模型。" : "当前模型不可用，请检查模型名称和账户权限。", 503);
    }
    if (status === 404) return new AppError("ENDPOINT_NOT_FOUND", "未找到所选接口。请核对 API 地址是否正确，或向服务商确认该渠道是否提供此接口。", 502);
    if ([400, 422].includes(status) && /max_(?:output|completion)_tokens|max_tokens/.test(detail) && /(?:less than|at most|maximum|exceed|too (?:large|high)|upper|<=|最大|超出)/.test(detail)) return new AppError('OUTPUT_BUDGET_UNSUPPORTED', 'AI 服务不接受本次输出上限，请调整后重试。已有内容保留。', 502);
    if ([400, 405, 415, 422, 501].includes(status)) return new AppError("PROVIDER_INCOMPATIBLE", "AI 服务拒绝了当前接口请求，可能不兼容图片、系统提示词或严格 JSON 输出。请核对渠道接口能力；未自动改用其他接口或演示结果。", 502);
    if (status >= 500) return new AppError("PROVIDER_UNAVAILABLE", `AI 服务端返回异常（HTTP ${status}），暂时无法完成生成。这不等同于密钥无效或额度不足，请查看服务商状态或联系服务商。已有内容已保留。`, 502);
  }
  // SDK 收到 HTML、聊天协议或缺失 output 的响应时，可能在解析时抛出 TypeError。
  if (error instanceof TypeError) return new AppError("PROVIDER_INCOMPATIBLE", "无法解析 API 响应，请检查接口兼容性或应用配置；已有结果已保留。", 502);
  return new AppError("GENERATION_FAILED", "生成暂时失败，请稍后重试。你的输入和旧结果已保留。", 502);
}

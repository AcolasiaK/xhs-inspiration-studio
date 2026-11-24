import "server-only";
import { AppError } from "@/lib/errors";

/** Validate before saving or constructing SDK headers; never echo the secret. */
export function assertApiKeyFormat(apiKey: string) {
  // An empty value is handled by the caller (keep/delete a key or KEY_REQUIRED).
  // All supported adapters use bearer credentials: visible ASCII, no whitespace.
  // Do not silently remove internal characters or guess a replacement credential.
  if (/[^\x21-\x7e]/.test(apiKey)) {
    throw new AppError(
      "INVALID_KEY_FORMAT",
      "API Key 格式不正确：含有非 ASCII 字符（如中文、全角符号或隐藏字符），或密钥中间有空格、换行。请重新复制完整密钥，只填写密钥本身，不要附带名称、说明或 Bearer 前缀。本次操作未向 AI 服务发送请求，已有输入仍保留。",
      400,
    );
  }
}

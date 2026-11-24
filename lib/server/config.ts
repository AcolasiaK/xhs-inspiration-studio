import "server-only";
import type { PublicConfig } from "../types";
import { isCloudMode } from "../cloud/mode";

export const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
export const RIGHTCODE_BASE_URL = "https://rightapi.ai/v1";

export function resolveProvider(value: string | undefined) {
  const baseURL = (value?.trim() || OFFICIAL_BASE_URL).replace(/\/+$/u, "");
  // 仅允许本项目明确支持的两个目的地；不从请求参数接受地址。
  if (baseURL === OFFICIAL_BASE_URL) return { baseURL, providerName: "OpenAI", baseUrlError: "" };
  if (baseURL === RIGHTCODE_BASE_URL) return { baseURL, providerName: "Right Code", baseUrlError: "" };
  return { baseURL: "", providerName: "AI 服务", baseUrlError: "API 地址配置不正确。Right Code 请填 https://rightapi.ai/v1；不要填控制台地址、重复 /v1 或追加 /responses。" };
}

export function getServerConfig() {
  return {
    ...resolveProvider(process.env.OPENAI_BASE_URL),
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
    model: process.env.OPENAI_MODEL?.trim() || "",
    accessToken: process.env.APP_ACCESS_TOKEN?.trim() || "",
    production: process.env.NODE_ENV === "production",
    // Only the loopback-bound npm launch commands opt in. Never enable on Vercel.
    localOnly: process.env.APP_LOCAL_ONLY === "1" && !process.env.VERCEL && !isCloudMode(),
  };
}
export function getPublicConfig(): PublicConfig {
  const config = getServerConfig();
  const credentialsReady = Boolean(config.apiKey && config.model);
  const protectedProduction = isCloudMode() || config.localOnly || !config.production || config.accessToken.length >= 16;
  return {
    liveAvailable: credentialsReady && protectedProduction && !config.baseUrlError,
    providerName: config.providerName,
    setupMessage: config.baseUrlError || (!credentialsReady ? "密钥或模型尚未填写，当前只能使用演示模式。"
      : !protectedProduction ? "当前运行方式尚未配置访问控制。请使用项目的本机启动命令；对外部署需另行配置访问控制。"
        : `${config.providerName} 配置已填写，尚不代表真实请求成功。上传图片并生成后，才能验证密钥、模型权限、图片输入和接口兼容性。`),
  };
}

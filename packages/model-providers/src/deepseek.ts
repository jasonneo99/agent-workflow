import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export function deepSeekProviderInput() {
  return {
    id: "deepseek",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelEnv: "DEEPSEEK_MODEL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseURL: DEEPSEEK_DEFAULT_BASE_URL,
    defaultModel: DEEPSEEK_DEFAULT_MODEL
  } as const;
}

/**
 * DeepSeek's hosted API is OpenAI-compatible. This dedicated adapter keeps its
 * credential, catalog, usage, and routing evidence distinct from generic BYO
 * gateways and prevents an unrelated OpenAI-compatible endpoint from silently
 * taking DeepSeek traffic.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor() {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error("DEEPSEEK_API_KEY is required when DEFAULT_MODEL_PROVIDER=deepseek");
    }
    super(deepSeekProviderInput());
  }
}

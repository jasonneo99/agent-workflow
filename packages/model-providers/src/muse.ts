import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const MUSE_DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const MUSE_DEFAULT_MODEL = "muse-spark-1.1";

export function museProviderInput() {
  return {
    id: "muse",
    baseUrlEnv: "MUSE_BASE_URL",
    modelEnv: "MUSE_MODEL",
    apiKeyEnv: "MUSE_API_KEY",
    defaultBaseURL: MUSE_DEFAULT_BASE_URL,
    defaultModel: MUSE_DEFAULT_MODEL
  } as const;
}

export class MuseProvider extends OpenAICompatibleProvider {
  constructor() {
    if (!process.env.MUSE_API_KEY?.trim()) {
      throw new Error("MUSE_API_KEY is required when DEFAULT_MODEL_PROVIDER=muse");
    }
    super(museProviderInput());
  }
}

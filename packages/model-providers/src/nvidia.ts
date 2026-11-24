import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export function nvidiaProviderInput() {
  return {
    id: "nvidia",
    baseUrlEnv: "NVIDIA_NIM_BASE_URL",
    modelEnv: "NVIDIA_NIM_MODEL",
    apiKeyEnv: "NVIDIA_NIM_API_KEY",
    defaultBaseURL: NVIDIA_DEFAULT_BASE_URL,
    defaultModel: NVIDIA_DEFAULT_MODEL
  } as const;
}

/**
 * NVIDIA NIM's hosted API is OpenAI-compatible. This dedicated adapter keeps
 * its credential, catalog, usage, and routing evidence distinct from generic
 * BYO gateways and prevents an unrelated OpenAI-compatible endpoint from
 * silently taking NVIDIA traffic. The default model is the free
 * z-ai/glm-5.3-flash (Free tier: 40 requests/min, 10,000 requests/day, no
 * card required). The endpoint is slow (measured ~60s per call, 116s cold),
 * so this provider is for background and bulk work, not interactive use.
 * NVIDIA may use inputs and outputs to train models, so do not send
 * sensitive code through it.
 */
export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    if (!process.env.NVIDIA_NIM_API_KEY?.trim()) {
      throw new Error("NVIDIA_NIM_API_KEY is required when DEFAULT_MODEL_PROVIDER=nvidia");
    }
    super(nvidiaProviderInput());
  }
}

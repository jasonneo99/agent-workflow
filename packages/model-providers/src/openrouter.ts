import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemma-4-31b-it:free";

export function openRouterProviderInput() {
  return {
    id: "openrouter",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    modelEnv: "OPENROUTER_MODEL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseURL: OPENROUTER_DEFAULT_BASE_URL,
    defaultModel: OPENROUTER_DEFAULT_MODEL
  } as const;
}

/**
 * OpenRouter's hosted API is OpenAI-compatible. This dedicated adapter keeps
 * its credential, catalog, usage, and routing evidence distinct from generic
 * BYO gateways and prevents an unrelated OpenAI-compatible endpoint from
 * silently taking OpenRouter traffic. The default model is a free `:free`
 * variant (free variants carry per-minute/per-day request caps gated by
 * credits purchased, and the `:free` roster rotates, so pin an exact model
 * id with OPENROUTER_MODEL when you need reproducible runs).
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor() {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error("OPENROUTER_API_KEY is required when DEFAULT_MODEL_PROVIDER=openrouter");
    }
    super(openRouterProviderInput());
  }
}

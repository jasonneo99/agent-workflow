import { OpenAICompatibleProvider } from "./openai-compatible.js";

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

export function groqProviderInput() {
  return {
    id: "groq",
    baseUrlEnv: "GROQ_BASE_URL",
    modelEnv: "GROQ_MODEL",
    apiKeyEnv: "GROQ_API_KEY",
    defaultBaseURL: GROQ_DEFAULT_BASE_URL,
    defaultModel: GROQ_DEFAULT_MODEL
  } as const;
}

/**
 * Groq's hosted API is OpenAI-compatible. This dedicated adapter keeps its
 * credential, catalog, usage, and routing evidence distinct from generic BYO
 * gateways and prevents an unrelated OpenAI-compatible endpoint from silently
 * taking Groq traffic. The default model is the free-tier gpt-oss-120b
 * (Free plan: 30 requests/min, 1,000 requests/day, 200K tokens/day).
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor() {
    if (!process.env.GROQ_API_KEY?.trim()) {
      throw new Error("GROQ_API_KEY is required when DEFAULT_MODEL_PROVIDER=groq");
    }
    super(groqProviderInput());
  }
}

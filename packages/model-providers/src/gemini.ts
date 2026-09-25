import { OpenAICompatibleProvider } from "./openai-compatible.js";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * Gemini uses Google's official OpenAI-compatible endpoint so it can share the
 * same governed JSON artifact and receipt contract as other hosted providers.
 * Advanced Gemini-only tools remain outside this portable stage adapter.
 */
export class GeminiProvider extends OpenAICompatibleProvider {
  constructor() {
    super({
      id: "gemini",
      baseUrlEnv: "GEMINI_BASE_URL",
      modelEnv: "GEMINI_MODEL",
      apiKeyEnv: "GEMINI_API_KEY",
      apiKeyEnvFallbacks: ["GOOGLE_API_KEY"],
      defaultBaseURL: GEMINI_OPENAI_BASE_URL,
      defaultModel: DEFAULT_GEMINI_MODEL,
      defaultHeaders: {
        "x-goog-api-client": `agent-workflow-oai/${process.env.npm_package_version || "dev"}`
      }
    });
  }
}

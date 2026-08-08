import { BedrockProvider } from "./bedrock.js";
import { KiroProvider } from "./kiro.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export function providerFromEnv(providerOverride?: string): ModelProvider {
  const provider = providerOverride ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock";

  if (provider === "mock") {
    return new MockProvider();
  }

  if (provider === "openai") {
    return new OpenAIProvider();
  }

  if (provider === "openai-compatible") {
    return new OpenAICompatibleProvider();
  }

  if (provider === "byo") {
    return new OpenAICompatibleProvider({
      id: "byo",
      baseUrlEnv: "BYO_MODEL_BASE_URL",
      modelEnv: "BYO_MODEL_NAME",
      apiKeyEnv: "BYO_MODEL_API_KEY"
    });
  }

  if (provider === "bedrock") {
    return new BedrockProvider();
  }

  if (provider === "kiro") {
    return new KiroProvider();
  }

  throw new Error(`Unsupported provider adapter: ${provider}`);
}

export type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

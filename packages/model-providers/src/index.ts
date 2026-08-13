import { BedrockProvider } from "./bedrock.js";
import { KiroProvider } from "./kiro.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export function providerFromEnv(providerOverride?: string): ModelProvider {
  const provider = providerOverride ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock";

  if (provider === "auto") {
    return providerFromEnv(resolveAutoProviderFallback());
  }

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

function resolveAutoProviderFallback(): string {
  if (process.env.AGENTFLOW_PROVIDER_STANDARD && process.env.AGENTFLOW_PROVIDER_STANDARD !== "auto") {
    return process.env.AGENTFLOW_PROVIDER_STANDARD;
  }
  if (process.env.BYO_MODEL_BASE_URL && process.env.BYO_MODEL_NAME) {
    return "byo";
  }
  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }
  if (process.env.OPENAI_COMPATIBLE_BASE_URL && process.env.OPENAI_COMPATIBLE_MODEL) {
    return "openai-compatible";
  }
  if (process.env.BEDROCK_MODEL || process.env.AWS_PROFILE || process.env.AWS_REGION || process.env.BEDROCK_REGION) {
    return "bedrock";
  }
  if (process.env.KIRO_API_KEY || process.env.KIRO_AGENT) {
    return "kiro";
  }
  return "mock";
}

export type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export function providerFromEnv(): ModelProvider {
  const provider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";

  if (provider === "mock") {
    return new MockProvider();
  }

  if (provider === "openai") {
    return new OpenAIProvider();
  }

  throw new Error(`Unsupported provider adapter: ${provider}`);
}

export type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

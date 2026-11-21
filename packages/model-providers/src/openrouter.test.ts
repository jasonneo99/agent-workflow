import assert from "node:assert/strict";
import test from "node:test";
import { OpenRouterProvider, OPENROUTER_DEFAULT_BASE_URL, OPENROUTER_DEFAULT_MODEL, openRouterProviderInput } from "./openrouter.js";
import { selectModelFromCatalog } from "./catalog.js";
import { providerFromEnv } from "./index.js";

test("OpenRouter requires its dedicated API key", () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OPENROUTER_API_KEY;
    assert.throws(() => new OpenRouterProvider(), /OPENROUTER_API_KEY is required/u);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("OpenRouter registers a dedicated free-model adapter", () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const provider = providerFromEnv("openrouter");
    assert.equal(provider.id, "openrouter");
    assert.equal(typeof provider.check, "function");
    assert.equal(typeof provider.executeStage, "function");
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test("OpenRouter targets the hosted OpenAI-compatible API and free Gemma model", () => {
  assert.deepEqual(openRouterProviderInput(), {
    id: "openrouter",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    modelEnv: "OPENROUTER_MODEL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    defaultModel: "google/gemma-4-31b-it:free"
  });
  assert.equal(OPENROUTER_DEFAULT_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(OPENROUTER_DEFAULT_MODEL, "google/gemma-4-31b-it:free");
});

test("OpenRouter default model is selected from the compatible model catalog", () => {
  assert.equal(
    selectModelFromCatalog(["text-embedding-3-small", "google/gemma-4-31b-it:free"], "standard", { provider: "compatible" }),
    "google/gemma-4-31b-it:free"
  );
});

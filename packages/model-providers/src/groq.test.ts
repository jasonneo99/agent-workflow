import assert from "node:assert/strict";
import test from "node:test";
import { GroqProvider, GROQ_DEFAULT_BASE_URL, GROQ_DEFAULT_MODEL, groqProviderInput } from "./groq.js";
import { selectModelFromCatalog } from "./catalog.js";
import { providerFromEnv } from "./index.js";

test("Groq requires its dedicated API key", () => {
  const previous = process.env.GROQ_API_KEY;
  try {
    delete process.env.GROQ_API_KEY;
    assert.throws(() => new GroqProvider(), /GROQ_API_KEY is required/u);
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  }
});

test("Groq registers a dedicated gpt-oss adapter", () => {
  const previous = process.env.GROQ_API_KEY;
  try {
    process.env.GROQ_API_KEY = "test-groq-key";
    const provider = providerFromEnv("groq");
    assert.equal(provider.id, "groq");
    assert.equal(typeof provider.check, "function");
    assert.equal(typeof provider.executeStage, "function");
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  }
});

test("Groq targets the hosted OpenAI-compatible API and free gpt-oss-120b model", () => {
  assert.deepEqual(groqProviderInput(), {
    id: "groq",
    baseUrlEnv: "GROQ_BASE_URL",
    modelEnv: "GROQ_MODEL",
    apiKeyEnv: "GROQ_API_KEY",
    defaultBaseURL: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b"
  });
  assert.equal(GROQ_DEFAULT_BASE_URL, "https://api.groq.com/openai/v1");
  assert.equal(GROQ_DEFAULT_MODEL, "openai/gpt-oss-120b");
});

test("Groq default model is selected from the compatible model catalog", () => {
  assert.equal(
    selectModelFromCatalog(["whisper-large-v3", "openai/gpt-oss-120b"], "standard", { provider: "compatible" }),
    "openai/gpt-oss-120b"
  );
});

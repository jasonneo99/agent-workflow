import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL, deepSeekProviderInput } from "./deepseek.js";
import { providerFromEnv } from "./index.js";

test("DeepSeek requires its dedicated API key", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    assert.throws(() => new DeepSeekProvider(), /DEEPSEEK_API_KEY is required/u);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("DeepSeek registers a dedicated Flash adapter", () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const provider = providerFromEnv("deepseek");
    assert.equal(provider.id, "deepseek");
    assert.equal(typeof provider.check, "function");
    assert.equal(typeof provider.executeStage, "function");
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("DeepSeek targets the hosted v1 API and canonical Flash model", () => {
  assert.deepEqual(deepSeekProviderInput(), {
    id: "deepseek",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelEnv: "DEEPSEEK_MODEL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseURL: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-flash"
  });
  assert.equal(DEEPSEEK_DEFAULT_BASE_URL, "https://api.deepseek.com/v1");
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-flash");
});

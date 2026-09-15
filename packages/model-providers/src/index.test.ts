import assert from "node:assert/strict";
import test from "node:test";
import { providerFromEnv } from "./index.js";

test("local provider is a first-class OpenAI-compatible adapter", () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousBaseUrl = process.env.LOCAL_MODEL_BASE_URL;
  const previousModel = process.env.LOCAL_MODEL_NAME;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "local";
    delete process.env.LOCAL_MODEL_BASE_URL;
    process.env.LOCAL_MODEL_NAME = "auto";

    const provider = providerFromEnv();

    assert.equal(provider.id, "local");
    assert.equal(typeof provider.executeStage, "function");
    assert.equal(typeof provider.summarizeFile, "function");
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.LOCAL_MODEL_BASE_URL;
    else process.env.LOCAL_MODEL_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.LOCAL_MODEL_NAME;
    else process.env.LOCAL_MODEL_NAME = previousModel;
  }
});

test("Codex CLI is a first-class provider without requiring an API key", () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "codex-cli";
    delete process.env.OPENAI_API_KEY;
    const provider = providerFromEnv();
    assert.equal(provider.id, "codex-cli");
    assert.equal(typeof provider.check, "function");
    assert.equal(typeof provider.executeStage, "function");
    assert.equal(typeof provider.summarizeFile, "function");
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

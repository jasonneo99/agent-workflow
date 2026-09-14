import assert from "node:assert/strict";
import test from "node:test";
import { selectOpenAIModelFromCatalog } from "./openai.js";
import { extractJsonObject } from "./prompts.js";

test("OpenAI auto catalog selection chooses tier-appropriate newest accessible models", () => {
  const catalog = [
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-6-astra",
    "gpt-5.4-mini-2026-03-17",
    "gpt-6-astra-realtime-preview",
    "text-embedding-3-large"
  ];

  assert.equal(selectOpenAIModelFromCatalog(catalog, "fast"), "gpt-5.6-luna");
  assert.equal(selectOpenAIModelFromCatalog(catalog, "standard"), "gpt-5.6-terra");
  assert.equal(selectOpenAIModelFromCatalog(catalog, "reasoning"), "gpt-6-astra");
});

test("OpenAI auto catalog selection adopts newer GPT families without exact version hard-coding", () => {
  const catalog = [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-6.1-luna",
    "gpt-6.1-terra",
    "gpt-6.1-astra"
  ];

  assert.equal(selectOpenAIModelFromCatalog(catalog, "fast"), "gpt-6.1-luna");
  assert.equal(selectOpenAIModelFromCatalog(catalog, "standard"), "gpt-6.1-terra");
  assert.equal(selectOpenAIModelFromCatalog(catalog, "reasoning"), "gpt-6.1-astra");
});

test("provider JSON extraction ignores trailing duplicate or diagnostic content", () => {
  assert.deepEqual(extractJsonObject('{"summary":"done","detail":"a } brace"}{"duplicate":true}'), {
    summary: "done",
    detail: "a } brace"
  });
  assert.deepEqual(extractJsonObject('```json\n{"summary":"done"}\n```\nverification complete'), {
    summary: "done"
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { explainModelCatalogSelection, selectModelFromCatalog } from "./catalog.js";

test("generic catalog selection prefers efficient local models for fast stages", () => {
  const catalog = [
    "deepseek-r1:32b",
    "qwen2.5-coder:14b",
    "llama3.1:8b",
    "llama3.1:70b"
  ];

  assert.equal(selectModelFromCatalog(catalog, "fast"), "llama3.1:8b");
  assert.equal(selectModelFromCatalog(catalog, "standard"), "qwen2.5-coder:14b");
  assert.equal(selectModelFromCatalog(catalog, "reasoning"), "deepseek-r1:32b");
});

test("model selection policy changes catalog routing preference", () => {
  const catalog = [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.3-codex",
    "gpt-6-astra"
  ];

  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "openai", policy: "lowest-cost" }), "gpt-5.6-luna");
  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "openai", policy: "balanced" }), "gpt-5.6-terra");
  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "openai", policy: "best-coding" }), "gpt-5.3-codex");
  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "openai", policy: "maximum-reasoning" }), "gpt-6-astra");
});

test("Bedrock catalog selection uses provider model names without pinned versions", () => {
  const catalog = [
    "amazon.nova-lite-v1:0",
    "amazon.nova-pro-v1:0",
    "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    "us.anthropic.claude-sonnet-4-20250514-v1:0",
    "us.anthropic.claude-opus-4-20250514-v1:0"
  ];

  assert.equal(selectModelFromCatalog(catalog, "fast", { provider: "bedrock" }), "us.anthropic.claude-3-5-haiku-20241022-v1:0");
  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "bedrock" }), "us.anthropic.claude-sonnet-4-20250514-v1:0");
  assert.equal(selectModelFromCatalog(catalog, "reasoning", { provider: "bedrock" }), "us.anthropic.claude-opus-4-20250514-v1:0");
});

test("catalog explanation exposes selected candidate and excluded non-text models", () => {
  const report = explainModelCatalogSelection([
    "text-embedding-3-large",
    "gpt-5.6-luna",
    "gpt-5.3-codex",
    "gpt-image-1"
  ], "standard", { provider: "openai", policy: "best-coding" });

  assert.equal(report.selectedModel, "gpt-5.3-codex");
  assert.equal(report.candidates[0]?.id, "gpt-5.3-codex");
  assert.equal(report.candidates[0]?.eligible, true);
  assert.equal(report.policy, "best-coding");
  const excluded = report.candidates.filter((candidate) => !candidate.eligible);
  assert.deepEqual(excluded.map((candidate) => candidate.id).sort(), ["gpt-image-1", "text-embedding-3-large"]);
  assert.ok(excluded.every((candidate) => candidate.excludedReason));
});

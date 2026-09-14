import assert from "node:assert/strict";
import test from "node:test";
import { configuredAnthropicModelForTier } from "./anthropic.js";
import { selectModelFromCatalog } from "./catalog.js";

test("Anthropic model configuration supports per-tier overrides", () => {
  const previousModel = process.env.ANTHROPIC_MODEL;
  const previousFast = process.env.ANTHROPIC_MODEL_FAST;
  try {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
    process.env.ANTHROPIC_MODEL_FAST = "claude-haiku-4-5-20251001";
    assert.equal(configuredAnthropicModelForTier("fast"), "claude-haiku-4-5-20251001");
    assert.equal(configuredAnthropicModelForTier("standard"), "claude-sonnet-4-6");
  } finally {
    restoreEnv("ANTHROPIC_MODEL", previousModel);
    restoreEnv("ANTHROPIC_MODEL_FAST", previousFast);
  }
});

test("Anthropic catalog routing selects Claude families by tier", () => {
  const catalog = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "not-a-claude-model"];
  assert.equal(selectModelFromCatalog(catalog, "fast", { provider: "anthropic" }), "claude-haiku-4-5-20251001");
  assert.equal(selectModelFromCatalog(catalog, "standard", { provider: "anthropic" }), "claude-sonnet-4-6");
  assert.equal(selectModelFromCatalog(catalog, "reasoning", { provider: "anthropic" }), "claude-opus-4-6");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

import assert from "node:assert/strict";
import test from "node:test";
import { codexCliModelSummary, codexCliTierModelPreview } from "./codex-provider.js";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Codex dashboard exposes effective models for every workflow tier", () => {
  const names = ["CODEX_CLI_MODEL", "CODEX_CLI_MODEL_FAST", "CODEX_CLI_MODEL_STANDARD", "CODEX_CLI_MODEL_REASONING"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CODEX_CLI_MODEL_FAST = "gpt-6-luna";
    process.env.CODEX_CLI_MODEL_STANDARD = "gpt-6.1-sol";
    process.env.CODEX_CLI_MODEL_REASONING = "gpt-6-astra";
    const preview = codexCliTierModelPreview();
    assert.deepEqual(preview.map(({ tier, model, source }) => ({ tier, model, source })), [
      { tier: "fast", model: "gpt-6-luna", source: "env" },
      { tier: "standard", model: "gpt-6.1-sol", source: "env" },
      { tier: "reasoning", model: "gpt-6-astra", source: "env" }
    ]);
    assert.equal(codexCliModelSummary(preview), "tier-based");
  } finally {
    for (const name of names) restore(name, previous[name]);
  }
});

test("Codex dashboard reports the inherited CLI default honestly", () => {
  const names = ["CODEX_CLI_MODEL", "CODEX_CLI_MODEL_FAST", "CODEX_CLI_MODEL_STANDARD", "CODEX_CLI_MODEL_REASONING"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const preview = codexCliTierModelPreview();
    assert.ok(preview.every((item) => item.model === "CLI default" && item.source === "unavailable"));
    assert.equal(codexCliModelSummary(preview), "CLI default");
  } finally {
    for (const name of names) restore(name, previous[name]);
  }
});

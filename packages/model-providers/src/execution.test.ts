import assert from "node:assert/strict";
import test from "node:test";
import { modelCandidatesExhaustedError } from "./fallback.js";
import { executeStageWithProviderFallback } from "./execution.js";
import type { ModelProvider, StageExecutionInput } from "./types.js";

const stage = { modelTier: "standard" } as StageExecutionInput;

test("execution advances across providers after funding failures", async () => {
  const providers: Record<string, ModelProvider> = {
    first: { id: "first", executeStage: async () => { throw modelCandidatesExhaustedError("first", [{ providerId: "first", model: "best", status: 402, category: "funding", retryNextModel: true, message: "credits" }]); } },
    second: { id: "second", check: async () => ({ ready: true, details: [] }), executeStage: async () => ({ summary: "ok", artifact: { model: "fallback" } }) }
  };
  const result = await executeStageWithProviderFallback({ stage, primaryProviderId: "first", fallbackProviderIds: ["second"], providerFactory: (id) => providers[id] });
  assert.equal(result.providerId, "second");
  assert.equal(result.attempts[0]?.providerId, "first");
});

test("execution does not fan out after authentication failure", async () => {
  let fallbackCalled = false;
  const providers: Record<string, ModelProvider> = {
    first: { id: "first", executeStage: async () => { throw modelCandidatesExhaustedError("first", [{ providerId: "first", model: "best", status: 401, category: "authentication", retryNextModel: false, message: "auth" }]); } },
    second: { id: "second", executeStage: async () => { fallbackCalled = true; return { summary: "unexpected", artifact: {} }; } }
  };
  await assert.rejects(() => executeStageWithProviderFallback({ stage, primaryProviderId: "first", fallbackProviderIds: ["second"], providerFactory: (id) => providers[id] }));
  assert.equal(fallbackCalled, false);
});

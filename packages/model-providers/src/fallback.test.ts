import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderFailure, executeWithProviderFallback, ProviderExecutionError, resetProviderFallbackCircuits, type ProviderFallbackPolicy } from "./fallback.js";
import type { ModelProvider, StageExecutionInput } from "./types.js";

const stageInput = { runId: "run-1", taskId: "task-1", workflowId: "build-feature", stageId: "build", agentId: "implementation-agent", modelTier: "standard" } as StageExecutionInput;
const policy = (chains: ProviderFallbackPolicy["chains"], overrides: Partial<ProviderFallbackPolicy> = {}): ProviderFallbackPolicy => ({ chains, maxRetries: 1, circuitFailureThreshold: 3, circuitCooldownMs: 60_000, allowQuotaFallback: false, ...overrides });
const success = (id: string, model = "model-a"): ModelProvider => ({ id, async executeStage() { return { summary: "ok", artifact: { provider: id, model } }; } });
const failure = (id: string, error: Error, counter?: { calls: number }): ModelProvider => ({ id, async executeStage() { if (counter) counter.calls += 1; throw error; } });

test("provider failures are classified without preserving provider response bodies", () => {
  assert.equal(classifyProviderFailure({ status: 401, message: "secret response" }).kind, "authentication");
  assert.equal(classifyProviderFailure({ status: 429, code: "insufficient_quota" }).kind, "account_quota");
  assert.equal(classifyProviderFailure({ status: 429, message: "rate limit" }).kind, "rate_limited");
  assert.equal(classifyProviderFailure({ status: 404, message: "model not found" }).kind, "model_unavailable");
  assert.equal(classifyProviderFailure({ code: "ECONNREFUSED" }).kind, "provider_outage");
  assert.equal(classifyProviderFailure(new Error("Connection error.")).kind, "provider_outage");
  assert.equal(classifyProviderFailure({ status: 401, message: "secret response" }).message.includes("secret"), false);
});

test("typed Codex diagnostics preserve only category and digest while retrying transient failures", async () => {
  resetProviderFallbackCircuits();
  const transient = Object.assign(new Error("must not persist /Users/example/private token=secret"), {
    code: "CODEX_CLI_EXIT_1",
    retryable: true,
    diagnostic: { source: "codex-cli", category: "transport", digest: "a".repeat(64), retryable: true, exitCode: 1 }
  });
  const classified = classifyProviderFailure(transient);
  assert.equal(classified.kind, "provider_outage");
  assert.match(classified.message, /transport.*diagnostic a{12}/iu);
  assert.doesNotMatch(classified.message, /Users|private|secret/iu);

  let calls = 0;
  const result = await executeWithProviderFallback({
    providerId: "codex-cli",
    stageInput,
    policy: policy({}),
    providerFactory: () => ({ id: "codex-cli", async executeStage() { calls += 1; if (calls === 1) throw transient; return { summary: "ok", artifact: {} }; } }),
    delay: async () => undefined,
    circuitStatePath: null
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 2);
  assert.match(result.attempts[0]?.reason ?? "", /diagnostic a{12}/iu);
});

test("typed non-transient Codex diagnostics do not retry or expose raw output", async () => {
  resetProviderFallbackCircuits();
  let calls = 0;
  const failure = Object.assign(new Error("invalid output schema at /Users/example/private"), {
    code: "CODEX_CLI_EXIT_2",
    retryable: false,
    diagnostic: { source: "codex-cli", category: "schema_or_usage", digest: "b".repeat(64), retryable: false, exitCode: 2 }
  });
  await assert.rejects(() => executeWithProviderFallback({
    providerId: "codex-cli",
    stageInput,
    policy: policy({}),
    providerFactory: () => ({ id: "codex-cli", async executeStage() { calls += 1; throw failure; } }),
    delay: async () => undefined,
    circuitStatePath: null
  }), (error: unknown) => error instanceof ProviderExecutionError && /schema or usage.*diagnostic b{12}/iu.test(error.message) && !/Users|private/iu.test(error.message));
  assert.equal(calls, 1);
});

test("outage retries are bounded and preserve deterministic attempt identities before fallback", async () => {
  resetProviderFallbackCircuits();
  const primary = { calls: 0 };
  const result = await executeWithProviderFallback({
    providerId: "primary",
    stageInput,
    policy: policy({ primary: [{ provider: "backup", model: "backup-model", fleetApproved: true, dataPolicy: "private" }] }),
    providerFactory: (id) => id === "primary" ? failure(id, Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), primary) : success(id),
    delay: async () => undefined,
    circuitStatePath: null
  });
  assert.equal(primary.calls, 2);
  assert.equal(result.actualProvider, "backup");
  assert.equal(result.actualModel, "backup-model");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0]?.attemptId.length, 64);
  assert.equal(new Set(result.attempts.map((attempt) => attempt.attemptId)).size, 3);
});

test("authentication and configuration failures never retry or route", async () => {
  resetProviderFallbackCircuits();
  let backupCalls = 0;
  await assert.rejects(() => executeWithProviderFallback({
    providerId: "primary", stageInput, policy: policy({ primary: [{ provider: "backup" }] }),
    providerFactory: (id) => id === "primary" ? failure(id, Object.assign(new Error("unauthorized"), { status: 401 })) : { ...success(id), async executeStage(input) { backupCalls += 1; return success(id).executeStage(input); } },
    circuitStatePath: null
  }), (error: unknown) => error instanceof ProviderExecutionError && error.kind === "authentication");
  assert.equal(backupCalls, 0);
});

test("exhausted account quota routes only to an approved provider with a declared data policy", async () => {
  resetProviderFallbackCircuits();
  const quota = Object.assign(new Error("insufficient_quota"), { status: 429, code: "insufficient_quota" });
  await assert.rejects(() => executeWithProviderFallback({ providerId: "openai", stageInput, policy: policy({ openai: [{ provider: "backup" }] }, { allowQuotaFallback: true, maxRetries: 0 }), providerFactory: (id) => id === "openai" ? failure(id, quota) : success(id), circuitStatePath: null }), ProviderExecutionError);
  const result = await executeWithProviderFallback({ providerId: "openai", stageInput, policy: policy({ openai: [{ provider: "backup", fleetApproved: true, dataPolicy: "private" }] }, { allowQuotaFallback: true, maxRetries: 0 }), providerFactory: (id) => id === "openai" ? failure(id, quota) : success(id), circuitStatePath: null });
  assert.equal(result.actualProvider, "backup");
});

test("an open circuit skips the unhealthy provider during cooldown", async () => {
  resetProviderFallbackCircuits();
  const primary = { calls: 0 };
  const config = { providerId: "primary", stageInput, policy: policy({ primary: [{ provider: "backup" }] }, { maxRetries: 0, circuitFailureThreshold: 1 }), providerFactory: (id: string) => id === "primary" ? failure(id, new Error("service unavailable"), primary) : success(id), delay: async () => undefined, circuitStatePath: null };
  await executeWithProviderFallback(config);
  await executeWithProviderFallback(config);
  assert.equal(primary.calls, 1);
});

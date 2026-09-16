import assert from "node:assert/strict";
import test from "node:test";
import { assertFence, assertTransition, deriveRunState, evaluateReliabilitySlos, objectiveHash, releaseRequiresRollback, reliabilityFailureScenarios, sideEffectKey, workIntentsConflict } from "./index.js";

test("authoritative state machine rejects terminal rewrites and derives run state from stages", () => {
  assert.doesNotThrow(() => assertTransition("queued", "leased"));
  assert.throws(() => assertTransition("completed", "running"), /Invalid workflow transition/u);
  assert.equal(deriveRunState(["completed", "cancelled"]), "completed");
  assert.equal(deriveRunState(["completed", "blocked"]), "blocked");
  assert.equal(deriveRunState(["leased", "queued"]), "leased");
});

test("fencing, work ownership, and side-effect identities are deterministic", () => {
  assert.doesNotThrow(() => assertFence("4", 4));
  assert.throws(() => assertFence(4, 3), /Stale/u);
  const goal = objectiveHash(" Fix   fleet health ");
  assert.equal(goal, objectiveHash("fix fleet health"));
  assert.equal(workIntentsConflict({ owner: "codex", objectiveHash: goal, fileScopes: ["packages"] }, { owner: "daemon", objectiveHash: "different", fileScopes: ["packages/storage"] }), true);
  assert.equal(workIntentsConflict({ owner: "codex", objectiveHash: goal, fileScopes: ["apps"] }, { owner: "codex", objectiveHash: goal, fileScopes: ["apps"] }), false);
  assert.equal(sideEffectKey({ projectId: "p", operation: "commit", target: "repo", payloadHash: "h" }), sideEffectKey({ projectId: "p", operation: "commit", target: "repo", payloadHash: "h" }));
});

test("release rollback and reliability SLOs fail closed", () => {
  assert.equal(releaseRequiresRollback({ switched: true, healthPassed: false, servicesReady: true }), true);
  assert.ok(reliabilityFailureScenarios.includes("overlapping_codex_and_daemon_write"));
  const healthy = evaluateReliabilitySlos({ totalMutations: 4, receiptedMutations: 4, duplicateSideEffects: 0, stuckRuns: 0, recoveryDurationsMs: [20_000], fleetFalseCriticals: 0, rollbackDurationsMs: [10_000], invalidTerminalRuns: 0 });
  assert.equal(healthy.status, "pass");
  assert.equal(evaluateReliabilitySlos({ totalMutations: 4, receiptedMutations: 3, duplicateSideEffects: 1, stuckRuns: 1, recoveryDurationsMs: [400_000], fleetFalseCriticals: 1, rollbackDurationsMs: [130_000], invalidTerminalRuns: 1 }).status, "attention");
  assert.equal(evaluateReliabilitySlos({ totalMutations: 0, receiptedMutations: 0, duplicateSideEffects: 0, stuckRuns: 0, recoveryDurationsMs: [], fleetFalseCriticals: 0, rollbackDurationsMs: [], invalidTerminalRuns: 0 }).status, "attention");
});

test("the deterministic failure matrix covers every reliability boundary", () => {
  assert.deepEqual(new Set(reliabilityFailureScenarios), new Set([
    "worker_killed_after_side_effect", "lease_expires_during_execution", "daemon_restarts_mid_sweep",
    "postgres_unavailable", "redis_unavailable", "object_store_unavailable", "provider_timeout",
    "duplicate_authenticated_request", "overlapping_codex_and_daemon_write", "release_health_check_failure"
  ]));
  assert.throws(() => assertFence(7, 6), /Stale/u);
  assert.equal(workIntentsConflict(
    { owner: "codex", objectiveHash: "one", fileScopes: [] },
    { owner: "daemon", objectiveHash: "two", fileScopes: ["packages"] }
  ), true);
  assert.equal(releaseRequiresRollback({ switched: true, healthPassed: true, servicesReady: false }), true);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  adversarialSuiteSchema,
  adversarialThreatClasses,
  advanceTransaction,
  authorizeGuardedAction,
  authorizeMemoryUse,
  evaluatePromotionEvidence,
  memoryClaimSchema,
  stageAuthorityGrantSchema,
  transactionReceiptSchema
} from "./index.js";
import fs from "node:fs/promises";
import path from "node:path";

const hash = "a".repeat(64);
const grant = stageAuthorityGrantSchema.parse({ schema_version: 1, id: "g1", project_id: "p", run_id: "r", stage_id: "s", requested_level: "simulate", policy_ceiling: "bounded_local", issued_level: "simulate", effect_class: "R0", evidence_hashes: [hash], policy_hash: hash, breaker_generations: { "global:all": 1 }, issued_by: "policy-engine", issued_at: "2026-09-23T00:00:00.000Z", expires_at: "2026-09-24T00:00:00.000Z", preview_only: true });

test("model requests cannot raise authority above policy", () => {
  assert.equal(stageAuthorityGrantSchema.safeParse({ ...grant, requested_level: "approved_execute", policy_ceiling: "propose", issued_level: "simulate" }).success, false);
});

test("breaker reads fail closed and stale generations deny action", () => {
  assert.equal(authorizeGuardedAction({ grant, currentBreakers: null, now: "2026-09-23T01:00:00.000Z", mutation: true }).allowed, false);
  const result = authorizeGuardedAction({ grant: { ...grant, preview_only: false }, currentBreakers: [{ schema_version: 1, scope: "global", scope_id: "all", generation: 2, state: "enabled", reason: "normal", actor: "operator", created_at: "2026-09-23T00:00:00.000Z", human_authored: true, evidence_hashes: [] }], now: "2026-09-23T01:00:00.000Z", mutation: true });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(" "), /stale breaker generation/u);
});

test("conflicting memory remains usable for planning but is blocked for action", () => {
  const claim = memoryClaimSchema.parse({ schema_version: 1, id: "m1", project_id: "p", tenant_id: "t", source_kind: "direct_observation", source_hash: hash, created_by: "test", created_at: "2026-09-23T00:00:00.000Z", evidence_strength: 0.95, dependency_ids: [], conflict_ids: ["m2"], permitted_use: "action", state: "disputed" });
  assert.equal(authorizeMemoryUse({ claim, projectId: "p", tenantId: "t", use: "planning", now: "2026-09-23T01:00:00.000Z" }).allowed, true);
  assert.equal(authorizeMemoryUse({ claim, projectId: "p", tenantId: "t", use: "action", now: "2026-09-23T01:00:00.000Z" }).allowed, false);
});

test("stale leases and unverified outcomes cannot complete transactions", () => {
  const receipt = transactionReceiptSchema.parse({ schema_version: 1, transaction_id: "tx", idempotency_key: "key", lease_generation: 3, state: "verifying", completed_checkpoints: ["write"], observed_effect_hashes: [hash], verification: "pending", unresolved_risks: [], rollback_available: true });
  assert.throws(() => advanceTransaction({ receipt, expectedLeaseGeneration: 2, nextState: "completed", verification: "passed" }), /Stale lease/u);
  assert.throws(() => advanceTransaction({ receipt, expectedLeaseGeneration: 3, nextState: "completed" }), /passing verification/u);
  assert.equal(advanceTransaction({ receipt, expectedLeaseGeneration: 3, nextState: "completed", verification: "passed" }).state, "completed");
});

test("promotion remains recommendation-only below the canary sample threshold", () => {
  const result = evaluatePromotionEvidence({ representative_cases: 20, cases_per_affected_workflow: { debugging: 20 }, relative_quality_gain: 0.1, absolute_quality_gain_points: 4, confidence_excludes_meaningful_degradation: true, new_severe_safety_violations: 0, verification_regression: 0, recovery_regression: 0, policy_regression: 0, cost_regression: 0, latency_regression: 0 });
  assert.equal(result.decision, "recommendation_only");
});

test("any severe safety regression blocks promotion", () => {
  const result = evaluatePromotionEvidence({ representative_cases: 40, cases_per_affected_workflow: { debugging: 10 }, relative_quality_gain: 0.1, absolute_quality_gain_points: 4, confidence_excludes_meaningful_degradation: true, new_severe_safety_violations: 1, verification_regression: 0, recovery_regression: 0, policy_regression: 0, cost_regression: 0, latency_regression: 0 });
  assert.equal(result.decision, "blocked");
});

test("committed adversarial suite covers every required boundary threat without private data", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const suite = adversarialSuiteSchema.parse(JSON.parse(await fs.readFile(path.join(repositoryRoot, "evals/reliability-suite/adversarial.v1.json"), "utf8")));
  assert.deepEqual(new Set(suite.cases.map((item) => item.threat_class)), new Set(adversarialThreatClasses));
  assert.equal(suite.cases.every((item) => item.synthetic && !item.network_allowed && !item.private_data_included), true);
});

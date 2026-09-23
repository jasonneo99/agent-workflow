import assert from "node:assert/strict";
import test from "node:test";
import { parseAdaptiveRouteEvidence, selectAdaptiveEvidence, type AdaptiveRouteEvidence } from "./adaptive-evidence.js";

const now = new Date("2026-09-23T12:00:00.000Z");

function record(overrides: Partial<AdaptiveRouteEvidence> = {}): AdaptiveRouteEvidence {
  return { agentId: "test-engineer", taskClass: "verify", providerId: "mock", modelId: "mock-fast", samples: 8, quality: 0.9, taskSuccess: 0.95, fallbackRate: 0, latencyMs: 1_000, costUsd: 0, observedAt: "2026-09-22T12:00:00.000Z", ...overrides };
}

test("selects fresh passing evidence for the exact agent and task class", () => {
  const decision = selectAdaptiveEvidence([record(), record({ providerId: "slow", quality: 0.8, latencyMs: 60_000 })], { agentId: "test-engineer", taskClass: "verify", now });
  assert.equal(decision.status, "selected");
  assert.equal(decision.candidate?.providerId, "mock");
  assert.ok(decision.confidence > 0);
});

test("distinguishes insufficient evidence from poor performance and decays stale data", () => {
  assert.equal(selectAdaptiveEvidence([record({ samples: 2 })], { agentId: "test-engineer", taskClass: "verify", now }).status, "insufficient-evidence");
  assert.equal(selectAdaptiveEvidence([record({ quality: 0.4 })], { agentId: "test-engineer", taskClass: "verify", now }).status, "poor-performance");
  assert.equal(selectAdaptiveEvidence([record({ observedAt: "2026-07-01T00:00:00.000Z" })], { agentId: "test-engineer", taskClass: "verify", now }).status, "insufficient-evidence");
});

test("parses only valid structured route evidence", () => {
  const parsed = parseAdaptiveRouteEvidence(`## Adaptive Route Evidence\n- ${JSON.stringify(record())}\n- not-json\n\n## Next\nbody`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.modelId, "mock-fast");
});

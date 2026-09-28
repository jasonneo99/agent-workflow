import assert from "node:assert/strict";
import test from "node:test";
import { scoreCandidate, selectTaskCandidate, typedDecisionReceipt, validateCandidate, type DecisionCandidate, type DecisionCase, type DecisionObservation } from "./index.js";

const candidate: DecisionCandidate = { id: "local-candidate", publisher: "Example Publisher", boundary: "local", license: "Apache-2.0", runtime: "local-runtime", available: true, provenanceUrl: "https://example.invalid/model", updatedAt: "2026-09-28T00:00:00Z" };
const cases: DecisionCase[] = [
  { id: "a", taskClass: "approval-risk", kind: "boolean", expected: false, risk: "medium" },
  { id: "b", taskClass: "approval-risk", kind: "boolean", expected: true, risk: "low" },
  { id: "c", taskClass: "approval-risk", kind: "boolean", expected: true, risk: "low" }
];
const observations: DecisionObservation[] = [
  { caseId: "a", candidateId: candidate.id, answer: false, confidence: 0.9, abstained: false, latencyMs: 10, estimatedCostUsd: 0 },
  { caseId: "b", candidateId: candidate.id, answer: true, confidence: 0.8, abstained: false, latencyMs: 12, estimatedCostUsd: 0 },
  { caseId: "c", candidateId: candidate.id, abstained: true, latencyMs: 9, estimatedCostUsd: 0 }
];

test("candidate registry requires portable provenance instead of a hard-coded winner", () => {
  assert.equal(validateCandidate(candidate).id, candidate.id);
  assert.throws(() => validateCandidate({ ...candidate, provenanceUrl: "http://example.invalid" }), /HTTPS/u);
  assert.throws(() => validateCandidate({ ...candidate, license: "" }), /provenance fields/u);
});

test("shadow scoring keeps abstention and calibration visible", () => {
  const score = scoreCandidate({ candidate, cases, observations, taskClass: "approval-risk" });
  assert.equal(score.samples, 3);
  assert.equal(score.answered, 2);
  assert.equal(score.accuracy, 2 / 3);
  assert.equal(score.abstentionRate, 1 / 3);
  assert.equal(score.falseApprovalRate, 0);
  assert.ok((score.brierScore ?? 1) < 0.1);
});

test("selection fails closed to rules unless every threshold passes", () => {
  const score = scoreCandidate({ candidate, cases, observations, taskClass: "approval-risk" });
  const blocked = selectTaskCandidate({ scores: [score], candidates: [candidate], thresholds: { minimumSamples: 3, minimumAccuracy: 0.9, maximumBrierScore: 0.1, maximumFalseApprovalRate: 0, maximumAbstentionRate: 0.1, maximumP95LatencyMs: 100 } });
  assert.equal(blocked.selected, null);
  assert.match(blocked.reasons[0] ?? "", /retain deterministic rules/u);
  const eligible = selectTaskCandidate({ scores: [{ ...score, accuracy: 1, abstentionRate: 0 }], candidates: [candidate], thresholds: { minimumSamples: 3, minimumAccuracy: 0.9, maximumBrierScore: 0.1, maximumFalseApprovalRate: 0, maximumAbstentionRate: 0.1, maximumP95LatencyMs: 100 } });
  assert.equal(eligible.selected?.candidateId, candidate.id);
  assert.match(typedDecisionReceipt({ taskClass: "approval-risk", candidateId: candidate.id, policyVersion: "v1", scores: eligible.eligible }).evidenceHash, /^[a-f0-9]{64}$/u);
});

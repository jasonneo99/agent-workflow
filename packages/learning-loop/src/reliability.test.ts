import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLearningReliability, learningLoopFaultMatrix, traceLearningConclusion } from "./reliability.js";
import type { LearningLoopState } from "./runtime.js";

test("production reliability remains evidence-gated until every drill and calibration threshold passes", () => {
  const base = { completedRuns: 100, unsafeActionAttempts: 0, invalidTerminalWrites: 0, breakerTrips: 100, falseCriticalTrips: 1, recoveryP95Ms: 30_000, reviewerMinutesP95: 5, rollbackDrillPassed: true, duplicateEffectDrillPassed: true, faultResults: Object.fromEntries(learningLoopFaultMatrix.map((item) => [item, true])) };
  assert.equal(evaluateLearningReliability(base).status, "ready-for-reviewed-canary");
  assert.equal(evaluateLearningReliability({ ...base, falseCriticalTrips: 3 }).status, "blocked");
  assert.equal(evaluateLearningReliability({ ...base, completedRuns: 12 }).status, "insufficient-evidence");
});

test("end-to-end trace refuses to call partial learning evidence complete", () => {
  const state = { version: 1, questions: [{ id: "q" }], responses: [], assessments: [], calibrations: [], aggregates: [], experiments: [], receipts: [], schedulerReceipts: [], updatedAt: new Date(0).toISOString() } as unknown as LearningLoopState;
  const trace = traceLearningConclusion(state, "q");
  assert.equal(trace.complete, false);
  assert.ok(trace.missing.includes("response"));
  assert.ok(trace.missing.includes("promotion or reversible terminal outcome"));
});

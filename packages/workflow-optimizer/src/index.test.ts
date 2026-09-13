import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canSchedule, createJarvisIntent, fleetHealth, optimizationReceipt, previewJarvisPlan, rankRecommendations, runOptimizerCycle, runSharedBrainCanary, sharedBrainSummary, shouldWake, simulateRecommendation, verifyFleetControlAction } from "./index.js";

test("event wakeups deduplicate and budgets enforce quiet hours and backpressure", () => {
  assert.equal(shouldWake({ id: "e1", kind: "run.completed", projectId: "p", occurredAt: "now" }, new Set()), true);
  assert.equal(canSchedule({ projectId: "p", maxActions: 2, consumedActions: 0, queueDepth: 2 }, 12).reason, "backpressure");
  assert.equal(canSchedule({ projectId: "p", maxActions: 4, consumedActions: 0, queueDepth: 0, quietHours: { start: 22, end: 7 } }, 23).reason, "quiet hours");
});

test("optimizer cycle persists event cursors and shadow evidence", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "optimizer-"));
  const result = await runOptimizerCycle({ projectDir, events: [{ id: "e", kind: "feedback.created", projectId: "p", occurredAt: "now" }], recommendations: [{ id: "r", projectId: "p", kind: "routing", evidence: 1, impact: 1, reversibility: 1, risk: "low", confidence: 1 }], historicalOutcomes: { r: [.1, .2, .3] } });
  assert.equal(result.woke, true);
  assert.equal((await fs.readFile(path.join(projectDir, ".agent-workflow/learning/optimizer-state.json"), "utf8")).includes('"e"'), true);
});

test("Fleet actions require valid signatures and allowlisting; shared-brain canary covers every path", () => {
  const keys = generateKeyPairSync("ed25519");
  const unsigned = { actionId: "a", operation: "host.status", target: "fleet-node", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString("base64");
  assert.equal(verifyFleetControlAction({ ...unsigned, signature }, keys.publicKey.export({ type: "spki", format: "pem" }).toString(), new Set(["host.status"])), true);
  const intent = createJarvisIntent({ requestId: "r", conversationId: "c", goal: "status", requestedAutonomy: "observe", createdAt: "now" });
  assert.equal(previewJarvisPlan(intent, []).executable, false);
  assert.equal(runSharedBrainCanary({ intent, planPreviewed: true, executed: true, observed: true, approved: true, recovered: true, summarized: true }).passed, true);
});

test("recommendations are explainably ranked, shadowed, receipted, and summarized", () => {
  const ranked = rankRecommendations([{ id: "r", projectId: "p", kind: "handoff", evidence: 1, impact: .8, reversibility: 1, risk: "low", confidence: .9 }]);
  assert.equal(simulateRecommendation(ranked[0], [.1, .2, .3]).promotable, true);
  assert.equal(optimizationReceipt({ recommendationId: "r", action: "rollback", beforeHash: "a", afterHash: "b" }).receiptId.length, 64);
  assert.equal(fleetHealth([{ projectId: "p", maxActions: 4, consumedActions: 1, queueDepth: 0 }], ranked, 0).status, "healthy");
});

test("Jarvis intents are non-executable and summaries exclude raw memory", () => {
  const intent = createJarvisIntent({ requestId: "r", conversationId: "c", goal: "build", requestedAutonomy: "propose", createdAt: "now" });
  assert.equal(intent.executable, false);
  assert.equal(sharedBrainSummary({ activeGoals: [], recentDecisions: [], openApprovalCount: 1, learnedPreferenceCount: 2, degradedServices: [] }).rawMemoryIncluded, false);
});

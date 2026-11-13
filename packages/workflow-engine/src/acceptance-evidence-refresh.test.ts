import assert from "node:assert/strict";
import test from "node:test";
import type { StructuredAcceptanceContract } from "../../model-providers/src/types.js";
import { refreshAcceptanceEvidence, type GovernedCommandObservation } from "./acceptance-evidence-refresh.js";

function observation(id: string, seconds: number): GovernedCommandObservation {
  return { artifactId: id, projectId: "project", commandLine: "npm test", passed: true,
    sourcePaths: ["src/fixture.ts"], sourceBefore: "source", sourceAfter: "source",
    reference: { artifactUri: `db://artifacts/${id}`, runId: "run", taskId: `task-${id}`,
      stageId: seconds === 0 ? "implementation" : "verification", kind: "command_output",
      contentHash: `hash-${id}`, observedAt: new Date(1_700_000_000_000 + seconds * 1000).toISOString(), subjectHash: "source" } };
}
function contract(ref = observation("old", 0).reference): StructuredAcceptanceContract {
  return { version: 1, contractId: "contract", projectId: "project", originRunId: "run", taskHash: "task",
    subjectHash: "source", sourcePaths: ["src/fixture.ts"], deliverables: [{ id: "required", description: "Original requirement",
      status: "verified", requiredGates: ["implementation", "verification", "packaging", "supervision"], gaps: [],
      receipts: { implementation: [ref] } }] };
}

test("refreshes stale exact evidence for provider input without mutating the contract or observations", () => {
  const old = observation("old", 0), newer = observation("new", 1), input = contract();
  const before = JSON.stringify(input);
  const result = refreshAcceptanceEvidence(input, [newer, old]);
  assert.deepEqual(result.contract.deliverables[0].receipts.implementation, [newer.reference]);
  assert.deepEqual(result.replacements, [{ from: old.reference.artifactUri, to: newer.reference.artifactUri }]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual({ ...result.contract, deliverables: input.deliverables }, input);
  assert.deepEqual({ ...result.contract.deliverables[0], receipts: input.deliverables[0].receipts }, input.deliverables[0]);
});

for (const [name, mutate] of Object.entries({
  failure: (o: GovernedCommandObservation) => { o.passed = false; },
  project: (o: GovernedCommandObservation) => { o.projectId = "other"; },
  sourceBefore: (o: GovernedCommandObservation) => { o.sourceBefore = "drift"; },
  sourceAfter: (o: GovernedCommandObservation) => { o.sourceAfter = "drift"; },
  paths: (o: GovernedCommandObservation) => { o.sourcePaths = ["other.ts"]; },
  subject: (o: GovernedCommandObservation) => { o.reference.subjectHash = "drift"; },
  timestamp: (o: GovernedCommandObservation) => { o.reference.observedAt = "invalid"; }
})) test(`does not hide latest ${name} behind an older success`, () => {
  const latest = observation("latest", 2); mutate(latest);
  const input = contract();
  const result = refreshAcceptanceEvidence(input, [observation("old", 0), observation("middle", 1), latest]);
  assert.deepEqual(result.contract, input);
  assert.deepEqual(result.replacements, []);
});

test("never repairs a forged reference or substitutes cross-run or different-command evidence", () => {
  const old = observation("old", 0), otherRun = observation("other-run", 3), otherCommand = observation("other-command", 4);
  otherRun.reference.runId = "unrelated"; otherCommand.commandLine = "npm test -- --different";
  const input = contract();
  assert.deepEqual(refreshAcceptanceEvidence(input, [old, otherRun, otherCommand]).contract, input);
  const forged = contract({ ...old.reference, contentHash: "provider-forgery" });
  assert.deepEqual(refreshAcceptanceEvidence(forged, [old, observation("new", 1)]).contract, forged);
});

test("does not fill missing evidence, clear gaps, promote status or change gate coverage", () => {
  const input = contract();
  input.deliverables[0].status = "blocked"; input.deliverables[0].gaps = ["still missing"];
  input.deliverables[0].receipts.packaging = [];
  const result = refreshAcceptanceEvidence(input, [observation("old", 0), observation("new", 1)]).contract;
  assert.equal(result.deliverables[0].status, "blocked");
  assert.deepEqual(result.deliverables[0].gaps, ["still missing"]);
  assert.deepEqual(result.deliverables[0].receipts.packaging, []);
  assert.deepEqual(result.deliverables[0].requiredGates, input.deliverables[0].requiredGates);
});

test("uses artifact identity to retain the latest failed execution at equal timestamps", () => {
  const old = observation("00000000-0000-0000-0000-000000000001", 0);
  const latest = observation("00000000-0000-0000-0000-000000000002", 0);
  latest.passed = false;
  const input = contract(old.reference);
  assert.deepEqual(refreshAcceptanceEvidence(input, [latest, old]).contract, input);
});

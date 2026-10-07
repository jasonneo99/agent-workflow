import assert from "node:assert/strict";
import test from "node:test";
import { structuredAcceptanceReason } from "../../model-providers/src/quality.js";
import type { ResolvedAcceptanceReceipt } from "../../model-providers/src/quality.js";
import type { AcceptanceGate, AcceptanceReceiptReference, StructuredAcceptanceContract } from "../../model-providers/src/types.js";

const gates: AcceptanceGate[] = ["implementation", "verification", "packaging", "supervision"];
function fixture(): StructuredAcceptanceContract {
  const reference: AcceptanceReceiptReference = {
    artifactUri: "db://synthetic/run-a/check", runId: "run-a", taskId: "task-a", stageId: "verify",
    kind: "command_output", contentHash: "synthetic-content", observedAt: "2026-01-01T00:00:00.000Z", subjectHash: "subject-a"
  };
  return {
    version: 1, contractId: "contract-a", projectId: "project-a", originRunId: "run-a", taskHash: "task-hash-a", subjectHash: "subject-a",
    deliverables: [{ id: "product", description: "Deliver the existing synthetic product without edits", requiredGates: [...gates], status: "verified",
      receipts: Object.fromEntries(gates.map((gate) => [gate, [{ ...reference }]])), gaps: [] }]
  };
}
const resolve = async (reference: AcceptanceReceiptReference): Promise<ResolvedAcceptanceReceipt> => ({ ...reference, projectId: "project-a", passed: true });

test("structured gates accept governed no-edit delivery evidence", async () => {
  for (const gate of gates) assert.equal(await structuredAcceptanceReason(fixture(), gate, resolve), null);
});

test("every structured gate rejects missing, failed, stale and cross-run evidence", async () => {
  for (const gate of gates) {
    const missing = fixture();
    missing.deliverables[0].receipts[gate] = [];
    assert.notEqual(await structuredAcceptanceReason(missing, gate, resolve), null);
    assert.notEqual(await structuredAcceptanceReason(fixture(), gate, async () => null), null);
    assert.notEqual(await structuredAcceptanceReason(fixture(), gate, async (reference) => ({ ...await resolve(reference), passed: false })), null);
    assert.notEqual(await structuredAcceptanceReason(fixture(), gate, async (reference) => ({ ...await resolve(reference), subjectHash: "stale-subject" })), null);
    assert.notEqual(await structuredAcceptanceReason(fixture(), gate, async (reference) => ({ ...await resolve(reference), contentHash: "changed-content" })), null);
    assert.notEqual(await structuredAcceptanceReason(fixture(), gate, async (reference) => ({ ...await resolve(reference), runId: "run-b" })), null);
  }
});

test("uncovered gates, pending deliverables and unresolved gaps fail closed", async () => {
  for (const gate of gates) {
    const uncovered = fixture();
    uncovered.deliverables[0].requiredGates = gates.filter((candidate) => candidate !== gate);
    assert.notEqual(await structuredAcceptanceReason(uncovered, gate, resolve), null);
    const pending = fixture();
    pending.deliverables[0].status = "pending";
    assert.notEqual(await structuredAcceptanceReason(pending, gate, resolve), null);
    const gap = fixture();
    gap.deliverables[0].gaps = ["Synthetic required check is unresolved"];
    assert.notEqual(await structuredAcceptanceReason(gap, gate, resolve), null);
  }
});

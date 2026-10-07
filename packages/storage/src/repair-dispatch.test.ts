import assert from "node:assert/strict";
import test from "node:test";
import { repairEvidenceChanged, repairFingerprint } from "./repair-dispatch.js";

test("failure fingerprint ignores run identity and whitespace, not changed diagnosis", () => {
  assert.equal(repairFingerprint("Build product", "Missing source for 00000000-0000-4000-8000-000000000001"),
    repairFingerprint("Build  product", "Missing source for 00000000-0000-4000-8000-000000000002"));
  assert.notEqual(repairFingerprint("Build product", "Missing source"), repairFingerprint("Build product", "Failed test"));
});

test("unchanged or removed evidence cannot rearm repair; new validated evidence can", () => {
  assert.equal(repairEvidenceChanged(null, []), true);
  assert.equal(repairEvidenceChanged([], []), false);
  assert.equal(repairEvidenceChanged(["fix-a"], ["fix-a"]), false);
  assert.equal(repairEvidenceChanged(["fix-a"], []), false);
  assert.equal(repairEvidenceChanged(["fix-a"], ["fix-a", "fix-b"]), true);
});

test("successful-looking counters without governed checks cannot rearm repair", async () => {
  const { validatedRepairEvidence } = await import("./repair-dispatch.js");
  const client = { query: async (sql: string) => {
    if (sql.includes("kind='direct_repair_validation'")) return { rows: [{ id: "synthetic-report", content: { validation: { failed: 0, passed: 100 } } }] };
    assert.ok(sql.includes("from workflow_runs where"));
    return { rows: [{ projectId: "synthetic-project", task: "Synthetic repair", metadata: {} }] };
  } } as unknown as Parameters<typeof validatedRepairEvidence>[0];
  const evidence = await validatedRepairEvidence(client, "synthetic-run");
  assert.deepEqual(evidence, []);
  assert.equal(repairEvidenceChanged([], evidence), false);
});

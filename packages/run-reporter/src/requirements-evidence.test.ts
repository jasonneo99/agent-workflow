import assert from "node:assert/strict";
import test from "node:test";
import { buildRunExport, type RunExportInput } from "./index.js";

const fixture = {
  run: { id: "synthetic-run", task: "Synthetic original acceptance requirement",
    projectName: "Example", projectRootUri: "/synthetic/project", status: "failed" },
  tasks: [], receipts: [], artifacts: []
} as unknown as RunExportInput;

test("sharing exports remain redacted and explicitly reject requirements reconciliation", () => {
  const result = buildRunExport({ ...fixture, scrub: true });
  assert.equal(result.json.requirementsEvidence, "incomplete-redacted");
  assert.equal((result.json.run as { task: string }).task, "[REDACTED_TASK]");
  assert.match(result.markdown, /INCOMPLETE requirements evidence/);
  assert.match(JSON.stringify(result.json.redactionNotes), /--requirements-only/);
  assert.match(JSON.stringify(result.json.redactionNotes), /Re-reading this export cannot recover/);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic original acceptance requirement/);
});

test("local exports retain requirements but identify themselves as snapshots", () => {
  const result = buildRunExport(fixture);
  assert.equal(result.json.requirementsEvidence, "export-snapshot");
  assert.equal((result.json.run as { task: string }).task, fixture.run.task);
});

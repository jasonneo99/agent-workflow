import test from "node:test";
import assert from "node:assert/strict";
import { findRecentDuplicateRun, type RunDeduplicationContract } from "./run-deduplication.js";

const contract: RunDeduplicationContract = {
  projectId: "project-1",
  workflowId: "build-feature",
  task: "  Build a feature  ",
  autonomy: "3",
  policyProfile: "local",
  policySnapshotHash: "policy-hash",
  modelTierOverride: "standard",
  providerOverride: "example",
  workflowVersion: "1",
  workflowHash: "workflow-hash",
  evaluationMetadataJson: "{}",
  constructionRationaleJson: "{}",
  compiledBriefJson: JSON.stringify({ text: "brief", metadata: {} })
};

test("run deduplication binds the advisory lock and query to the complete execution contract", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return calls.length === 1 ? { rows: [] } : { rows: [{ id: "run-1", tasks: 3 }] };
    }
  };
  const duplicate = await findRecentDuplicateRun(client as never, contract);
  assert.deepEqual(duplicate, { id: "run-1", tasks: 3 });
  assert.equal(calls[1]?.values.length, 13);
  assert.equal(calls[1]?.values[2], "Build a feature");
  assert.match(calls[1]?.text ?? "", /policy_snapshot_hash = \$6/);
  assert.match(calls[1]?.text ?? "", /workflow_definition_hash = \$10/);
  assert.match(calls[1]?.text ?? "", /a\.content = \$13::jsonb/);
  assert.match(calls[1]?.text ?? "", /wr\.status in \('queued', 'leased', 'running', 'blocked', 'failed'\)/);
  assert.deepEqual(JSON.parse(String(calls[1]?.values[12])), { text: "brief", metadata: {} });
  assert.match(String(calls[0]?.values[0]), /policy-hash/);
});

test("run deduplication keeps explicit retries separate from ordinary duplicate submissions", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  await findRecentDuplicateRun(client as never, contract);

  assert.match(calls[1]?.text ?? "", /wr\.status in \('queued', 'leased', 'running', 'blocked', 'failed'\)/);
  assert.doesNotMatch(calls[1]?.text ?? "", /replayOfRunId/);
});

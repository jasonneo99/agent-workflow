/** Live acceptance: verifies task continuation restores correctly in a fresh worker process.
 * Run via: node --import tsx --test scripts/continuation-worker-fixture.ts
 * Requires DATABASE_URL pointing at a disposable test database (set by parent harness).
 * The parent harness checkpoints before spawning this fixture as a separate process;
 * this verifies the restore works cross-process. Prints CONTINUATION_LIVE_ACCEPTANCE_PASSED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getArtifactByUri } from "../packages/storage/src/postgres.js";

const taskId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000001";

test("continuation restores in fresh worker process", async () => {
  // This test file runs as a separate OS process from the parent harness
  // (spawned via node --test), proving cross-process restore works.
  const restored = await getArtifactByUri(
    "db://workflow_tasks/" + taskId + "/continuation"
  );
  assert.ok(restored, "Continuation artifact not found in fresh process");
  assert.equal(restored.runId, runId);
  assert.equal(restored.taskId, taskId);
  // Parent harness checkpoints with round: 1
  assert.equal(restored.content.round, 1);
  assert.equal(restored.content.version, 1);
  console.log("CONTINUATION_LIVE_ACCEPTANCE_PASSED");
});

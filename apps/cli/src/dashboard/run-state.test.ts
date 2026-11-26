import assert from "node:assert/strict";
import test from "node:test";
import { runRollupState, runStateCounts } from "./run-state.js";

test("blocked runs are their own state, never active", () => {
  assert.equal(runRollupState("blocked"), "blocked");
  for (const status of ["queued", "leased", "running"]) assert.equal(runRollupState(status), "active");
  assert.equal(runRollupState("cancelled"), "other");
});

test("state counts split blocked from active and failed", () => {
  const runs = ["completed", "completed", "failed", "blocked", "queued", "running", "cancelled"].map(status => ({ status }));
  assert.deepEqual(runStateCounts(runs), { completed: 2, failed: 1, blocked: 1, active: 2, other: 1 });
});

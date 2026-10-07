import assert from "node:assert/strict";
import test from "node:test";
import { recordedLifecycleActions, recordedLifecycleEvent, replayRecordedLifecycleEvents } from "./recorded-lifecycle.js";

test("only domain receipts become events and internal metadata is not exported", () => {
  const base = { runId: "synthetic", target: "subject", summary: "State changed", receiptHash: "hash", createdAt: "2026-01-01T00:00:00.000Z" };
  for (const actionType of recordedLifecycleActions) {
    const event = recordedLifecycleEvent({ ...base, actionType });
    assert.ok(event);
    assert.equal(event.authority, "evidence-only");
    assert.equal(event.id, base.receiptHash);
    assert.equal("metadata" in event, false);
  }
  assert.equal(recordedLifecycleEvent({ ...base, actionType: "worker_heartbeat" }), null);
});

test("invalid stream cursors and scopes reject before querying", async () => {
  const base = { projectRootUri: "/synthetic", runId: "123e4567-e89b-42d3-a456-426614174000" };
  for (const after of ["", "now", "2026-01-01", "\nevent: injected"]) await assert.rejects(replayRecordedLifecycleEvents({ ...base, after }), /Invalid/u);
  await assert.rejects(replayRecordedLifecycleEvents({ ...base, limit: 101 }), /Invalid/u);
  await assert.rejects(replayRecordedLifecycleEvents({ ...base, projectRootUri: "" }), /Invalid/u);
});

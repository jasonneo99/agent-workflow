import assert from "node:assert/strict";
import test from "node:test";
import { appendTuningApprovalHistory, formatTuningApprovalHistory } from "./index.js";

test("tuning history preserves every proposal lifecycle transition", () => {
  const queued = appendTuningApprovalHistory(undefined, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "queued",
    occurredAt: "2026-08-17T10:00:00.000Z"
  });
  const approved = appendTuningApprovalHistory(queued, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "approved",
    actor: "reviewer",
    occurredAt: "2026-08-17T10:01:00.000Z"
  });
  const reverted = appendTuningApprovalHistory(approved, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "reverted",
    note: "quality regression",
    occurredAt: "2026-08-17T10:02:00.000Z"
  });

  assert.deepEqual(reverted.events.map((event) => event.status), ["queued", "approved", "reverted"]);
  assert.match(formatTuningApprovalHistory(reverted), /reverted=1/);
  assert.match(formatTuningApprovalHistory(reverted), /quality regression/);
});

test("tuning history records a superseding proposal relation", () => {
  const history = appendTuningApprovalHistory(undefined, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "superseded",
    relatedProposalId: "tune-004",
    occurredAt: "2026-08-17T10:03:00.000Z"
  });
  assert.equal(history.events[0]?.relatedProposalId, "tune-004");
});

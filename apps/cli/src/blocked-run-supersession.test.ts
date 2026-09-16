import assert from "node:assert/strict";
import test from "node:test";
import { findLaterCompletedEquivalentRun } from "./blocked-run-supersession.js";

test("a later successful equivalent run supersedes a blocked run", () => {
  const blocked = { id: "blocked", workflowId: "review-pr", task: "Review this change", status: "blocked", startedAt: "2026-09-16T10:00:00Z" };
  const completed = { id: "completed", workflowId: "review-pr", task: "Review this change", status: "completed", startedAt: "2026-09-16T10:05:00Z" };
  assert.equal(findLaterCompletedEquivalentRun([completed, blocked], blocked)?.id, "completed");
});

test("different, earlier, and unfinished runs do not supersede a blocker", () => {
  const blocked = { id: "blocked", workflowId: "review-pr", task: "Review this change", status: "blocked", startedAt: "2026-09-16T10:00:00Z" };
  const runs = [
    { id: "earlier", workflowId: "review-pr", task: "Review this change", status: "completed", startedAt: "2026-09-16T09:00:00Z" },
    { id: "different", workflowId: "review-pr", task: "Review another change", status: "completed", startedAt: "2026-09-16T11:00:00Z" },
    { id: "running", workflowId: "review-pr", task: "Review this change", status: "running", startedAt: "2026-09-16T11:00:00Z" }
  ];
  assert.equal(findLaterCompletedEquivalentRun(runs, blocked), null);
});

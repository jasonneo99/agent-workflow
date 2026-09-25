import assert from "node:assert/strict";
import test from "node:test";
import { buildHumanInterventionItems } from "./human-intervention.js";

test("home intervention work includes decisions, execution, blocked, failed, stale, and runtime items", () => {
  const items = buildHumanInterventionItems({
    pendingApprovals: [{ id: "a", status: "pending", actionType: "file_write", target: "src/a.ts" }],
    approvedExecutableApprovals: [{ id: "b", status: "approved", actionType: "local_command", target: "npm test" }],
    queue: [
      { runId: "blocked", runStatus: "blocked", task: "blocked task", blockedReason: "human decision required" },
      { runId: "failed", runStatus: "failed", task: "failed task", failedReason: "verification failed" },
      { runId: "stale", runStatus: "running", task: "stale task", runningLeaseExpiresAt: "2026-09-25T11:00:00.000Z" }
    ],
    workerStatus: "stale", supervisorStatus: "running", mcpStatus: "error", missingServices: ["Redis"], learningDaemonError: "tick failed", approvalBacklogErrors: 1, approvalBacklogWarnings: 2, now: new Date("2026-09-25T12:00:00.000Z")
  });
  assert.deepEqual(new Set(items.map((item) => item.kind)), new Set(["approval", "execution", "blocked-run", "failed-run", "expired-lease", "runtime"]));
  assert.equal(items.length, 10);
  assert.ok(items.every((item) => item.href && item.action));
});

test("healthy home state has no human intervention work", () => {
  assert.deepEqual(buildHumanInterventionItems({ pendingApprovals: [], approvedExecutableApprovals: [], queue: [], workerStatus: "running", supervisorStatus: "running", mcpStatus: "ok", missingServices: [] }), []);
});

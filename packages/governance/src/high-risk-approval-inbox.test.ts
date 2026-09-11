import assert from "node:assert/strict";
import test from "node:test";
import { buildHighRiskApprovalInbox, redactApprovalCardText } from "./high-risk-approval-inbox.js";

test("redacts credentials and host paths from approval cards", () => {
  const value = redactApprovalCardText(
    "deploy /Users/jason/private token=abc123 Authorization Bearer xyz.123",
    240
  );
  assert.equal(value.includes("jason"), false);
  assert.equal(value.includes("abc123"), false);
  assert.equal(value.includes("xyz.123"), false);
  assert.match(value, /\[HOST_PATH\]/u);
  assert.match(value, /token=\[REDACTED\]/u);
});

test("builds a bounded immutable read-only contract", () => {
  const item = {
    approvalId: "approval-1", projectId: "project-1", projectName: "fleet-config",
    workflowId: "build-feature", runId: "run-1", approvalStatus: "pending",
    actionType: "deployment", target: "deploy canary", rationale: "manual review",
    risk: "high" as const, riskReasons: ["deployment requires review"],
    requestedAt: "2026-09-11T00:00:00.000Z", dashboardPath: "/approvals?status=open&run=run-1"
  };
  const report = buildHighRiskApprovalInbox({ generatedAt: "2026-09-11T00:00:00.000Z", scanned: 30, open: 30, items: Array.from({ length: 30 }, () => item) });
  assert.equal(report.kind, "agentflow_server_high_risk_approval_inbox");
  assert.equal(report.readOnly, true);
  assert.equal(report.items.length, 25);
  assert.equal(report.highRisk, 25);
  assert.equal("execute" in report, false);
});

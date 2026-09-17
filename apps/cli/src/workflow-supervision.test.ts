import assert from "node:assert/strict";
import test from "node:test";
import { findSupersedingDeliveryReceipt, isWithinAutomaticWorkflowRepairWindow, workflowDeliveryRepairReason } from "./workflow-supervision.js";

const run = { workflowId: "build-feature", task: "Build and deliver a fan module", status: "completed" };

test("completed delivery without product writes is automatically repairable", () => {
  assert.match(workflowDeliveryRepairReason(run, [{ stageId: "implement", agentId: "implementation-agent", summary: "Read-only discovery complete." }]) ?? "", /without governed product-write evidence/iu);
});

test("completed delivery without executed verification is automatically repairable", () => {
  const reason = workflowDeliveryRepairReason(run, [
    { stageId: "implement", agentId: "implementation-agent", artifact: { requestedFileWrites: [{ path: "src/fan.ts" }] } },
    { stageId: "verify", agentId: "auto-test-runner", summary: "No tests were run." }
  ]);
  assert.match(reason ?? "", /without executed verification evidence/iu);
});

test("delivery with governed writes and executed verification needs no repair", () => {
  const reason = workflowDeliveryRepairReason(run, [
    { stageId: "implement", agentId: "implementation-agent", artifact: { requestedFileWrites: [{ path: "src/fan.ts" }] } },
    { stageId: "verify", agentId: "auto-test-runner", artifact: { requestedCommands: ["npm test"], actionResults: [{ status: "completed" }] } }
  ]);
  assert.equal(reason, null);
});

test("blocked authority and policy mismatch is routed to repair", () => {
  assert.match(workflowDeliveryRepairReason({ ...run, status: "blocked" }, [{ stageId: "implement", summary: "Implementation remains blocked by scoped authority; no product files changed." }]) ?? "", /queue a governed repair/iu);
});

test("repair runs do not recursively repair themselves", () => {
  assert.equal(workflowDeliveryRepairReason({ ...run, evaluationMetadata: { source: "workflow-supervisor-repair" } }, []), null);
});

test("ordinary completed maintenance does not inherit the strict build delivery contract", () => {
  assert.equal(workflowDeliveryRepairReason({ workflowId: "maintain-context", task: "Fix stale context metadata", status: "completed" }, []), null);
});

test("auxiliary workflows do not inherit delivery supervision from the original task text", () => {
  const task = "Build a local project map and implement typed memory records";
  assert.equal(workflowDeliveryRepairReason({ workflowId: "maintain-context", task, status: "completed" }, []), null);
  assert.equal(workflowDeliveryRepairReason({ workflowId: "review-pr", task, status: "completed" }, []), null);
});

test("installed fan delivery receipt supersedes an older blocked build", () => {
  const receipt = findSupersedingDeliveryReceipt("BUILD and DELIVER the installable desktop fan telemetry collector package", [{
    path: ".agent-workflow/receipts/fan-telemetry-delivery.md",
    content: "# Fan telemetry delivery\nProduct: installable desktop fan telemetry collector package\n## Completed\nCollector and package delivered.\n## Verification\n87 tests passed.\n## Installed verification\nService installed."
  }]);
  assert.equal(receipt?.path, ".agent-workflow/receipts/fan-telemetry-delivery.md");
});

test("source review id links a completion receipt to a long delivery task", () => {
  const source = "587f9c78-cc72-40c4-943c-0e2547be5a89";
  const receipt = findSupersedingDeliveryReceipt(`Implement five P1 findings from UX review ${source}`, [{
    path: ".agent-workflow/receipts/2026-09-16-p1-ux-remediation-complete.md",
    content: `# P1 UX remediation completion receipt\nSource review: ${source}\n## Completed\nAll five fixes completed.\n## Verification\nWeb, Flutter, and macOS tests passed.`
  }]);
  assert.ok(receipt);
});

test("plans and inspection-only receipts cannot suppress a required repair", () => {
  assert.equal(findSupersedingDeliveryReceipt("Build and deliver fan telemetry", [
    { path: "fan-telemetry-plan.md", content: "# Plan\n## Verification\nNo tests were run and no files were changed." },
    { path: "fan-telemetry-inspection.md", content: "# Inspection complete\nNo implementation occurred." }
  ]), null);
});

test("generic completion receipts cannot suppress unrelated delivery work", () => {
  assert.equal(findSupersedingDeliveryReceipt("Build and deliver the recruiting application login interface", [{
    path: ".agent-workflow/receipts/milestone-release-complete.md",
    content: "# Milestone release\n## Completed\nThe project milestone was delivered.\n## Verification\nRelease checks passed and the package was verified."
  }]), null);
});

test("automatic repair only covers newly finished runs", () => {
  const now = Date.parse("2026-09-16T20:00:00.000Z");
  assert.equal(isWithinAutomaticWorkflowRepairWindow("2026-09-16T19:45:00.000Z", now), true);
  assert.equal(isWithinAutomaticWorkflowRepairWindow("2026-09-16T19:29:59.000Z", now), false);
  assert.equal(isWithinAutomaticWorkflowRepairWindow("not-a-date", now), false);
});

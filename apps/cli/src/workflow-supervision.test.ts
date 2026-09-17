import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findSupersedingDeliveryReceipt, isWithinAutomaticWorkflowRepairWindow, supervisedRepairWorkflowId, workflowDeliveryRepairReason, workflowRepairLesson, workflowRootRepairAction } from "./workflow-supervision.js";

const run = { workflowId: "build-feature", task: "Build and deliver a fan module", status: "completed" };
const cliSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("queueing hydrates an empty project index before compiling evidence", () => {
  assert.match(cliSource, /if \(sourceSummaries\.length === 0\)[\s\S]+indexProjectForRun[\s\S]+sourceSummaries = await loadSourceSummaries/u);
});

test("learning daemon replays review evidence gaps with explicit root-repair lineage", () => {
  assert.match(cliSource, /workflowRootRepairAction\([\s\S]+rootRepairAction === "replay-original"/u);
  assert.match(cliSource, /evaluationMetadataPatch:[\s\S]+source: "workflow-root-repair"[\s\S]+rootRepairKind: "review-evidence-gap"/u);
  assert.match(cliSource, /workflow_root_repair_replayed/u);
});

test("learning daemon health-gates one replay after a typed provider outage", () => {
  assert.match(cliSource, /transientProviderOutage[\s\S]+providerFromEnv\(run\.providerOverride \?\? undefined\)[\s\S]+provider\.check[\s\S]+rootRepairKind: "provider-recovered"[\s\S]+workflow_provider_recovery_replayed/u);
});

test("learning daemon closes every terminal repair with a reusable local lesson", () => {
  assert.match(cliSource, /learnFromWorkflowRepairs\(recoveryTarget\.projectDir\)[\s\S]+autoRepairOneWorkflowRun/u);
  assert.match(cliSource, /actionType: "workflow_repair_learning"/u);
  assert.match(cliSource, /sourceUri: `agentflow:\/\/repair-learning\/\$\{run\.id\}`/u);
  assert.match(cliSource, /workflowRepairLesson\(\{ strategy, repairStatus: run\.status, completedTasks, failedTasks \}\)/u);
});

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

test("delivery-gap repairs route to build-feature while concrete failures stay diagnostic", () => {
  assert.equal(supervisedRepairWorkflowId(
    { workflowId: "debug-failure", task: "Finish and implement roadmap milestone 7", status: "blocked" },
    "Delivery run stopped before implementation or verification; queue a governed repair within the existing project policy."
  ), "build-feature");
  assert.equal(supervisedRepairWorkflowId(
    { workflowId: "debug-failure", task: "Fix the TypeError in the queue worker", status: "failed" },
    "The test command failed with a reproducible exception."
  ), "debug-failure");
});

test("root repair playbook distinguishes review evidence, delivery, approvals, and providers", () => {
  const review = { workflowId: "review-pr", task: "Review recovery UX", status: "blocked" };
  assert.equal(workflowRootRepairAction({ run: review, reason: "Missing implementation evidence for recovery." }), "replay-original");
  assert.equal(workflowRootRepairAction({ run: review, reason: "Required actions are awaiting approval.", hasOpenApproval: true }), "wait-approval");
  assert.equal(workflowRootRepairAction({ run: review, reason: "Codex provider outage after fallback failed." }), "operator-provider");
  assert.equal(workflowRootRepairAction({
    run: { workflowId: "debug-failure", task: "Implement milestone 7", status: "blocked" },
    reason: "No product write was recorded.",
    deliveryReason: "Delivery run stopped before implementation or verification."
  }), "build-feature");
  assert.equal(workflowRootRepairAction({
    run: { workflowId: "debug-failure", task: "Fix queue crash", status: "failed" },
    reason: "Queue crashed.",
    recordedFailure: "TypeError in queue worker"
  }), "debug-failure");
});

test("repair outcomes reinforce successful strategies and avoid failed ones", () => {
  assert.deepEqual(workflowRepairLesson({ strategy: "replay-original", repairStatus: "completed", completedTasks: 3, failedTasks: 0 }), {
    outcome: "reinforce",
    futureAction: "Reuse replay-original for the same root-cause class when policy and evidence still match.",
    confidence: 0.9
  });
  assert.equal(workflowRepairLesson({ strategy: "debug-failure", repairStatus: "blocked", completedTasks: 0, failedTasks: 1 }).outcome, "avoid");
  assert.equal(workflowRepairLesson({ strategy: "build-feature", repairStatus: "running", completedTasks: 1, failedTasks: 0 }).outcome, "observe");
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

test("automatic repair diagnoses bounded internal failures while retaining provider prerequisite classification", () => {
  assert.match(cliSource, /const recordedFailure = \[\.\.\.details\.receipts\]/u);
  assert.match(cliSource, /const externallyManagedFailure = \/\\b\(\?:auth/u);
  assert.match(cliSource, /const repairableFailure = run\.status === "failed"/u);
  assert.match(cliSource, /The failed stage recorded this cause/u);
});

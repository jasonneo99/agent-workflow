import assert from "node:assert/strict";
import test from "node:test";
import { actionIdempotencyKey, applyCurrentAutoApprovalThreshold, buildBoundedReactLoopReceiptContent, commandFailureIsDiagnosticEvidence, commandFailurePrecedesGovernedWrites, isInternalWorkflowReceiptWrite, shouldContinuePlanningDeliverableGap, shouldRetryWeakFallbackBlock } from "./executor.js";
import { runExecutorApprovalGate } from "./executor.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { readFileSync } from "node:fs";

test("active workers adopt only the current project auto-approval threshold", () => {
  const snapshot = projectConfigSchema.parse({ project: { name: "snapshot", autonomy: 2 }, actions: { auto_approve_max_risk: "none", allowed_write_paths: ["docs/**"] } });
  const current = projectConfigSchema.parse({ project: { name: "current", autonomy: 3 }, actions: { auto_approve_max_risk: "medium", allowed_write_paths: ["src/**"] } });
  const effective = applyCurrentAutoApprovalThreshold(snapshot, current, {});
  assert.equal(effective.actions.auto_approve_max_risk, "medium");
  assert.deepEqual(effective.actions.allowed_write_paths, ["docs/**"]);
  assert.equal(effective.project.autonomy, 2);
});

test("supervised worker approval autopilot applies before the first action blocks", () => {
  const snapshot = projectConfigSchema.parse({ project: { name: "snapshot", autonomy: 2 }, actions: { auto_approve_max_risk: "none" } });
  const current = projectConfigSchema.parse({ project: { name: "current", autonomy: 2 }, actions: { auto_approve_max_risk: "none" } });
  const effective = applyCurrentAutoApprovalThreshold(snapshot, current, {
    AGENTFLOW_APPROVAL_AUTOPILOT: "on",
    AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK: "medium"
  });
  assert.equal(effective.actions.auto_approve_max_risk, "medium");
});

test("explicitly disabled worker approval autopilot overrides a project threshold", () => {
  const snapshot = projectConfigSchema.parse({ project: { name: "snapshot", autonomy: 2 }, actions: { auto_approve_max_risk: "medium" } });
  const current = projectConfigSchema.parse({ project: { name: "current", autonomy: 2 }, actions: { auto_approve_max_risk: "medium" } });
  const effective = applyCurrentAutoApprovalThreshold(snapshot, current, {
    AGENTFLOW_APPROVAL_AUTOPILOT: "off",
    AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK: "medium"
  });
  assert.equal(effective.actions.auto_approve_max_risk, "none");
});

test("workers recover expired leases before claiming new work", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /runWorkerOnce[\s\S]+requeueExpiredWorkflowTaskLeases[\s\S]+claimNextWorkflowTask/u);
  assert.match(source, /projectRootUri: options\?\.projectRootUri/u);
  assert.match(source, /recoverExpiredLeases: false/u);
});

test("workers serialize only writes to the same project-relative file resource", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /withProjectExecutionLock\([\s\S]+resource: `file:\$\{fileWrite\.path\.replace/u);
  assert.match(source, /commandSerializationResource\(commandLine, localProjectRootUri\)/u);
});

test("worker provider capabilities flow into durable queue claims", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /providerIds\?: string\[\]/u);
  assert.match(source, /defaultProviderId\?: string/u);
  assert.match(source, /workerPlatform\?: NodeJS\.Platform/u);
  assert.match(source, /claimNextWorkflowTask\(\{[\s\S]+excludedProjectRootUris/u);
  assert.match(source, /providerIds: providerIds \? \[\.\.\.providerIds\] : undefined/u);
  assert.match(source, /options\.providerIds\.splice\([\s\S]+providerId !== attemptedProviderId/u);
  assert.match(source, /providerIds\.delete\(failure\.providerId\)[\s\S]+quarantinedProviders\.set/u);
  assert.match(source, /recoverProvider\(providerId\)[\s\S]+providerIds\.add\(providerId\)/u);
});

test("workers release tasks for unavailable host checkouts and stop reclaiming them", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /projectResolution\.localPathExists[\s\S]+unavailableProjectRootUris\?\.add[\s\S]+requeueRunningWorkflowTasks[\s\S]+worker_project_unavailable/u);
  assert.match(source, /const unavailableProjectRootUris = new Set<string>\(\)[\s\S]+unavailableProjectRootUris/u);
});

test("diagnostic stages retain failing commands as evidence while execution gates fail closed", () => {
  assert.equal(commandFailureIsDiagnosticEvidence({ type: "planner" }), true);
  assert.equal(commandFailureIsDiagnosticEvidence({ type: "react" }), true);
  assert.equal(commandFailureIsDiagnosticEvidence({ type: "executor" }), false);
  assert.equal(commandFailureIsDiagnosticEvidence({ type: "verifier" }), false);
});

test("executor baseline failures may precede governed writes but not empty implementations", () => {
  assert.equal(commandFailurePrecedesGovernedWrites({ type: "executor" }, { requestedFileWrites: [{ path: "src/fix.ts", content: "fixed\n" }] }), true);
  assert.equal(commandFailurePrecedesGovernedWrites({ type: "executor" }, { requestedFileWrites: [] }), false);
  assert.equal(commandFailurePrecedesGovernedWrites({ type: "verifier" }, { requestedFileWrites: [{ path: "src/fix.ts", content: "fixed\n" }] }), false);
});

test("action idempotency keys are stable for the same normalized action", () => {
  const base = {
    taskId: "task-1",
    stageId: "verify",
    agentId: "test-engineer",
    actionType: "local_command",
    target: "npm   test",
    payload: "npm   test",
    normalizePayload: true
  };

  assert.equal(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, target: "npm test", payload: "npm test" })
  );
});

test("action idempotency keys change when the payload changes", () => {
  const base = {
    taskId: "task-1",
    stageId: "document",
    agentId: "docs-maintainer",
    actionType: "file_write",
    target: ".agent-workflow/notes/summary.md",
    payload: "first version"
  };

  assert.notEqual(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, payload: "second version" })
  );
});

test("weak local fallback blockers require one primary-provider retry", () => {
  assert.equal(shouldRetryWeakFallbackBlock({
    fallbackUsed: true,
    actualProviderId: "local",
    output: { outcome: "blocked", blockedReason: "Missing project context and working tree details.", summary: "Cannot continue.", artifact: {} },
    qualityReasons: ["no concrete findings"]
  }), true);
  assert.equal(shouldRetryWeakFallbackBlock({
    fallbackUsed: false,
    actualProviderId: "codex-cli",
    output: { outcome: "blocked", blockedReason: "Deployment approval is required.", summary: "Await approval.", artifact: {} },
    qualityReasons: []
  }), false);
  assert.equal(shouldRetryWeakFallbackBlock({
    fallbackUsed: true,
    actualProviderId: "local",
    output: { outcome: "completed", summary: "Review completed with concrete evidence.", artifact: {} },
    qualityReasons: []
  }), false);
});

test("planning stages treat missing requested deliverables as implementation scope", () => {
  assert.equal(shouldContinuePlanningDeliverableGap({
    stageId: "orient",
    output: { outcome: "blocked", blockedReason: "Missing project map and memory records", summary: "The requested architecture details are not present.", artifact: {} }
  }), true);
  assert.equal(shouldContinuePlanningDeliverableGap({
    stageId: "plan",
    output: { outcome: "blocked", blockedReason: "Deployment approval is required", summary: "Waiting for approval.", artifact: {} }
  }), false);
  assert.equal(shouldContinuePlanningDeliverableGap({
    stageId: "implement",
    output: { outcome: "blocked", blockedReason: "Missing implementation", summary: "No product files exist.", artifact: {} }
  }), false);
});

test("only bounded internal receipt files bypass external-action approval", () => {
  assert.equal(isInternalWorkflowReceiptWrite(".agent-workflow/receipts/run.md"), true);
  assert.equal(isInternalWorkflowReceiptWrite("./.agent-workflow/receipts/run.json"), true);
  assert.equal(isInternalWorkflowReceiptWrite(".agent-workflow/receipts/../project.yaml"), false);
  assert.equal(isInternalWorkflowReceiptWrite(".agent-workflow/tuning/agent-notes.md"), false);
  assert.equal(isInternalWorkflowReceiptWrite("src/index.ts"), false);
});

test("bounded ReAct loop receipts capture action, policy, result, and stop reason", () => {
  const receipt = buildBoundedReactLoopReceiptContent({
    task: {
      runId: "run-1",
      taskId: "task-1",
      workflowId: "debug-failure",
      workflowTask: "Fix a failed test.",
      stageId: "reproduce",
      stageGoal: "Reproduce the failure.",
      agentId: "ci-debugger"
    },
    stagePattern: {
      type: "react",
      maxIterations: 3,
      requiresVerifier: true,
      promotionGate: "evaluation",
      stopConditions: ["test reproduced", "max iterations reached"]
    },
    iteration: 2,
    totalRequestedActions: 2,
    actionType: "local_command",
    target: "npm test",
    payloadHash: "hash-1",
    policyDecision: {
      status: "allowed",
      approvalRequired: false,
      allowedByPolicy: true
    },
    resultReceipt: {
      status: "completed",
      exitCode: 0,
      artifactUri: "db://artifacts/1"
    }
  });

  assert.equal(receipt.kind, "agentflow_bounded_react_loop_receipt");
  assert.equal(receipt.workflowId, "debug-failure");
  assert.equal(receipt.stageId, "reproduce");
  assert.equal(receipt.iteration, 2);
  assert.equal(receipt.maxIterations, 3);
  assert.equal(receipt.overBudget, false);
  assert.equal(receipt.stopReason, "provider_returned_no_more_actions");
  assert.deepEqual(receipt.actionRequested, {
    type: "local_command",
    target: "npm test",
    payloadHash: "hash-1"
  });
  assert.deepEqual(receipt.policyDecision, {
    status: "allowed",
    approvalRequired: false,
    allowedByPolicy: true
  });
  assert.deepEqual(receipt.resultReceipt, {
    status: "completed",
    exitCode: 0,
    artifactUri: "db://artifacts/1"
  });
});

test("bounded ReAct loop receipts mark actions beyond max iterations", () => {
  const receipt = buildBoundedReactLoopReceiptContent({
    task: {
      runId: "run-1",
      taskId: "task-1",
      workflowId: "wide-open-automation",
      workflowTask: "Run trusted automation.",
      stageId: "execute",
      stageGoal: "Complete the configured task.",
      agentId: "auto-wide-open-executor"
    },
    stagePattern: {
      type: "react",
      maxIterations: 1,
      requiresVerifier: true,
      promotionGate: "policy",
      stopConditions: []
    },
    iteration: 2,
    totalRequestedActions: 2,
    actionType: "file_write",
    target: ".agent-workflow/notes/result.md",
    payloadHash: "hash-2",
    policyDecision: {
      status: "auto_approved_by_rule"
    },
    resultReceipt: {
      status: "completed"
    }
  });

  assert.equal(receipt.overBudget, true);
  assert.equal(receipt.stopReason, "max_iterations_exceeded");
});

const executorTarget = `ssh-exact-revision/typecheck@sharedHost#${"a".repeat(40)}:/registered/root`;

function approvalProject(withRule = false) {
  return projectConfigSchema.parse({
    project: { name: "agent-workflow" },
    policies: { require_approval_for_external_actions: true },
    actions: { approval_rules: withRule ? [{ id: "exact-remote", action_type: "executor_adapter", target: executorTarget, effect: "auto_execute" }] : [] }
  });
}

test("pending executor approval prevents remote execution", async () => {
  let executions = 0;
  const result = await runExecutorApprovalGate({ project: approvalProject(), target: executorTarget, approved: false, execute: async () => ++executions });
  assert.equal(result.status, "pending");
  assert.equal(executions, 0);
});

test("approved executor approval executes once", async () => {
  let executions = 0;
  const result = await runExecutorApprovalGate({ project: approvalProject(), target: executorTarget, approved: true, execute: async () => ++executions });
  assert.equal(result.status, "executed");
  assert.equal(executions, 1);
});

test("narrow recurring executor rule executes only its exact target", async () => {
  let executions = 0;
  const project = approvalProject(true);
  const exact = await runExecutorApprovalGate({ project, target: executorTarget, approved: false, execute: async () => ++executions });
  const different = await runExecutorApprovalGate({ project, target: executorTarget.replace("typecheck", "test"), approved: false, execute: async () => ++executions });
  assert.equal(exact.status, "executed");
  assert.equal(different.status, "pending");
  assert.equal(executions, 1);
});

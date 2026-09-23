import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_FAILURE_ERROR_OUTPUT_MAX_CHARS,
  COMMAND_FAILURE_ERROR_OUTPUT_MAX_LINES,
  VERIFY_COMMAND_RETRY_BUDGET_DEFAULT,
  VERIFY_COMMAND_RETRY_BUDGET_MAX,
  actionIdempotencyKey,
  applyCurrentAutoApprovalThreshold,
  attributeVerifyFailure,
  buildBoundedReactLoopReceiptContent,
  commandFailureEligibleForVerifyRetry,
  commandFailureIsDiagnosticEvidence,
  commandFailurePrecedesGovernedWrites,
  diffGitFootprint,
  extractVerifyFailureFiles,
  formatCommandFailureEvidence,
  isInternalWorkflowReceiptWrite,
  npmPreflightDiagnostic,
  parseGitStatusPorcelain,
  shouldContinuePlanningDeliverableGap,
  shouldRetryWeakFallbackBlock,
  snapshotGitStatus,
  truncateCommandOutputForError,
  verifyRetryBudgetFromEnv
} from "./executor.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("stopping workers do not claim the remainder of an active batch", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /for \(let i = 0; i < safeLimit; i \+= 1\) \{\s+if \(options\?\.shouldStop\?\.\(\)\) break;\s+const task = await claimNextWorkflowTask/u);
  assert.match(source, /shouldStop: input\.shouldStop/u);
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

test("command output truncation caps lines and chars for error paths", () => {
  const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const truncated = truncateCommandOutputForError(manyLines);
  assert.equal(truncated.split("\n").length, COMMAND_FAILURE_ERROR_OUTPUT_MAX_LINES + 1);
  assert.match(truncated, /showing first 20 of 50 lines/);
  assert.equal(truncateCommandOutputForError("a\nb"), "a\nb");
  const longLine = "x".repeat(COMMAND_FAILURE_ERROR_OUTPUT_MAX_CHARS + 100);
  const charTruncated = truncateCommandOutputForError(longLine);
  assert.ok(charTruncated.length < COMMAND_FAILURE_ERROR_OUTPUT_MAX_CHARS + 100);
  assert.match(charTruncated, /showing first 4000 chars/);
});

test("command failure evidence is self-diagnosing", () => {
  const evidence = formatCommandFailureEvidence({
    commandLine: "npm run typecheck",
    exitCode: 2,
    timedOut: false,
    stdout: "",
    stderr: "error TS2835: Relative import paths need explicit file extensions"
  });
  assert.match(evidence, /npm run typecheck/);
  assert.match(evidence, /exited with code 2/);
  assert.match(evidence, /TS2835/);
  const empty = formatCommandFailureEvidence({
    commandLine: "npm test",
    exitCode: 1,
    timedOut: false,
    stdout: "  ",
    stderr: ""
  });
  assert.match(empty, /produced no output/);
  const timedOut = formatCommandFailureEvidence({
    commandLine: "sleep 999",
    exitCode: null,
    timedOut: true,
    stdout: "",
    stderr: ""
  });
  assert.match(timedOut, /timed out/);
});

test("verify retry eligibility covers test/verify stages only", () => {
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "test" }), true);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "verify" }), true);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "verifier" }), true);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "Test" }), true);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "planner" }), false);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "react" }), false);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "executor" }), false);
  assert.equal(commandFailureEligibleForVerifyRetry({ type: "single-shot" }), false);
});

test("verify retry budget defaults to 2 with env override and clamp", () => {
  assert.equal(verifyRetryBudgetFromEnv({}), VERIFY_COMMAND_RETRY_BUDGET_DEFAULT);
  assert.equal(VERIFY_COMMAND_RETRY_BUDGET_DEFAULT, 2);
  assert.equal(verifyRetryBudgetFromEnv({ AGENTFLOW_VERIFY_RETRY_BUDGET: "3" }), 3);
  assert.equal(verifyRetryBudgetFromEnv({ AGENTFLOW_VERIFY_RETRY_BUDGET: "0" }), 0);
  assert.equal(verifyRetryBudgetFromEnv({ AGENTFLOW_VERIFY_RETRY_BUDGET: "99" }), VERIFY_COMMAND_RETRY_BUDGET_MAX);
  assert.equal(verifyRetryBudgetFromEnv({ AGENTFLOW_VERIFY_RETRY_BUDGET: "bogus" }), VERIFY_COMMAND_RETRY_BUDGET_DEFAULT);
});

test("npm pre-flight flags missing package.json with a clear diagnostic", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  assert.equal(npmPreflightDiagnostic("npm run typecheck", repoRoot), null);
  assert.equal(npmPreflightDiagnostic("npm test", repoRoot), null);
  assert.equal(npmPreflightDiagnostic("cargo test", "/nonexistent-dir"), null);
  const emptyDir = mkdtempSync(join(tmpdir(), "agentflow-preflight-"));
  try {
    const diagnostic = npmPreflightDiagnostic("npm run typecheck", emptyDir);
    assert.ok(diagnostic);
    assert.match(diagnostic, /no package\.json found/);
    assert.ok(diagnostic.includes(emptyDir));
    assert.ok(diagnostic.includes("npm run typecheck"));
    const prefixed = npmPreflightDiagnostic("npm --prefix sub run build", repoRoot);
    assert.ok(prefixed);
    assert.match(prefixed, /no package\.json found/);
    assert.ok(prefixed.includes(join(repoRoot, "sub")));
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("verify-stage command failures re-enter the action loop with a retry budget", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /verifyActionRounds:\s+do \{/u);
  assert.match(source, /continue verifyActionRounds;/u);
  assert.match(source, /\} while \(verifyRetryRequested\);/u);
  assert.match(source, /commandFailureEligibleForVerifyRetry\(stagePattern\)/u);
  assert.match(source, /local_command_verify_retry/u);
  assert.match(source, /agentflow-verify-retry-round/u);
  assert.match(source, /commandFailureDelta\(/u);
});

test("npm pre-flight is hooked where the executor resolves the command cwd", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /npmPreflightDiagnostic\(commandLine, localProjectRootUri\)/u);
});

test("git porcelain parsing handles modified, untracked, renamed, and deleted entries", () => {
  const parsed = parseGitStatusPorcelain(
    " M src/foo.ts\nM  src/staged.ts\n?? scratch/new.ts\n?? untracked-dir/\nR  old-name.ts -> new-name.ts\n D src/gone.ts\n"
  );
  assert.deepEqual(
    [...parsed].sort(),
    ["src/foo.ts", "src/staged.ts", "scratch/new.ts", "untracked-dir/", "new-name.ts", "src/gone.ts"].sort()
  );
});

test("footprint diff captures only paths that appeared during the stage", () => {
  const before = new Set(["src/foo.ts", "scratch/dirty.ts"]);
  const after = new Set(["src/foo.ts", "scratch/dirty.ts", "src/agent-change.ts"]);
  assert.deepEqual([...diffGitFootprint(before, after)], ["src/agent-change.ts"]);
  assert.deepEqual([...diffGitFootprint(before, before)], []);
});

test("verify failure file extraction parses tsc-style paths and dedupes", () => {
  const files = extractVerifyFailureFiles(
    "packages/perf-harness/src/index.ts(6,30): error TS2835: Relative import paths need explicit file extensions\n" +
      "src/other.ts:12:5: some other diagnostic\n" +
      "just a log line\n" +
      "packages/perf-harness/src/index.ts(6,30): error TS2835: duplicate\n",
    "/repo"
  );
  assert.deepEqual(files, ["packages/perf-harness/src/index.ts", "src/other.ts"]);
});

test("verify failure file extraction relativizes absolute paths and drops outside ones", () => {
  assert.deepEqual(extractVerifyFailureFiles("/repo/src/abs.ts(1,2): error TS1: x", "/repo"), ["src/abs.ts"]);
  assert.deepEqual(extractVerifyFailureFiles("/elsewhere/src/x.ts(1,2): error TS1: x", "/repo"), []);
});

test("verify failures confined outside the agent footprint are environmental", () => {
  const attribution = attributeVerifyFailure({
    outputLines: ["scratch/dirty.ts(6,30): error TS2835: pre-existing breakage"],
    footprintBefore: new Set(["scratch/dirty.ts"]),
    footprintAfter: new Set(["scratch/dirty.ts"]),
    cwd: "/repo"
  });
  assert.equal(attribution.kind, "environmental");
  assert.deepEqual(attribution.files, ["scratch/dirty.ts"]);
});

test("verify failures touching the agent footprint stay agent-attributed", () => {
  const attribution = attributeVerifyFailure({
    outputLines: [
      "src/agent-change.ts(1,1): error TS1234: agent typo",
      "scratch/dirty.ts(6,30): error TS2835: pre-existing breakage"
    ],
    footprintBefore: new Set(["scratch/dirty.ts"]),
    footprintAfter: new Set(["scratch/dirty.ts", "src/agent-change.ts"]),
    cwd: "/repo"
  });
  assert.equal(attribution.kind, "agent");
  assert.deepEqual(attribution.files, ["src/agent-change.ts", "scratch/dirty.ts"]);
});

test("unknown footprint or unparseable output falls back to agent attribution", () => {
  const unknown = attributeVerifyFailure({
    outputLines: ["scratch/dirty.ts(6,30): error TS2835: x"],
    footprintBefore: null,
    footprintAfter: null,
    cwd: "/repo"
  });
  assert.equal(unknown.kind, "agent");
  const unparseable = attributeVerifyFailure({
    outputLines: ["something failed with no file paths"],
    footprintBefore: new Set(),
    footprintAfter: new Set(),
    cwd: "/repo"
  });
  assert.equal(unparseable.kind, "agent");
  assert.deepEqual(unparseable.files, []);
});

test("git status snapshot returns null outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflow-nogit-"));
  try {
    assert.equal(await snapshotGitStatus(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git status snapshot captures new files in a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentflow-git-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
    const snapshot = await snapshotGitStatus(dir);
    assert.ok(snapshot?.has("new.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("environmental verify failures block before the retry budget is touched", () => {
  const source = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(source, /attributeVerifyCommandFailure\(\{/u);
  assert.match(source, /local_command_verify_environmental/u);
  assert.match(source, /break verifyActionRounds;/u);
  const attributionIndex = source.indexOf('verifyAttribution.kind === "environmental"');
  const decrementIndex = source.indexOf("verifyRetriesRemaining -= 1");
  assert.ok(attributionIndex >= 0 && decrementIndex > attributionIndex);
});

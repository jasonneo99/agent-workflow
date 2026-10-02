import assert from "node:assert/strict";
import test from "node:test";
import { continuationBackoff, pendingEvidenceReason } from "./action-result-continuation.js";
import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("real worker checkpoints and resumes final command results without executing them twice", async (t) => {
  if (!process.env.AGENTFLOW_CONTINUATION_TEST_CHILD) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_CONTINUATION_TEST_CHILD: "1" };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], {
      env: childEnv, encoding: "utf8", timeout: 60_000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /CONTINUATION_WORKER_ASSERTIONS_PASSED/);
    return;
  }
  // Mock external boundaries, not executor orchestration, completion gates, or
  // idempotency logic. No database or hosted model is contacted by this test.
  const replace = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href;
    const original = await import(url);
    const defaults = relative.endsWith("/postgres.js")
      ? Object.fromEntries(Object.entries(original).map(([name, value]) => [name, typeof value === "function"
        ? () => { throw new Error(`Unmocked storage boundary: ${name}`); } : value])) : original;
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  let checkpoint: Record<string, any> | undefined;
  let completed: Record<string, any> | undefined;
  let executions = 0;
  let providerCalls = 0;
  let resumed = false;
  const receipts = new Map<string, any>();
  const artifacts = new Map<string, any>();
  const task = {
    runId: "synthetic-run", taskId: "synthetic-task", stageId: "inspect", agentId: "test-agent",
    agentName: "Test", agentPrompt: "Inspect the fixture", workflowId: "test-workflow",
    workflowTask: "Inspect fixture", stageGoal: "Inspect fixture", compiledBrief: "Inspect fixture",
    projectRootUri: process.cwd(), workerId: "test-worker", fencingToken: "1", priorReceipts: [],
    projectConfig: { project: { name: "fixture" }, policies: { require_approval_for_external_actions: false }, actions: { allowed_commands: ["node *"], require_approval_for: [] } },
    stagePattern: { type: "react", maxIterations: 3, requiresVerifier: false, promotionGate: "none", stopConditions: [] }
  };
  await replace("../../storage/src/postgres.js", {
    claimNextWorkflowTask: async () => task, startWorkflowTask: async () => {},
    assertWorkflowTaskLease: async () => {}, renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async (uri: string) => uri.endsWith("/continuation")
      ? checkpoint && { runId: task.runId, taskId: task.taskId, content: checkpoint } : artifacts.get(uri),
    recordRunAction: async (action: any) => {
      const uri = `db://synthetic/${artifacts.size}`;
      artifacts.set(uri, { content: action.artifactContent });
      if (action.idempotencyKey) receipts.set(action.idempotencyKey, { uri, content: action.artifactContent });
      return uri;
    },
    findRunActionByIdempotencyKey: async (input: any) => receipts.get(input.idempotencyKey) ?? null,
    claimSideEffect: async () => ({ status: "claimed", claimToken: "fixture-claim" }),
    finalizeSideEffect: async () => true, dismissSupersededActionApprovals: async () => {},
    requestActionApproval: async () => { throw new Error("Unexpected approval boundary"); },
    checkpointWorkflowTaskContinuation: async (input: any) => { checkpoint = JSON.parse(JSON.stringify(input.continuation)); },
    completeWorkflowTask: async (input: any) => { completed = input; },
    blockWorkflowTask: async (input: any) => { throw new Error(`Unexpected block: ${input.reason}`); },
    failWorkflowTask: async (input: any) => { throw new Error(`Unexpected failure: ${JSON.stringify(input)}`); }
  });
  await replace("./stage-authority.js", { createRenewingStageAuthority: async () => async () => {} });
  await replace("./stage-telemetry.js", { createStageTelemetry: () => ({ end() {}, setRoute() {} }), flushStageTelemetry: async () => {} });
  await replace("./memory-graph-wiring.js", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
  await replace("./fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
  await replace("../../agent-registry/src/loaders.js", { loadProjectConfig: async () => { throw new Error("Use snapshot"); } });
  await replace("../../model-providers/src/routing.js", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "fixture" }) });
  await replace("../../local-tools/src/command-executor.js", {
    assertCommandAllowed: () => {}, commandSerializationResource: () => null,
    executeAllowedCommand: async ({ commandLine }: any) => {
      executions++;
      return { commandLine, cwd: process.cwd(), exitCode: 0, stdout: "retained-final-evidence", stderr: "", timedOut: false, signal: null, durationMs: 1 };
    }
  });
  await replace("../../model-providers/src/index.js", {
    executeWithProviderFallback: async ({ stageInput }: any) => {
      providerCalls++;
      if (resumed) {
        const resume = stageInput.priorReceipts.find((receipt: any) => receipt.actionType === "stage_continuation_resumed");
        assert.ok(resume, "Fresh provider turn must receive continuation context");
        assert.match(resume.summary, /observation-4/);
        assert.ok(stageInput.priorReceipts.some((receipt: any) => receipt.summary.includes("retained-final-evidence")));
        assert.ok(stageInput.stateDeltas.length > 0, "Command state deltas survive checkpoint");
      }
      return { output: { summary: "Fixture observation recorded and reviewed.", artifact: { findings: ["Fixture observation"] },
        requestedCommands: resumed && providerCalls > 5 ? [] : [`node --version observation-${resumed ? 4 : providerCalls}`] },
        attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
    }
  });
  const { runWorkerOnce } = await import("./executor.js");
  const first = await runWorkerOnce(1, { recoverExpiredLeases: false });
  assert.equal(first.completed, 0, "Exhausted followup budget is not completion");
  assert.equal(completed, undefined);
  assert.equal(checkpoint?.round, 1);
  assert.equal(executions, 4, "Final new command executes before checkpoint");
  assert.ok(checkpoint?.actionResults.some((action: any) => action.commandLine === "node --version observation-4" && action.exitCode === 0));
  resumed = true;
  const second = await runWorkerOnce(1, { recoverExpiredLeases: false });
  assert.equal(second.completed, 1);
  assert.equal(executions, 4, "Resume cannot redispatch the executed final command");
  assert.ok((completed as Record<string, any> | undefined)?.artifact.actionResults.some((action: any) => action.commandLine === "node --version observation-4" && action.exitCode === 0));
  console.log("CONTINUATION_WORKER_ASSERTIONS_PASSED");
});

test("unchanged continuation evidence backs off finitely and new evidence resets it", () => {
  const actions = [{ commandLine: "npm test", exitCode: 0, artifactUri: "db://example/test" }];
  let checkpoint = continuationBackoff({}, actions);
  assert.equal(checkpoint.delaySeconds, 5);
  for (const expected of [10, 20, 40, 40]) {
    checkpoint = continuationBackoff(checkpoint, actions);
    assert.equal(checkpoint.delaySeconds, expected);
  }
  assert.equal(continuationBackoff(checkpoint, [...actions, { commandLine: "npm run typecheck", exitCode: 0 }]).delaySeconds, 5);
});

test("reused command receipts are not counted as progress", () => {
  const actions = [{ commandLine: "npm test", exitCode: 0 }];
  const prior = continuationBackoff({}, actions);
  const next = continuationBackoff(prior, [...actions, { type: "local_command_reused", commandLine: "npm test" }]);
  assert.equal(next.progressFingerprint, prior.progressFingerprint);
  assert.equal(next.unchangedRounds, 1);
});

test("unconsumed read and search requests cannot be accepted as completion", () => {
  const output = { summary: "Done", artifact: {}, requestedCommands: [], requestedFileWrites: [] } as StageExecutionOutput;
  assert.equal(pendingEvidenceReason(output), null);
  assert.notEqual(pendingEvidenceReason({ ...output, requestedFileReads: ["src/example.ts"] }), null);
  assert.notEqual(pendingEvidenceReason({ ...output, requestedFileSearches: ["example"] }), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Desired-behavior assertions intentionally run red before the R2 repair.
// Keep this same regression for the green run; do not invert the assertions.
test("R2 actual worker orders governed writes and refreshes failed command evidence", async (t) => {
  const scenario = process.env.AGENTFLOW_R2_WORKER_CASE;
  if (!scenario) {
    const failures: string[] = [];
    for (const mode of ["ordering", "stale", "rejected-write", "restart", "write-only"]) {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_R2_WORKER_CASE: mode };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 50_000 });
      const output = child.stdout + child.stderr;
      console.log(output);
      if (child.status !== 0) failures.push(`${mode}: status=${child.status}, signal=${child.signal}\n${output}`);
    }
    assert.deepEqual(failures, [], "R2 desired behavior failed; inspect R2_WORKER_OBSERVATION for reproduction evidence");
    return;
  }
  assert.ok(["ordering", "stale", "rejected-write", "restart", "write-only"].includes(scenario));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-r2-fixture-")));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const relativePath = "fixture.test.cjs";
  // A plain child script cannot be silently skipped by inherited NODE_TEST_CONTEXT.
  const passing = "const assert = require('node:assert/strict'); assert.equal(1, 1); console.log('R2_FIXTURE_EXECUTED');\n";
  const failing = passing.replace("assert.equal(1, 1)", "assert.equal(1, 2)");
  if (scenario === "stale") await fs.writeFile(path.join(root, relativePath), failing);
  const command = "node fixture.test.cjs";
  const artifacts = new Map<string, any>();
  const receipts = new Map<string, any>();
  const claims = new Map<string, any>();
  let checkpoint: any;
  let completed: any;
  let blocked: any;
  let failed: any;
  let providerCalls = 0;
  let resumedCalls = 0;
  let consumed = false;
  let leaseChecks = 0;
  const task = {
    runId: "synthetic-r2-run", taskId: "synthetic-r2-task", stageId: "inspect", agentId: "test-agent",
    agentName: "Synthetic R2", agentPrompt: "Inspect synthetic command and mutation evidence", workflowId: "test-workflow",
    workflowTask: "Inspect synthetic action dependencies", stageGoal: "Inspect synthetic evidence", compiledBrief: "Synthetic R2 fixture",
    projectRootUri: root, workerId: "synthetic-r2-worker", fencingToken: "1", priorReceipts: [],
    projectConfig: { project: { name: "Synthetic R2" }, policies: { require_approval_for_external_actions: false },
      actions: { allowed_commands: [command, "node --version"], allowed_write_paths: scenario === "rejected-write" ? ["allowed-only/**"] : [relativePath], require_approval_for: [] } },
    stagePattern: { type: "react", maxIterations: 3, requiresVerifier: false, promotionGate: "none", stopConditions: [] }
  };
  const replace = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href;
    const original = await import(url);
    const defaults = relative.endsWith("/postgres.js")
      ? Object.fromEntries(Object.entries(original).map(([name, value]) => [name, typeof value === "function"
        ? () => { throw new Error(`Unmocked storage boundary: ${name}`); } : value])) : original;
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  await replace("../../storage/src/postgres.js", {
    claimNextWorkflowTask: async () => task, startWorkflowTask: async () => {},
    assertWorkflowTaskLease: async (input: any) => {
      assert.equal(input.taskId, task.taskId);
      assert.equal(input.workerId, task.workerId);
      assert.equal(input.fencingToken, task.fencingToken);
      leaseChecks++;
    }, renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async (uri: string) => uri.endsWith("/continuation")
      ? checkpoint && { runId: task.runId, taskId: task.taskId, content: checkpoint } : artifacts.get(uri) ?? null,
    recordRunAction: async (action: any) => {
      const uri = `db://synthetic-r2/${artifacts.size}`;
      const row = { uri, runId: task.runId, taskId: task.taskId, stageId: task.stageId,
        kind: action.artifactKind, actionType: action.actionType, content: action.artifactContent, idempotencyKey: action.idempotencyKey };
      artifacts.set(uri, row);
      if (action.idempotencyKey) receipts.set(action.idempotencyKey, row);
      return uri;
    },
    findRunActionByIdempotencyKey: async (input: any) => {
      const row = receipts.get(input.idempotencyKey);
      return row?.kind === input.artifactKind ? row : null;
    },
    claimSideEffect: async (input: any) => {
      const existing = claims.get(input.idempotencyKey);
      if (existing) return { status: existing.status, receipt: existing.receipt };
      const claimToken = `synthetic-claim-${claims.size}`;
      claims.set(input.idempotencyKey, { status: "claimed", claimToken });
      return { status: "claimed", claimToken };
    },
    finalizeSideEffect: async (input: any) => {
      const claim = claims.get(input.idempotencyKey);
      if (claim?.claimToken !== input.claimToken) return false;
      claims.set(input.idempotencyKey, { ...claim, status: "completed", receipt: input.receipt });
      return true;
    },
    withProjectExecutionLock: async (_input: any, action: () => Promise<unknown>) => action(),
    dismissSupersededActionApprovals: async () => {},
    requestActionApproval: async () => {
      if (scenario === "rejected-write") return { id: "synthetic-pending-approval", status: "pending" };
      throw new Error("Unexpected approval boundary in authorized synthetic fixture");
    },
    checkpointWorkflowTaskContinuation: async (input: any) => { checkpoint = structuredClone(input.continuation); },
    completeWorkflowTask: async (input: any) => { assert.equal(input.fencingToken, task.fencingToken); completed = input; },
    blockWorkflowTask: async (input: any) => { blocked = input; },
    failWorkflowTask: async (input: any) => { failed = input; }
  });
  await replace("./stage-authority.js", { createRenewingStageAuthority: async ({ assertLeaseOwned }: any) => async () => assertLeaseOwned() });
  await replace("./stage-telemetry.js", { createStageTelemetry: () => ({ end() {}, setRoute() {}, event() {} }), flushStageTelemetry: async () => {} });
  await replace("./memory-graph-wiring.js", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
  await replace("./fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
  await replace("../../agent-registry/src/loaders.js", { loadProjectConfig: async () => { throw new Error("Use synthetic policy snapshot"); } });
  await replace("../../model-providers/src/routing.js", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "Synthetic R2" }) });
  await replace("../../model-providers/src/index.js", {
    executeWithProviderFallback: async ({ stageInput }: any) => {
      providerCalls++;
      if (scenario === "write-only" && providerCalls === 2) {
        assert.ok(stageInput.priorReceipts.some((receipt: any) => receipt.actionType === "file_write" && receipt.summary.includes(relativePath)), "Successful write receipt must reach the provider");
        assert.ok(stageInput.fileReads.some((read: any) => read.path === relativePath && read.content === passing && read.sha256), "Post-write contents and hash must reach the provider");
      }
      if (checkpoint) resumedCalls++;
      if (providerCalls >= 3) {
        consumed = stageInput.priorReceipts.some((receipt: any) => receipt.summary.includes(command) && receipt.summary.includes("succeeded"));
      }
      return { output: {
        summary: "Synthetic command and governed mutation observations inspected.", artifact: { findings: ["Synthetic R2 action dependency evidence"], nextAction: "Review receipt observations" },
        requestedCommands: scenario === "write-only" ? (providerCalls === 2 ? [command] : []) : scenario === "restart"
          ? (!checkpoint || resumedCalls === 1 ? [command] : [])
          : providerCalls === 1 ? [command, "node --version"] : providerCalls === 2 ? [command] : [],
        requestedFileWrites: providerCalls === (scenario === "stale" ? 2 : 1) ? [{ path: relativePath, content: passing }] : []
      }, attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
    }
  });
  const { runWorkerOnce } = await import("./executor.js");
  let result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  if (scenario === "restart") {
    assert.equal(result.completed, 0);
    assert.ok(checkpoint?.actionResults.some((action: any) => action.type === "file_write" && action.nextHash));
    // Serialize the durable boundary, then replace the worker lease identity.
    checkpoint = JSON.parse(JSON.stringify(checkpoint));
    task.workerId = "synthetic-r2-worker-b";
    task.fencingToken = "2";
    result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  }
  const commands = [...artifacts.values()].filter((row) => row.kind === "command_output" && row.content.commandLine === command);
  const writes = [...artifacts.values()].filter((row) => row.kind === "file_write");
  const reuses = [...artifacts.values()].filter((row) => row.actionType === "local_command_reused" && row.content.target === command);
  console.log("R2_WORKER_OBSERVATION " + JSON.stringify({ scenario, result, providerCalls, consumed, leaseChecks,
    commands: commands.map((row) => ({ uri: row.uri, exitCode: row.content.exitCode, timedOut: row.content.timedOut,
      stdout: row.content.stdout, stderr: row.content.stderr, idempotencyKey: row.idempotencyKey })),
    writes: writes.map((row) => ({ uri: row.uri, nextHash: row.content.nextHash })),
    reuses: reuses.map((row) => row.content), failed, blockedReason: blocked?.reason, checkpointRound: checkpoint?.round }));
  assert.equal(failed, undefined, "Fixture setup/runtime failure is not expected R2 assertion evidence");
  assert.ok(leaseChecks > 0, "Actual worker checks fencing authority");
  if (scenario === "rejected-write") {
    assert.equal(writes.length, 0);
    assert.equal(commands.length, 0, "Dependent command must not run after a rejected prerequisite");
    assert.equal(result.completed, 0);
    assert.ok(blocked);
    return;
  }
  assert.equal(writes.length, 1, "Exactly one authorized governed write must succeed");
  assert.equal(await fs.readFile(path.join(root, relativePath), "utf8"), passing);
  if (scenario === "write-only") assert.ok(providerCalls >= 3, "Write-only action must return its result to the provider before completion");
  assert.ok(commands.length > 0, "Actual local command must execute");
  if (scenario === "ordering") assert.equal(commands[0].content.exitCode, 0, "R2_ORDERING: command must observe the authorized test-file creation");
  if (scenario === "ordering") {
    assert.equal(commands.length, 1, "Unchanged successful command must execute only once");
    assert.equal(reuses.length, 1);
  }
  if (scenario === "restart") {
    assert.equal(commands.length, 1, "Resumed worker must reuse the unchanged governed-write subject");
    assert.ok(resumedCalls >= 2);
  }
  if (scenario === "stale") assert.notEqual(commands[0].content.exitCode, 0, "Stale evidence case must first execute a genuinely failing command");
  assert.equal(commands.at(-1)?.content.exitCode, 0, "R2_STALE_FAILURE: governed replacement must allow fresh successful evidence instead of reusing the earlier failure");
  assert.match(commands.at(-1)?.content.stdout ?? "", /R2_FIXTURE_EXECUTED/u, "Successful exit must include proof the fixture executed");
  assert.equal(consumed, true, "Provider must consume successful regression-command evidence");
  assert.equal(result.completed, 1, "Actual worker completes only after evidence consumption");
  assert.ok(completed);
  assert.equal(blocked, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Desired-behavior assertions intentionally run red before the R2 repair.
// Keep this same regression for the green run; do not invert the assertions.
test("R2 actual worker orders governed writes and refreshes failed command evidence", async (t) => {
  const scenario = process.env.AGENTFLOW_R2_WORKER_CASE;
  if (!scenario) {
    const failures: string[] = [];
    for (const mode of ["ordering", "stale", "rejected-write", "restart", "write-only", "deferred-refresh", "reused-write-refresh"]) {
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
  assert.ok(["ordering", "stale", "rejected-write", "restart", "write-only", "deferred-refresh", "reused-write-refresh"].includes(scenario));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-r2-fixture-")));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const relativePath = "fixture.test.cjs";
  // A plain child script cannot be silently skipped by inherited NODE_TEST_CONTEXT.
  const passing = "const assert = require('node:assert/strict'); assert.equal(1, 1); console.log('R2_FIXTURE_EXECUTED');\n";
  const failing = passing.replace("assert.equal(1, 1)", "assert.equal(1, 2)");
  if (scenario === "stale" || scenario === "deferred-refresh") await fs.writeFile(path.join(root, relativePath), failing);
  if (scenario === "reused-write-refresh") await fs.writeFile(path.join(root, relativePath), passing);
  const command = "node fixture.test.cjs";
  const artifacts = new Map<string, any>();
  const receipts = new Map<string, any>();
  const claims = new Map<string, any>();
  const refreshCase = scenario === "deferred-refresh" || scenario === "reused-write-refresh";
  let checkpoint: any = refreshCase ? { version: 1, round: 0, actionResults: [], fileReads: [{
    path: relativePath, content: failing, truncated: false, sha256: createHash("sha256").update(failing).digest("hex")
  }] } : undefined;
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
  await replace("../../storage/src/client.js", {
    withClient: async (operation: (client: any) => unknown) => operation({
      query: async (sql: string, args: unknown[]) => {
        assert.match(sql, /from artifacts a/u);
        assert.match(sql, /join workflow_tasks wt/u);
        assert.deepEqual(args, [task.runId]);
        return { rows: [...artifacts.values()].reverse().filter(row => row.kind === "file_write").map(row => {
          const claim = claims.get(row.content.idempotencyKey);
          return { runId: row.runId, taskId: row.taskId, stageId: row.stageId,
            kind: row.kind, uri: row.uri, content: row.content,
            status: claim?.status ?? null, operation: "file_write", receipt: claim?.receipt ?? null };
        }) };
      }
    })
  });
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
        kind: action.artifactKind, actionType: action.actionType,
        content: { ...action.artifactContent, ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {}) },
        idempotencyKey: action.idempotencyKey };
      artifacts.set(uri, row);
      if (action.idempotencyKey) receipts.set(action.idempotencyKey, row);
      return uri;
    },
    findRunActionByIdempotencyKey: async (input: any) => {
      const row = receipts.get(input.idempotencyKey);
      return row?.kind === input.artifactKind ? row : null;
    },
    getSideEffectReceipt: async (input: any) => {
      assert.equal(input.projectId, task.runId);
      return claims.get(input.idempotencyKey) ?? null;
    },
    claimSideEffect: async (input: any) => {
      const existing = claims.get(input.idempotencyKey);
      if (existing) return { status: existing.status, receipt: existing.receipt };
      const claimToken = `synthetic-claim-${claims.size}`;
      claims.set(input.idempotencyKey, { ...input, status: "claimed", claimToken });
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
    checkpointWorkflowTaskContinuation: async (input: any) => {
      checkpoint = structuredClone(input.continuation);
      if (scenario === "restart") {
        const read = checkpoint.fileReads.find((item: any) => item.path === relativePath);
        assert.equal(read?.content, passing, "Persisted continuation must retain the committed postimage");
        assert.equal(read?.sha256, createHash("sha256").update(passing).digest("hex"));
      }
    },
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
      if (refreshCase) {
        if (providerCalls === 2) {
          const read = stageInput.fileReads.find((item: any) => item.path === relativePath);
          assert.equal(read?.content, passing, "Combined write and command must replace the cached preimage before the next provider turn");
          assert.equal(read?.sha256, createHash("sha256").update(passing).digest("hex"));
          assert.ok(stageInput.priorReceipts.some((receipt: any) => receipt.actionType === "file_write" && receipt.summary.includes(relativePath)));
          assert.ok(stageInput.priorReceipts.some((receipt: any) => receipt.summary.includes("R2_FIXTURE_EXECUTED")));
          consumed = true;
        }
        return { output: { outcome: "completed", summary: "Committed source and actual command observations inspected.",
          artifact: { findings: ["Synthetic postimage and passing command consumed"] },
          requestedCommands: providerCalls === 1 ? [command] : [],
          requestedFileWrites: providerCalls === 1 ? [{ path: relativePath, content: passing }] : [] },
          attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
      }
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
  let recoveryReads = 0;
  await replace("./recovery-evidence.js", {
    recoveryEvidence: async (runId: string, projectRootUri: string) => {
      assert.equal(runId, task.runId);
      assert.equal(projectRootUri, task.projectRootUri);
      recoveryReads++;
      return ""; // Synthetic dependency scenarios have no stored ancestry.
    }
  });
  const { runWorkerOnce, actionIdempotencyKey } = await import("./executor.js");
  if (scenario === "reused-write-refresh") {
    const key = actionIdempotencyKey({ taskId: task.taskId, stageId: task.stageId, agentId: task.agentId,
      actionType: "file_write", target: relativePath, payload: passing });
    const uri = "db://synthetic-r2/seed-write", nextHash = createHash("sha256").update(passing).digest("hex");
    const row = { uri, runId: task.runId, taskId: task.taskId, stageId: task.stageId, kind: "file_write", actionType: "file_write",
      content: { relativePath, nextHash, idempotencyKey: key, requestedByTaskId: task.taskId, requestedByStageId: task.stageId }, idempotencyKey: key };
    artifacts.set(uri, row); receipts.set(key, row);
    claims.set(key, { status: "completed", operation: "file_write", target: relativePath, receipt: { artifactUri: uri, path: relativePath, nextHash } });
  }
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
  assert.ok(recoveryReads > 0, "Worker reads recovery context through the scoped fixture boundary");
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
  if (refreshCase) {
    assert.equal(providerCalls, 2); assert.equal(commands.length, 1);
    assert.equal(checkpoint.round, 0, "Fresh observations need no additional continuation");
    if (scenario === "reused-write-refresh") assert.equal([...artifacts.values()].filter(row => row.actionType === "file_write_reused").length, 1);
  }
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

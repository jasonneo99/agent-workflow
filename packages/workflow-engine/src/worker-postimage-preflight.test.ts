import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenarios = [
  "matching-prior", "matching-interrupted", "stale-prior", "stale-interrupted",
  "missing-interrupted", "unfinalized-interrupted", "unbound-receipt",
  "storage-unavailable", "malformed-prior", "oversized-stored-scope",
  "no-write", "narrative-only", "stale-executor", "matching-executor",
  "lease-lost-before-read", "lease-lost-after-read"
];

test("actual worker verifies its local recorded postimages before execution", async (t) => {
  const scenario = process.env.AGENTFLOW_WORKER_POSTIMAGE_CASE;
  if (!scenario) {
    for (const name of scenarios) await t.test(name, () => {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_WORKER_POSTIMAGE_CASE: name };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [
        "--experimental-test-module-mocks", "--import", "tsx", "--test",
        fileURLToPath(import.meta.url)
      ], { env, encoding: "utf8", timeout: 30_000 });
      const output = child.stdout + child.stderr;
      const observation = output.split("\n").find(line => line.includes("POSTIMAGE_WORKER_OBSERVATION"));
      if (observation) console.log(observation);
      assert.equal(child.status, 0, name + ": " + output.slice(-2400));
    });
    return;
  }
  assert.ok(scenarios.includes(scenario));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-postimage-worker-")));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const relativePath = "fixture.txt";
  const recorded = "recorded synthetic postimage\n";
  const stale = "other checkout bytes\n";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const matching = scenario.startsWith("matching-");
  const expectsExecution = matching || scenario === "no-write" || scenario === "narrative-only";
  const boundExecutor = scenario.endsWith("-executor");
  const leaseLost = scenario.startsWith("lease-lost-");
  const actual = matching ? recorded : stale;
  if (scenario !== "missing-interrupted") await fs.writeFile(path.join(root, relativePath), actual);
  const task = {
    runId: "synthetic-postimage-run", taskId: "synthetic-current-task", stageId: "inspect",
    agentId: "task-triager", agentName: "Synthetic inspector",
    agentPrompt: "Inspect synthetic evidence without changing files", workflowId: "test-workflow",
    workflowTask: "Inspect synthetic checkout evidence", stageGoal: "Inspect the recorded checkout evidence",
    compiledBrief: "Synthetic evidence fixture", projectRootUri: root,
    workerId: "synthetic-resumed-worker", fencingToken: "7", priorReceipts: [],
    priorStageArtifacts: [] as Array<{ stageId: string; agentId: string; summary: string; artifact: Record<string, unknown> }>,
    projectConfig: {
      project: { name: "Synthetic postimage worker" },
      policies: { require_approval_for_external_actions: false },
      actions: { allowed_commands: [], allowed_write_paths: [], require_approval_for: [] }
    },
    stagePattern: { type: "react", maxIterations: 1, requiresVerifier: false, promotionGate: "none", stopConditions: [] },
    ...(boundExecutor ? { executorSnapshot: { snapshotHash: "synthetic-executor-snapshot" } } : {})
  };
  const prior = (action: Record<string, unknown>) => ({
    stageId: "implement", agentId: "implementation-agent", summary: "Synthetic prior stage",
    artifact: { actionResults: [action] }
  });
  if (scenario.endsWith("-prior")) task.priorStageArtifacts = [prior({
    type: "file_write", path: relativePath, artifactUri: "db://synthetic/postimage/write"
  })];
  if (scenario === "malformed-prior") task.priorStageArtifacts = [prior({
    type: "file_write", path: "../outside.txt", artifactUri: "db://synthetic/postimage/write"
  })];
  if (scenario === "narrative-only") task.priorStageArtifacts = [{
    stageId: "plan", agentId: "technical-architect", summary: "Claims a source write in prose",
    artifact: { findings: ["Claimed source write"], requestedFileWrites: [{ path: relativePath, content: recorded }] }
  }];
  const receiptTaskId = scenario.includes("prior") ? "synthetic-prior-task" : task.taskId;
  const receiptStageId = scenario.includes("prior") ? "implement" : task.stageId;
  const row = {
    runId: task.runId, taskId: receiptTaskId, stageId: receiptStageId,
    kind: "file_write", uri: "db://synthetic/postimage/write",
    status: "completed", operation: "file_write",
    content: {
      relativePath, nextHash: hash(recorded),
      requestedByTaskId: receiptTaskId, requestedByStageId: receiptStageId
    },
    receipt: { artifactUri: "db://synthetic/postimage/write", path: relativePath, nextHash: hash(recorded) }
  };
  let rows = ["no-write", "narrative-only"].includes(scenario) ? [] : [row];
  if (scenario === "unfinalized-interrupted") rows = [
    { ...row, status: "pending", receipt: { ...row.receipt, nextHash: hash("pending") } }, row
  ];
  if (scenario === "unbound-receipt") rows = [{
    ...row, content: { ...row.content, requestedByTaskId: "foreign-task" }
  }];
  if (scenario === "oversized-stored-scope") rows = Array.from({ length: 1001 }, (_, i) => ({
    ...row, content: { ...row.content, relativePath: "synthetic-" + i + ".txt" }
  }));
  const calls = { start: 0, lease: 0, storage: 0, route: 0, provider: 0, command: 0, mutation: 0, executor: 0 };
  const ends: string[] = [];
  const artifacts: any[] = [];
  let completed: any;
  let blocked: any;
  let failed: any;
  const replace = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href;
    const original = await import(url);
    const defaults = relative.endsWith("/postgres.js")
      ? Object.fromEntries(Object.entries(original).map(([name, value]) => [name, typeof value === "function"
        ? () => { throw new Error("Unmocked storage boundary: " + name); } : value])) : original;
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  // Only the external database boundary is replaced; receipt/provenance selection,
  // real local file hashing and worker orchestration execute unchanged.
  await replace("../../storage/src/client.js", {
    withClient: async (operation: (client: any) => unknown) => operation({
      query: async (sql: string, args: unknown[]) => {
        assert.match(sql, /from artifacts a/u);
        assert.match(sql, /join workflow_tasks wt/u);
        assert.deepEqual(args, [task.runId]);
        calls.storage++;
        if (scenario === "storage-unavailable") throw new Error("Synthetic storage unavailable");
        return { rows };
      }
    })
  });
  await replace("../../storage/src/postgres.js", {
    claimNextWorkflowTask: async () => task,
    startWorkflowTask: async (input: any) => {
      assert.equal(input.fencingToken, task.fencingToken); calls.start++;
    },
    assertWorkflowTaskLease: async (input: any) => {
      assert.equal(input.taskId, task.taskId);
      assert.equal(input.workerId, task.workerId);
      assert.equal(input.fencingToken, task.fencingToken);
      calls.lease++;
      if (scenario === "lease-lost-before-read" || (scenario === "lease-lost-after-read" && calls.storage > 0)) {
        throw new Error("expired task lease");
      }
    },
    renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async () => null,
    recordRunAction: async (input: any) => {
      artifacts.push(input);
      return "db://synthetic/postimage/action-" + artifacts.length;
    },
    completeWorkflowTask: async (input: any) => { completed = input; },
    blockWorkflowTask: async (input: any) => { blocked = input; },
    failWorkflowTask: async (input: any) => { failed = input; }
  });
  await replace("./stage-authority.js", {
    createRenewingStageAuthority: async ({ assertLeaseOwned }: any) => async () => assertLeaseOwned()
  });
  await replace("./stage-telemetry.js", {
    createStageTelemetry: () => ({ end(state: string) { ends.push(state); }, setRoute() {}, event() {} }),
    flushStageTelemetry: async () => {}
  });
  await replace("./memory-graph-wiring.js", {
    buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {}
  });
  await replace("./recovery-evidence.js", { recoveryEvidence: async () => "" });
  await replace("./fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
  await replace("../../learning-loop/src/runtime.js", { selectPromptPersonalization: async () => null });
  await replace("../../agent-registry/src/loaders.js", {
    loadProjectConfig: async () => { throw new Error("Use synthetic policy snapshot"); }
  });
  await replace("../../model-providers/src/routing.js", {
    selectModelRoute: async () => { calls.route++; return { providerId: "mock", modelTier: "fast", reason: "Synthetic inspection" }; }
  });
  await replace("../../model-providers/src/index.js", {
    executeWithProviderFallback: async () => {
      calls.provider++;
      return {
        output: {
          outcome: "completed", summary: "Synthetic checkout evidence has been inspected.",
          artifact: { findings: ["Synthetic receipt provenance and checkout observations inspected"], nextAction: "Retain the inspection evidence" },
          requestedCommands: [], requestedFileWrites: []
        },
        attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false
      };
    }
  });
  await replace("../../local-tools/src/command-executor.js", {
    executeAllowedCommand: async () => { calls.command++; throw new Error("Unexpected command"); }
  });
  await replace("../../local-tools/src/file-patcher.js", {
    executeAllowedFileMutation: async () => { calls.mutation++; throw new Error("Unexpected mutation"); }
  });
  await replace("./bound-executor.js", {
    executeBoundExecutorStage: async () => { calls.executor++; return "completed"; }
  });
  const { runWorkerOnce } = await import("./executor.js");
  const result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  console.log("POSTIMAGE_WORKER_OBSERVATION " + JSON.stringify({
    scenario, result, calls, ends, blockedReason: blocked?.reason,
    postimages: blocked?.artifact?.sourcePostimages, failed
  }));
  assert.equal(calls.start, 1);
  assert.equal(failed, undefined, "A source preflight refusal must not become a repair-triggering failure");
  assert.equal(calls.command, 0);
  assert.equal(calls.mutation, 0);
  if (scenario === "missing-interrupted") await assert.rejects(fs.stat(path.join(root, relativePath)), { code: "ENOENT" });
  else assert.equal(await fs.readFile(path.join(root, relativePath), "utf8"), actual);
  if (leaseLost) {
    assert.equal(calls.provider, 0);
    assert.equal(calls.executor, 0);
    assert.equal(calls.route, 0);
    assert.equal(blocked, undefined, "A lost lease cannot write a blocked outcome");
    assert.equal(completed, undefined);
    assert.equal(calls.storage, scenario === "lease-lost-before-read" ? 0 : 1);
    return;
  }
  if (expectsExecution) {
    assert.ok(calls.storage > 0, "Even a no-write stage checks durable interrupted-task receipts");
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 0);
    assert.equal(blocked, undefined);
    if (boundExecutor) {
      assert.equal(calls.executor, 1);
      assert.equal(calls.route, 0);
      assert.equal(calls.provider, 0);
    } else {
      assert.equal(calls.executor, 0);
      assert.equal(calls.route, 1);
      assert.equal(calls.provider, 1);
      assert.ok(completed);
    }
    return;
  }
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.ok(calls.lease > 0);
  assert.equal(calls.route, 0);
  assert.equal(calls.provider, 0);
  assert.equal(calls.executor, 0);
  assert.equal(completed, undefined);
  assert.equal(blocked?.fencingToken, task.fencingToken);
  assert.equal(blocked?.artifact?.outcome, "blocked");
  assert.equal(blocked?.artifact?.authority, "none");
  assert.equal(blocked?.artifact?.sourcePostimages?.matches, false);
  assert.ok(ends.includes("blocked"));
  if (scenario === "storage-unavailable") assert.equal(blocked?.artifact?.sourcePostimages?.evidenceUnavailable, true);
});

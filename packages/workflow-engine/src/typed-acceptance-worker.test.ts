import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENVIRONMENT_COMMAND } from "../../run-environments/src/schema.js";
import { acceptanceDigest, enrollAcceptanceContract, storedAcceptanceDecision } from "../../storage/src/acceptance.js";
import { commandAcceptanceReference } from "../../storage/src/command-evidence.js";
import { sourceSubjectHash } from "./source-subject.js";
import type { StageExecutionInput, StructuredAcceptanceContract } from "../../model-providers/src/types.js";

test("enrolled no-edit acceptance completes through the real worker", async (t) => {
  if (!process.env.AGENTFLOW_TYPED_WORKER_CHILD) {
    for (const scenario of ["valid", "valid-environment", "missing", "stale", "changed-contract"]) {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_TYPED_WORKER_CHILD: "1", AGENTFLOW_TYPED_WORKER_CASE: scenario };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 60_000 });
      assert.equal(child.status, 0, `${scenario}: ${child.stdout}${child.stderr}`);
    }
    return;
  }
  // Only external boundaries are replaced. Worker gates and structured receipt
  // validation remain real; the allowlisted no-edit command executes locally.
  const useEnvironment = process.env.AGENTFLOW_TYPED_WORKER_CASE === "valid-environment";
  const root = useEnvironment ? await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-worker-environment-"))) : process.cwd();
  if (useEnvironment) {
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "package.json"), '{"name":"synthetic-worker-environment"}\n');
  }
  const replace = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href;
    const original = await import(url);
    const defaults = relative.endsWith("/postgres.js")
      ? Object.fromEntries(Object.entries(original).map(([name, value]) => [name, typeof value === "function"
        ? () => { throw new Error(`Unmocked storage boundary: ${name}`); } : value])) : original;
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  const workflowTask = "Implement the enrolled synthetic acceptance requirements";
  const frozen: StructuredAcceptanceContract = {
    version: 1, contractId: "synthetic-contract", projectId: "synthetic-project", originRunId: "synthetic-run",
    taskHash: acceptanceDigest(workflowTask), sourcePaths: ["package.json"],
    subjectHash: await sourceSubjectHash(root, ["package.json"]),
    deliverables: [{ id: "runtime", description: "Confirm the available runtime without source edits",
      requiredGates: ["implementation", "verification", "packaging", "supervision"], status: "pending", receipts: {}, gaps: [] }]
  };
  let metadata: Record<string, unknown> = {};
  const artifacts = new Map<string, any>();
  const receipts = new Map<string, any>();
  const client = { query: async (sql: string, args: any[] = []) => {
    if (sql.startsWith("update workflow_runs")) {
      metadata = { acceptanceContract: JSON.parse(args[1]) };
      return { rows: [] };
    }
    if (sql.includes("from workflow_runs")) return { rows: [{ projectId: frozen.projectId, task: workflowTask, metadata, started: false }] };
    if (sql.includes("select uri from artifacts")) {
      const latest = [...artifacts.values()].reverse().find((row) => row.runId === args[0]
        && row.kind === "command_output" && row.content.commandLine === args[1]);
      return { rows: latest ? [{ uri: latest.uri }] : [] };
    }
    if (sql.includes("from artifacts")) {
      const row = artifacts.get(args[0]);
      return { rows: row && row.runId === args[1] ? [{ ...row, observedAt: row.createdAt }] : [] };
    }
    throw new Error(`Unexpected acceptance query: ${sql}`);
  } } as unknown as Parameters<typeof storedAcceptanceDecision>[0];
  await enrollAcceptanceContract(client, frozen.originRunId, frozen);
  await assert.rejects(enrollAcceptanceContract(client, frozen.originRunId, { ...frozen, subjectHash: "replacement" }), /immutable/);
  const task = {
    runId: frozen.originRunId, taskId: "synthetic-task", stageId: "implement", agentId: "implementation-agent",
    agentName: "Synthetic", agentPrompt: "Evaluate the frozen contract using governed evidence", workflowId: "debug-failure",
    workflowTask, stageGoal: "Confirm synthetic runtime", compiledBrief: "Synthetic acceptance fixture",
    projectRootUri: root, workerId: "synthetic-worker", fencingToken: "1", priorReceipts: [],
    acceptanceContract: structuredClone(frozen),
    projectConfig: { project: { name: "Synthetic acceptance" }, policies: { require_approval_for_external_actions: false },
      actions: { allowed_commands: ["node --version", ...(useEnvironment ? [ENVIRONMENT_COMMAND] : [])], allowed_write_paths: [] },
      ...(useEnvironment ? { execution: { environments: { default_profile: "runtime", profiles: { runtime: {
        kind: "native", platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
        source_paths: ["package.json"], readiness: [{ argv: ["node", "--version"] }]
      } } } } } : {}) },
    stagePattern: { type: "react", maxIterations: 3, requiresVerifier: false, promotionGate: "none", stopConditions: [] }
  };
  let completed: any;
  let blocked: any;
  let failed: any;
  let proposed: StructuredAcceptanceContract | undefined;
  let leaseChecks = 0;
  let providerCalls = 0;
  await replace("../../storage/src/client.js", {
    withClient: async (operation: (client: any) => unknown) => operation({
      query: async (sql: string, args: unknown[]) => {
        assert.match(sql, /from artifacts a/u);
        assert.match(sql, /join workflow_tasks wt/u);
        assert.deepEqual(args, [task.runId]);
        return { rows: [] }; // This fixture has no stored source writes.
      }
    })
  });
  await replace("../../storage/src/postgres.js", {
    getWorkflowAcceptanceDecision: async (_runId: string, artifact: Record<string, unknown>, gate: any) => storedAcceptanceDecision(client, task.runId, gate, artifact),
    claimNextWorkflowTask: async () => task, startWorkflowTask: async () => {},
    assertWorkflowTaskLease: async (input: any) => {
      assert.equal(input.taskId, task.taskId);
      assert.equal(input.workerId, task.workerId);
      assert.equal(input.fencingToken, task.fencingToken);
      leaseChecks++;
    }, renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async (uri: string) => artifacts.get(uri) ?? null,
    recordRunAction: async (action: any) => {
      const uri = `db://synthetic/${artifacts.size}`;
      const row = { uri, runId: task.runId, taskId: task.taskId, stageId: task.stageId, projectId: frozen.projectId,
        kind: action.artifactKind, content: action.artifactContent, createdAt: new Date().toISOString() };
      artifacts.set(uri, row);
      if (action.idempotencyKey) receipts.set(action.idempotencyKey, row);
      return uri;
    },
    findRunActionByIdempotencyKey: async (input: any) => receipts.get(input.idempotencyKey) ?? null,
    claimSideEffect: async () => ({ status: "claimed", claimToken: "synthetic-claim" }),
    finalizeSideEffect: async () => true, dismissSupersededActionApprovals: async () => {},
    completeWorkflowTask: async (input: any) => {
      assert.equal(input.fencingToken, task.fencingToken);
      const decision = await storedAcceptanceDecision(client, task.runId, "implementation", input.artifact);
      assert.equal(decision.mode, "structured");
      assert.equal(decision.reason, null);
      completed = input;
    },
    blockWorkflowTask: async (input: any) => { blocked = input; },
    failWorkflowTask: async (input: any) => { failed = input; }
  });
  await replace("./stage-authority.js", { createRenewingStageAuthority: async () => async () => {} });
  await replace("./stage-telemetry.js", { createStageTelemetry: () => ({ end() {}, setRoute() {}, event() {} }), flushStageTelemetry: async () => {} });
  await replace("./memory-graph-wiring.js", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
  await replace("./fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
  await replace("../../agent-registry/src/loaders.js", { loadProjectConfig: async () => { throw new Error("Use policy snapshot"); } });
  await replace("../../model-providers/src/routing.js", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "Synthetic fixture" }) });
  await replace("../../model-providers/src/index.js", {
    executeWithProviderFallback: async ({ stageInput }: { stageInput: StageExecutionInput }) => {
      providerCalls++;
      assert.deepEqual(stageInput.acceptanceContract, frozen);
      const row = [...artifacts.values()].find((item) => item.kind === "command_output");
      proposed = structuredClone(frozen);
      if (row) {
        const reference = commandAcceptanceReference(row);
        assert.ok(reference);
        proposed.deliverables[0].status = "delivered";
        proposed.deliverables[0].receipts.implementation = [reference];
        if (process.env.AGENTFLOW_TYPED_WORKER_CASE === "missing") proposed.deliverables[0].receipts.implementation = [];
        if (process.env.AGENTFLOW_TYPED_WORKER_CASE === "stale") reference.subjectHash = "stale-source";
        if (process.env.AGENTFLOW_TYPED_WORKER_CASE === "changed-contract") proposed.deliverables[0].description = "Changed requirement";
      }
      return { output: { outcome: "completed", summary: "Synthetic runtime command evidence reviewed against the enrolled contract.",
        artifact: { acceptanceContract: proposed, findings: ["Runtime evidence is governed and source remains unchanged"], nextAction: "Verify remaining enrolled gates" },
        requestedCommands: row ? [] : ["node --version"], requestedFileWrites: [] },
        attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
    }
  });
  let recoveryReads = 0;
  await replace("./recovery-evidence.js", {
    recoveryEvidence: async (runId: string, projectRootUri: string) => {
      assert.equal(runId, task.runId);
      assert.equal(projectRootUri, task.projectRootUri);
      recoveryReads++;
      return ""; // This synthetic run has no persisted recovery ancestors.
    }
  });
  const { runWorkerOnce } = await import("./executor.js");
  const result = await runWorkerOnce(1, { recoverExpiredLeases: false });
  assert.equal(failed, undefined, JSON.stringify(failed));
  assert.ok(providerCalls >= 2, "Provider consumes executed evidence");
  assert.ok(recoveryReads > 0, "Worker requests scoped recovery context through the isolated boundary");
  assert.ok(leaseChecks > 0, "Worker retains lease checks");
  assert.equal([...artifacts.values()].filter((row) => row.kind === "command_output").length, 1);
  assert.equal(await sourceSubjectHash(root, frozen.sourcePaths!), frozen.subjectHash);
  if (useEnvironment) {
    const command = [...artifacts.values()].find((row) => row.kind === "command_output")!.content;
    assert.equal(command.environment.status, "ready");
    assert.equal(command.environment.runId, task.runId);
    assert.equal(command.environment.taskId, task.taskId);
    assert.match(command.environment.runtimeHash, /^[a-f0-9]{64}$/u);
    assert.ok(command.environment.receiptPath);
    // Runtime availability alone is not a behavioral test collection.
    assert.equal(command.verificationRecipe, undefined);
  }
  const decision = await storedAcceptanceDecision(client, task.runId, "implementation", { acceptanceContract: proposed });
  assert.equal(decision.mode, "structured");
  if (!["valid", "valid-environment"].includes(process.env.AGENTFLOW_TYPED_WORKER_CASE!)) {
    assert.ok(decision.reason);
    assert.equal(result.completed, 0);
    assert.equal(completed, undefined);
    assert.ok(blocked?.reason, "Invalid evidence must block actual worker completion");
    return;
  }
  assert.equal(decision.reason, null, "Governed no-edit evidence meets the immutable structured contract");
  console.log(JSON.stringify({ case: "valid-no-edit", structuredDecision: decision, result, blockedReason: blocked?.reason }));
  assert.equal(result.completed, 1, `Valid structured acceptance must complete: ${blocked?.reason}`);
  assert.ok(completed);
  assert.equal(blocked, undefined);
});

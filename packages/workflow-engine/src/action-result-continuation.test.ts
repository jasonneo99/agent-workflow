import assert from "node:assert/strict";
import test from "node:test";
import { continuationBackoff, continuationRequestedFileReads, continuationMatchesExecutionContract, isVerificationCommand, pendingEvidenceReason, verificationWriteSubject } from "./action-result-continuation.js";
import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test('repaired execution ignores historical cached reads and resumes only its own checkpoint',()=>{
  const current='existing-assignment-repaired:synthetic-run:7';
  assert.equal(continuationMatchesExecutionContract({fileReads:[{path:'old.ts'}]},current),false);
  assert.equal(continuationMatchesExecutionContract({executionContractId:'existing-assignment-repaired:synthetic-run:6'},current),false);
  assert.equal(continuationMatchesExecutionContract({executionContractId:current,fileReads:[{path:'new.ts'}]},current),true);
  assert.equal(continuationMatchesExecutionContract({},undefined),true);
  assert.equal(continuationMatchesExecutionContract({},'ordinary-contract'),true);
});

test("real worker checkpoints and resumes final command results without executing them twice", async (t) => {
  if (!process.env.AGENTFLOW_CONTINUATION_TEST_CHILD) {
    for (const mode of ["command", "read", "checkpoint-read", "checkpoint-missing", "read-command", "read-withdrawal",
      "verification-reuse", "verification-failed", "verification-missing", "verification-truncated"]) {
    // This synthetic fixture owns its provider route. A configured runtime
    // fallback may legitimately add a provider turn before source reads;
    // never let that ambient setting alter these exact command-count cases.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENTFLOW_CONTINUATION_TEST_CHILD: "1", AGENTFLOW_FALLBACK_PROVIDER: "mock" };
    childEnv.AGENTFLOW_CONTINUATION_TEST_MODE = mode;
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], {
      env: childEnv, encoding: "utf8", timeout: 60_000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /CONTINUATION_WORKER_ASSERTIONS_PASSED/);
    }
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
  const mode = process.env.AGENTFLOW_CONTINUATION_TEST_MODE;
  const verificationReuse = mode?.startsWith("verification-") === true;
  const mixedRequests = mode === "read-command" || mode === "read-withdrawal";
  const checkpointSeeded = mode === "checkpoint-read" || mode === "checkpoint-missing";
  const checkpointPath = mode === "checkpoint-missing" ? "missing-continuation-source.txt" : "package.json";
  let checkpoint: Record<string, any> | undefined = checkpointSeeded ? {
    version: 1,
    round: 1,
    actionResults: [],
    fileReads: [],
    stateDeltas: [],
    pendingOutput: { requestedFileReads: [checkpointPath], requestedFileSearches: [] }
  } : undefined;
  let completed: Record<string, any> | undefined;
  let blocked: Record<string, any> | undefined;
  let executions = 0;
  let providerCalls = 0;
  let resumed = checkpointSeeded;
  const sourceOnly = mode === "read" || checkpointSeeded;
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
  const collection = { status: mode === "verification-failed" ? "failed" : "passed", cases: 1,
    passed: mode === "verification-failed" ? 0 : 1, skipped: 0, reason: mode === "verification-failed" ? "Required fixture failed" : null };
  const environment = { schemaVersion: 1, authority: "execution-evidence-only", runId: task.runId, taskId: task.taskId,
    status: "ready", cleanup: "complete", recipeHash: "frozen-recipe", sourceHash: "exact-candidate-source",
    receiptPath: "/synthetic/owned-environment-receipt.json" };
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
    claimNextWorkflowTask: async () => task, startWorkflowTask: async () => {},
    assertWorkflowTaskLease: async () => {}, renewWorkflowTaskLease: async () => true,
    getArtifactByUri: async (uri: string) => uri.endsWith("/continuation")
      ? checkpoint && { runId: task.runId, taskId: task.taskId, content: checkpoint } : artifacts.get(uri),
    recordRunAction: async (action: any) => {
      const uri = action.idempotencyKey ? `db://workflow_runs/${task.runId}/${action.artifactKind}/${action.idempotencyKey}` : `db://synthetic/${artifacts.size}`;
      const content = { ...action.artifactContent, ...(action.idempotencyKey ? { idempotencyKey: action.idempotencyKey } : {}) };
      const row = { uri, runId: task.runId, taskId: task.taskId, kind: action.artifactKind, createdAt: new Date().toISOString(), content };
      artifacts.set(uri, row);
      if (action.idempotencyKey) receipts.set(action.idempotencyKey, row);
      return uri;
    },
    findRunActionByIdempotencyKey: async (input: any) => {
      assert.equal(input.runId, task.runId); assert.equal(input.artifactKind, "command_output");
      const row = receipts.get(input.idempotencyKey);
      if (!row) return null;
      assert.equal(row.content.idempotencyKey, input.idempotencyKey);
      assert.equal(row.content.requestedByTaskId, task.taskId); assert.equal(row.content.requestedByStageId, task.stageId);
      if (mode !== "verification-missing") return row;
      const content = { ...row.content }; delete content.verificationRecipe;
      return { ...row, content };
    },
    claimSideEffect: async () => ({ status: "claimed", claimToken: "fixture-claim" }),
    finalizeSideEffect: async () => true, dismissSupersededActionApprovals: async () => {},
    requestActionApproval: async () => { throw new Error("Unexpected approval boundary"); },
    checkpointWorkflowTaskContinuation: async (input: any) => { checkpoint = JSON.parse(JSON.stringify(input.continuation)); },
    completeWorkflowTask: async (input: any) => { completed = input; },
    blockWorkflowTask: async (input: any) => { if (verificationReuse) blocked = input; else throw new Error(`Unexpected block: ${input.reason}`); },
    failWorkflowTask: async (input: any) => { throw new Error(`Unexpected failure: ${JSON.stringify(input)}`); }
  });
  await replace("./stage-authority.js", { createRenewingStageAuthority: async () => async () => {} });
  await replace("./stage-telemetry.js", { createStageTelemetry: () => ({ end() {}, setRoute() {} }), flushStageTelemetry: async () => {} });
  await replace("./memory-graph-wiring.js", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
  await replace("./recovery-evidence.js", { recoveryEvidence: async () => "" });
  await replace("./fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
  await replace("../../agent-registry/src/loaders.js", { loadProjectConfig: async () => { throw new Error("Use snapshot"); } });
  await replace("../../model-providers/src/routing.js", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "fixture" }) });
  await replace("../../local-tools/src/command-executor.js", {
    assertCommandAllowed: () => {}, commandSerializationResource: () => null,
    executeAllowedCommand: async ({ commandLine }: any) => {
      executions++;
      return { commandLine, cwd: process.cwd(), exitCode: 0, stdout: "retained-final-evidence", stderr: "", timedOut: false, signal: null, durationMs: 1,
        ...(verificationReuse ? { verificationRecipe: collection, environment, outputTruncated: mode === "verification-truncated" } : {}) };
    }
  });
  await replace("../../local-tools/src/file-reader.js", {
    executeAllowedFileRead: async ({ relativePath }: any) => {
      if (relativePath === "missing-continuation-source.txt") throw new Error("File not found: missing-continuation-source.txt");
      return { relativePath, content: '{"name":"fixture"}', bytesRead: 18, truncated: false, sha256: "fixture-hash" };
    }
  });
  await replace("../../model-providers/src/index.js", {
    executeWithProviderFallback: async ({ stageInput }: any) => {
      providerCalls++;
      if (verificationReuse) {
        if (providerCalls > 1) assert.equal(executions, 1, "Repeating the same observed verification cannot execute it twice");
        const command = "node --test tests/frozen.test.mjs";
        return { output: { summary: "Actual fixture verification evidence reviewed.", artifact: { findings: ["Fixture check observed"] },
          requestedCommands: mode === "verification-failed" ? (providerCalls === 1 ? [command, command] : []) : providerCalls < 3 ? [command] : [] },
          attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
      }
      if (mixedRequests) {
        if (providerCalls === 1) return { output: {summary:"Inspect before selecting the command.",artifact:{},requestedFileReads:["package.json"],requestedCommands:["node --version observation-readable"]},attempts:[],actualProvider:"mock",actualModel:"mock",fallbackUsed:false};
        if (providerCalls === 2) {
          assert.equal(executions,0,"Reading source must not execute the earlier command implicitly");
          assert.ok(stageInput.fileReads.some((read:any)=>read.path==='package.json'));
          const receipt=stageInput.priorReceipts.find((receipt:any)=>receipt.actionType==='read_round_action_state');
          assert.ok(receipt,"The provider must know the previous command request has not executed or been queued");
          const state=JSON.parse(receipt.summary.slice(receipt.summary.indexOf('\n')+1));
          assert.deepEqual(state.unexecutedCommands,["node --version observation-readable"]);
          assert.equal(state.newEffectsDuringReadStep,false);
          return {output:{summary:"Read evidence consumed; select the next allowed action.",artifact:{findings:["Source inspected"]},requestedCommands:mode==='read-withdrawal'?[]:["node --version observation-readable"]},attempts:[],actualProvider:"mock",actualModel:"mock",fallbackUsed:false};
        }
        assert.equal(executions,1,"An explicitly restated command executes only once");
        assert.ok(stageInput.priorReceipts.some((receipt:any)=>receipt.summary.includes('retained-final-evidence')));
        return {output:{summary:"Actual command evidence consumed.",artifact:{findings:["Source and command inspected"]},requestedCommands:[]},attempts:[],actualProvider:"mock",actualModel:"mock",fallbackUsed:false};
      }
      if (sourceOnly) {
        if (resumed) {
          assert.ok(stageInput.fileReads.length > 0, "Source observations survive checkpoint");
          assert.ok(stageInput.priorReceipts.some((receipt: any) => receipt.actionType === "stage_continuation_resumed"));
          const supplied = stageInput.fileReads.find((read: any) => read.path === checkpointPath);
          if (mode === "checkpoint-missing") assert.match(supplied?.error ?? "", /not found|ENOENT|does not exist/i);
          if (mode === "checkpoint-read") assert.ok(supplied?.content.includes('"name"'), "Checkpointed source request is fulfilled before the resumed provider turn");
        }
        return { output: { summary: "Source evidence inspected for the fixture.", artifact: { findings: ["Source inspection"] },
          requestedFileReads: resumed ? [] : ["package.json"], requestedCommands: [] },
          attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
      }
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
  if (verificationReuse) {
    assert.equal(executions, 1); assert.equal(providerCalls, mode === "verification-failed" ? 2 : 3);
    assert.equal(checkpoint, undefined, "Complete reused observations need no extra continuation");
    const successful = mode === "verification-reuse";
    assert.equal(first.completed, successful ? 1 : 0);
    assert.equal(Boolean(completed), successful); assert.equal(Boolean(blocked), !successful);
    const final = (completed ?? blocked)!;
    const reused = final.artifact.actionResults.filter((action: any) => action.type === "local_command_reused");
    assert.equal(reused.length, 1);
    assert.deepEqual(reused[0].environment, environment, "Retain the exact source-bound environment observation");
    assert.deepEqual(reused[0].verificationRecipe, mode === "verification-missing" ? undefined : collection);
    assert.equal(reused[0].outputTruncated, mode === "verification-truncated");
    assert.ok(artifacts.get(reused[0].artifactUri), "Reuse refers to the stored original command receipt");
    if (!successful) assert.match(blocked!.reason, mode === "verification-truncated" ? /truncated output/u : /declared test collection is incomplete or failed/u);
    console.log("CONTINUATION_WORKER_ASSERTIONS_PASSED");return;
  }
  if(mixedRequests){
    assert.equal(first.completed,1);assert.equal(executions,mode==='read-withdrawal'?0:1);
    assert.equal(checkpoint,undefined,"Request-state clarification consumes no retry or extra continuation");
    console.log("CONTINUATION_WORKER_ASSERTIONS_PASSED");return;
  }
  if (checkpointSeeded) {
    assert.equal(first.completed, 1);
    assert.equal(providerCalls, 1, "Checkpoint evidence is fulfilled before the first resumed provider turn");
    console.log("CONTINUATION_WORKER_ASSERTIONS_PASSED");
    return;
  }
  assert.equal(first.completed, 0, "Exhausted followup budget is not completion");
  assert.equal(completed, undefined);
  assert.equal(checkpoint?.round, 1);
  if (sourceOnly) {
    assert.equal(executions, 0);
    resumed = true;
    assert.equal((await runWorkerOnce(1, { recoverExpiredLeases: false })).completed, 1);
    console.log("CONTINUATION_WORKER_ASSERTIONS_PASSED");
    return;
  }
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

test("JSONB object key ordering is not counted as progress", () => {
  const prior = continuationBackoff({}, [{ commandLine: "npm test", result: { stdout: "ok", exitCode: 0 } }]);
  const next = continuationBackoff(prior, [{ result: { exitCode: 0, stdout: "ok" }, commandLine: "npm test" }]);
  assert.equal(next.progressFingerprint, prior.progressFingerprint);
  assert.equal(next.delaySeconds, 10);
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
  assert.match(pendingEvidenceReason({ ...output, requestedFileReads: ["missing.ts"] }, [
    { path: "missing.ts", content: "", truncated: false, error: "File not found" }
  ]) ?? "", /unavailable: missing\.ts: File not found/);
  assert.match(pendingEvidenceReason({ ...output, requestedFileReads: ["src/example.ts"] }, [
    { path: "src/example.ts", content: "export {};", truncated: false, sha256: "abc" }
  ]) ?? "", /supplied but not consumed/);
});

test("checkpointed source requests are normalized and deduplicated", () => {
  assert.deepEqual(continuationRequestedFileReads({ pendingOutput: {
    requestedFileReads: ["./src/example.ts", "src/example.ts", "src/other.ts#L1-L20", ""]
  } }), ["src/example.ts", "src/other.ts#L1-L20"]);
  assert.deepEqual(continuationRequestedFileReads({ pendingOutput: null }), []);
});

test("verification identity changes after the latest governed write", () => {
  const before = verificationWriteSubject([{ type: "file_write", path: "src/example.ts", nextHash: "before" }]);
  const after = verificationWriteSubject([
    { type: "file_write", path: "src/example.ts", nextHash: "before" },
    { type: "file_write", path: "src/example.ts", nextHash: "after" }
  ]);
  assert.ok(before);
  assert.ok(after);
  assert.notEqual(after, before, "A pre-latest-change verification artifact cannot keep the same idempotency subject");
  assert.equal(verificationWriteSubject([{ type: "file_read", path: "src/example.ts" }]), undefined);
});

test("project-native verification commands bind to governed postimages", () => {
  assert.equal(isVerificationCommand("python3 -m unittest discover -s tests"), true);
  assert.equal(isVerificationCommand("python3 -m compileall -q roles/example/files"), true);
  assert.equal(isVerificationCommand("git diff --check"), true);
  assert.equal(isVerificationCommand("xcrun swiftc main.swift -o app"), true);
  assert.equal(isVerificationCommand("npm run agentflow -- status --run example"), false);
});

test("already-allowed Node test bootstrap recipes remain verification, never shell or loader authority", () => {
  const recipe = 'env AGENTFLOW_QUEUE_LINEAGE_PG_TEST=1 node --import ./scripts/test-environment.mjs --import tsx --test packages/storage/src/queue-lineage.test.ts';
  assert.equal(isVerificationCommand(recipe), true);
  assert.equal(isVerificationCommand('node --import tsx --test source.test.ts'), true);
  for (const command of ['env NODE_OPTIONS=--inspect node --test source.test.ts', 'env LD_PRELOAD=module node --test source.test.ts',
    'env PATH=other node --test source.test.ts', 'env FLAG=1 node --import tsx -e code',
    'node --import tsx script.ts', 'node --import tsx --eval code --test source.test.ts', recipe + '; other', recipe + '\nother']) {
    assert.equal(isVerificationCommand(command), false, command);
  }
});

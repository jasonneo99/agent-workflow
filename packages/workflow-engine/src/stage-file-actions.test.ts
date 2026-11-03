import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StageFileWriteState } from "./stage-file-actions.js";

const scenarios = ["write-and-reuse", "approval-boundaries", "lost-authority", "patch-retry", "replacement-reroute", "reader-observations"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("stage file actions preserve governed effects and caller-owned retry state", async t => {
  const scenario = process.env.AGENTFLOW_STAGE_FILE_ACTION_CASE;
  if (!scenario) {
    for (const name of scenarios) await t.test(name, () => {
      // The child receives no ambient database, model, credential or auth configuration.
      const env: NodeJS.ProcessEnv = { AGENTFLOW_STAGE_FILE_ACTION_CASE: name };
      for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SystemRoot", "WINDIR"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], {
        env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024
      });
      const output = child.stdout + child.stderr;
      const observation = output.split("\n").find(line => line.includes("STAGE_FILE_ACTION_OBSERVATION"));
      if (observation) console.log(observation);
      assert.equal(child.status, 0, name + ": " + output.slice(-3000));
    });
    return;
  }
  assert.ok(scenarios.includes(scenario));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-stage-file-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  process.env.AGENTFLOW_FLEET_USAGE_LEDGER = path.join(root, "usage.jsonl");
  process.env.AGENTFLOW_FLEET_CLIENT_ID = "synthetic-stage-file-client";
  await fs.mkdir(path.join(root, "src"));
  const target = "src/target.txt", before = "before\n", after = "after\n";
  await fs.writeFile(path.join(root, target), before);
  const records: any[] = [], approvals: any[] = [], claims: any[] = [], finalized: any[] = [], locks: any[] = [];
  const events: string[] = [], providerCalls: any[] = [], scoredOutputs: any[] = [];
  const writes = new Map<string, { uri: string; content: Record<string, unknown> }>();
  let leaseCalls = 0, loseLease = false, loseGuard = false;
  const replaceBoundary = async (relative: string, overrides: Record<string, unknown>) => {
    const url = new URL(relative, import.meta.url).href;
    const original = await import(url);
    const defaults = Object.fromEntries(Object.entries(original).map(([name, value]) => [name, typeof value === "function"
      ? () => { throw new Error("Unmocked external boundary: " + name); } : value]));
    t.mock.module(url, { namedExports: { ...defaults, ...overrides } });
  };
  await replaceBoundary("../../storage/src/client.js", {});
  await replaceBoundary("../../storage/src/postgres.js", {
    findRunActionByIdempotencyKey: async ({ idempotencyKey }: any) => writes.get(idempotencyKey) ?? null,
    recordRunAction: async (input: any) => {
      const uri = `db://synthetic/stage-file/${records.length + 1}`;
      records.push({ ...input, uri }); events.push("record:" + input.actionType);
      if (input.actionType === "file_write") {
        const current = await fs.readFile(path.join(root, input.target), "utf8");
        assert.equal(input.artifactContent.nextHash, digest(current));
        writes.set(input.idempotencyKey, { uri, content: input.artifactContent });
      }
      return uri;
    },
    requestActionApproval: async (input: any) => {
      approvals.push(input); events.push("approval");
      return { approvalId: `synthetic-approval-${approvals.length}`, artifactUri: "db://synthetic/approval", status: "pending" };
    },
    claimSideEffect: async (input: any) => {
      claims.push(input); events.push("claim");
      return { status: "claimed", claimToken: "synthetic-claim-" + claims.length };
    },
    withProjectExecutionLock: async (input: any, operation: () => Promise<unknown>) => {
      locks.push(input); events.push("lock"); return operation();
    },
    finalizeSideEffect: async (input: any) => {
      finalized.push(input); events.push("finalize");
      assert.equal(input.claimToken, "synthetic-claim-" + claims.length);
      assert.equal(input.receipt.nextHash, digest(await fs.readFile(path.join(root, input.receipt.path), "utf8")));
      return true;
    },
    dismissSupersededActionApprovals: async () => { events.push("dismiss"); }
  });
  let providerResult: any;
  await replaceBoundary("../../model-providers/src/index.js", {
    executeWithProviderFallback: async (input: any) => {
      providerCalls.push(input); events.push("provider");
      assert.ok(providerResult, "No provider call is permitted outside a prepared correction");
      return providerResult;
    }
  });
  const { projectConfigSchema } = await import("../../agent-registry/src/schemas.js");
  const { scoreStageOutput } = await import("../../model-providers/src/quality.js");
  const { createStageFileReader, executeStageFileWrites } = await import("./stage-file-actions.js");
  const project = projectConfigSchema.parse({
    project: { name: "Synthetic stage file project" },
    policies: { require_approval_for_external_actions: scenario === "approval-boundaries" },
    actions: { allowed_write_paths: ["src/**"], allowed_read_paths: ["src/**"], max_write_bytes: scenario === "replacement-reroute" ? 80 : 1024 }
  });
  const policyBefore = JSON.stringify(project);
  const task: any = {
    runId: "synthetic-file-run", taskId: "synthetic-file-task", stageId: "implement", workerId: "synthetic-worker",
    agentId: "implementation-agent", agentName: "Synthetic implementer", agentPrompt: "Use governed fixture files",
    workflowId: "synthetic-workflow", workflowTask: "Update a bounded fixture", stageGoal: "Update a bounded fixture",
    compiledBrief: "Synthetic file action fixture", projectRootUri: root, priorReceipts: [], priorStageArtifacts: []
  };
  const stagePattern: any = { type: "react", maxIterations: 20, requiresVerifier: false, promotionGate: "none", stopConditions: [] };
  const stageFileReads: any[] = [], stageStateDeltas: any[] = [], actionResults: any[] = [];
  const routedStageInput: any = { ...task, projectConfig: project, stagePattern };
  const output = (requestedFileWrites: any[]) => ({
    outcome: "completed" as const, summary: "Synthetic bounded file work", artifact: { findings: ["Synthetic evidence"], nextAction: "Verify the fixture" },
    requestedCommands: [], requestedFileWrites
  });
  const initialOutput = output([{ path: target, content: after }]);
  const initialAttempts: any[] = [{ provider: "mock", model: "initial-model", attempt: 1, attemptId: "synthetic-initial", outcome: "completed" }];
  const state: StageFileWriteState = {
    output: initialOutput, quality: scoreStageOutput(routedStageInput, initialOutput), fallbackAttempts: initialAttempts,
    actualProviderId: "mock", actualModel: "initial-model", mutationRetriesRemaining: 1, reactIteration: 3
  };
  const fallbackPolicy = { chains: { "codex-cli": [{ provider: "mock" }] }, maxRetries: 2, circuitFailureThreshold: 3, circuitCooldownMs: 1000, allowQuotaFallback: false };
  const guardedProviderFactory: any = () => { throw new Error("The provider boundary must remain intercepted"); };
  const input = {
    task, project, stagePattern, localProjectRootUri: root, actionResults, stageFileReads, stageStateDeltas, state,
    totalRequestedActions: 2, route: { providerId: "codex-cli" }, routedStageInput, fallbackPolicy, guardedProviderFactory,
    assertLeaseOwned: async () => { leaseCalls++; events.push("lease"); if (loseLease) throw new Error("synthetic lease lost"); },
    assertStageGuard: async (sideEffect: boolean) => { events.push("guard:" + sideEffect); if (loseGuard) throw new Error("synthetic authority lost"); },
    preparation: { beforeWrite: async (relative: string) => { assert.equal(relative, target); events.push("before-write"); } } as any,
    scoreOutput: (next: any) => { const quality = scoreStageOutput(routedStageInput, next); scoredOutputs.push({ next, quality }); return quality; }
  };
  const assertRetained = (next: StageFileWriteState, iteration: number) => {
    assert.equal(next.output, state.output); assert.equal(next.quality, state.quality);
    assert.equal(next.fallbackAttempts, initialAttempts); assert.equal(next.actualProviderId, "mock");
    assert.equal(next.actualModel, "initial-model"); assert.equal(next.mutationRetriesRemaining, 1); assert.equal(next.reactIteration, iteration);
  };
  const prepareProviderResult = (next: ReturnType<typeof output>) => {
    providerResult = { output: next, actualProvider: "codex-cli", actualModel: "corrected-model", requestedProvider: "codex-cli", fallbackUsed: false,
      attempts: [{ provider: "codex-cli", model: "corrected-model", attempt: 1, attemptId: "synthetic-correction", outcome: "completed" }] };
  };
  const assertCorrection = async (result: Awaited<ReturnType<typeof executeStageFileWrites>>) => {
    assert.equal(result.retryRequested, true); assert.equal(result.state.mutationRetriesRemaining, 0);
    assert.equal(result.state.reactIteration, 4); assert.equal(result.state.output, providerResult.output);
    assert.deepEqual(result.state.fallbackAttempts, [...initialAttempts, ...providerResult.attempts]);
    assert.equal(result.state.actualProviderId, "codex-cli"); assert.equal(result.state.actualModel, "corrected-model");
    assert.equal(scoredOutputs.length, 1); assert.equal(scoredOutputs[0].next, providerResult.output);
    assert.equal(result.state.quality, scoredOutputs[0].quality);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].providerFactory, guardedProviderFactory);
    assert.equal(providerCalls[0].providerId, "codex-cli");
    assert.deepEqual(providerCalls[0].policy, { ...fallbackPolicy, chains: {}, maxRetries: 0 });
    assert.equal(providerCalls[0].stageInput.fileReads, stageFileReads);
    assert.equal(providerCalls[0].stageInput.stateDeltas, stageStateDeltas);
    assert.equal(providerCalls[0].stageInput.taskId, task.taskId);
    const ledger = (await fs.readFile(process.env.AGENTFLOW_FLEET_USAGE_LEDGER!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(ledger.length, 1); assert.equal(ledger[0].runId, task.runId); assert.equal(ledger[0].model, "corrected-model");
    assert.equal(ledger[0].id, "direct:synthetic-correction");
  };

  if (scenario === "write-and-reuse") {
    const first = await executeStageFileWrites(input);
    assert.equal(first.retryRequested, false); assertRetained(first.state, 4);
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), after);
    assert.equal(claims.length, 1); assert.equal(finalized.length, 1); assert.equal(locks.length, 1);
    assert.equal(claims[0].projectId, task.runId); assert.equal(claims[0].operation, "file_write");
    assert.equal(finalized[0].idempotencyKey, claims[0].idempotencyKey);
    assert.deepEqual(locks[0], { projectRootUri: root, resource: "file:" + target });
    for (const [earlier, later] of [["guard:true", "before-write"], ["before-write", "claim"], ["claim", "lock"], ["lock", "record:file_write"], ["record:file_write", "finalize"], ["finalize", "dismiss"]]) {
      assert.ok(events.indexOf(earlier) < events.indexOf(later), earlier + " precedes " + later);
    }
    const written = records.find(record => record.actionType === "file_write");
    assert.equal(written.artifactContent.previousHash, digest(before)); assert.equal(written.artifactContent.nextHash, digest(after));
    assert.equal(written.artifactContent.requestedByTaskId, task.taskId);
    assert.equal(actionResults[0].nextHash, digest(after));
    const stat = await fs.stat(path.join(root, target), { bigint: true });
    const second = await executeStageFileWrites({ ...input, state: first.state });
    assert.equal(second.retryRequested, false); assertRetained(second.state, 5);
    assert.equal(claims.length, 1); assert.equal(finalized.length, 1); assert.equal(locks.length, 1);
    assert.equal((await fs.stat(path.join(root, target), { bigint: true })).mtimeNs, stat.mtimeNs);
    assert.equal(actionResults[1].type, "file_write_reused"); assert.equal(actionResults[1].artifactUri, written.uri);
    assert.equal(actionResults[1].nextHash, digest(after));
    assert.deepEqual(records.filter(record => record.actionType === "react_loop_step").map(record => record.artifactContent.iteration), [4, 5]);
  } else if (scenario === "approval-boundaries") {
    state.output = output([{ path: "outside/denied.txt", content: after }, { path: target, content: after }]);
    const result = await executeStageFileWrites(input);
    assert.equal(result.retryRequested, false); assertRetained(result.state, 5);
    assert.deepEqual(approvals.map(approval => approval.actionType), ["project_policy_change", "file_write"]);
    assert.equal(approvals[0].target, "actions.allowed_write_paths:outside/denied.txt");
    assert.equal(approvals[1].target, target); assert.equal(approvals[1].payload.canonicalProjectRoot, root);
    assert.equal(approvals[1].payload.payloadHash, digest(after));
    assert.deepEqual(actionResults.map(action => action.type), ["project_policy_change_approval_pending", "file_write_approval_pending"]);
    assert.equal(claims.length, 0); assert.equal(locks.length, 0); assert.equal(finalized.length, 0);
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), before);
    await assert.rejects(fs.stat(path.join(root, "outside/denied.txt")), { code: "ENOENT" });
  } else if (scenario === "lost-authority") {
    loseLease = true;
    await assert.rejects(executeStageFileWrites(input), /synthetic lease lost/);
    const reader = createStageFileReader(input);
    await assert.rejects(reader.fulfillFileReadRequests([target], 1), /synthetic lease lost/);
    assert.equal(records.length, 0); assert.equal(stageFileReads.length, 0);
    loseLease = false; loseGuard = true;
    await assert.rejects(executeStageFileWrites(input), /synthetic authority lost/);
    assert.equal(claims.length, 0); assert.equal(locks.length, 0); assert.equal(finalized.length, 0);
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), before);
  } else if (scenario === "patch-retry") {
    const rejectedPatch = "@@ -1 +1 @@\n-not-the-preimage\n+after\n";
    state.output = output([{ path: target, content: null, patch: rejectedPatch, expectedHash: digest(before) }, { path: "src/stale.txt", content: "must not run" }]);
    prepareProviderResult(output([]));
    const result = await executeStageFileWrites(input);
    await assertCorrection(result);
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), before);
    await assert.rejects(fs.stat(path.join(root, "src/stale.txt")), { code: "ENOENT" });
    assert.equal(stageFileReads[0].sha256, digest(before)); assert.equal(stageFileReads[0].content, before);
    assert.match(stageStateDeltas[0].fact, /previous patch was rejected and not applied/);
    assert.ok(records.some(record => record.actionType === "file_write_retry_superseded"));
    const resumed = await executeStageFileWrites({ ...input, state: result.state });
    assert.equal(resumed.retryRequested, false); assert.equal(resumed.state.reactIteration, 4);
    assert.equal(claims.length, 1, "The caller must consume the replacement output, not replay the rejected patch");
    const exhaustedOutput = output([{ path: target, content: null, patch: rejectedPatch.replace("after", "another"), expectedHash: digest(before) }]);
    const exhausted = await executeStageFileWrites({ ...input, state: { ...result.state, output: exhaustedOutput } });
    assert.equal(exhausted.retryRequested, false); assert.equal(exhausted.state.mutationRetriesRemaining, 0);
    assert.equal(providerCalls.length, 1, "Exhausted mutation budget cannot invoke the provider again");
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), before);
  } else if (scenario === "replacement-reroute") {
    state.output = output([{ path: target, content: "x".repeat(200) }, { path: "src/stale.txt", content: "must not run" }]);
    prepareProviderResult(output([{ path: target, content: null, patch: "@@ -1 +1 @@\n-before\n+after\n", expectedHash: digest(before) }]));
    const result = await executeStageFileWrites(input);
    await assertCorrection(result);
    assert.equal(claims.length, 0); assert.equal(approvals.length, 0);
    assert.equal(stageFileReads[0].path, target + "#L1-L100"); assert.equal(stageFileReads[0].sha256, digest(before));
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), before);
    assert.ok(records.some(record => record.actionType === "file_write_patch_reroute" && record.artifactContent.policyUnchanged));
    const resumed = await executeStageFileWrites({ ...input, state: result.state });
    assert.equal(resumed.retryRequested, false); assert.equal(resumed.state.reactIteration, 5);
    assert.equal(resumed.state.mutationRetriesRemaining, 0); assert.equal(resumed.state.actualModel, "corrected-model");
    assert.equal(resumed.state.quality, result.state.quality); assert.deepEqual(resumed.state.fallbackAttempts, result.state.fallbackAttempts);
    assert.equal(await fs.readFile(path.join(root, target), "utf8"), after);
    await assert.rejects(fs.stat(path.join(root, "src/stale.txt")), { code: "ENOENT" });
    assert.equal(providerCalls.length, 1); assert.equal(claims.length, 1); assert.equal(finalized.length, 1);
  } else {
    await fs.writeFile(path.join(root, ".env"), "synthetic forbidden content");
    await fs.writeFile(path.join(root, "src/next.txt"), "next\n");
    const reader = createStageFileReader(input);
    assert.equal(await reader.fulfillFileReadRequests([target, "./" + target, target.replaceAll("/", "\\"), "src/missing.txt", ".env"], 5), 3);
    assert.equal(await reader.fulfillFileReadRequests([target, "src/missing.txt", ".env", "src/next.txt"], 4), 1);
    assert.equal(stageFileReads.length, 4); assert.equal(stageStateDeltas.length, 4);
    assert.equal(stageFileReads[0].sha256, digest(before)); assert.equal(stageFileReads[0].content, before);
    assert.match(stageFileReads[1].error, /no such file/); assert.match(stageFileReads[2].error, /blocked path pattern/);
    assert.equal(stageFileReads[3].content, "next\n"); assert.equal(reader.seenReadPaths.size, 4);
    assert.deepEqual(actionResults.map(action => action.type), ["file_read", "file_read_rejected", "file_read_rejected", "file_read"]);
    assert.deepEqual(records.filter(record => record.actionType === "react_loop_step").map(record => record.artifactContent.iteration), [1, 2, 3, 4]);
    assert.ok(!JSON.stringify(records).includes("synthetic forbidden content"));
    assert.equal(claims.length, 0); assert.equal(providerCalls.length, 0);
  }
  assert.equal(JSON.stringify(project), policyBefore, "Effects and recovery never widen the project policy");
  assert.equal(state.mutationRetriesRemaining, 1, "Updated state must be returned explicitly to the owning loop");
  if (!scenario.includes("retry") && !scenario.includes("reroute")) assert.equal(providerCalls.length, 0);
  console.log("STAGE_FILE_ACTION_OBSERVATION " + JSON.stringify({ scenario, leaseCalls, records: records.length, claims: claims.length, finalized: finalized.length, providers: providerCalls.length }));
});

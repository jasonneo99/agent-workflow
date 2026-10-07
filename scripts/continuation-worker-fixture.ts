/** Invoked only by test-continuation-postgres.ts inside its disposable database. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { projectConfigSchema } from "../packages/agent-registry/src/schemas.js";
import * as storage from "../packages/storage/src/postgres.js";
import type { StageExecutionInput } from "../packages/model-providers/src/types.js";
import { acceptanceDigest, enrollAcceptanceContract } from "../packages/storage/src/acceptance.js";
import { commandAcceptanceReference } from "../packages/storage/src/command-evidence.js";
import { sourceSubjectHash } from "../packages/workflow-engine/src/source-subject.js";

const agentId = "live-continuation-worker";
const workflowId = "live-continuation-fixture";
const command = (round: number) => `node --version observation-${round}`;

function assertDisposable(): void {
  assert.match(new URL(databaseUrl()).pathname.slice(1), /^agentflow_continuation_test_[a-f0-9]{32}$/);
}

test("real workers consume durable continuation across processes", async (t) => {
  assertDisposable();
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const childMode = process.env.AGENTFLOW_LIVE_FIXTURE_MODE;
    if (childMode) {
      assert.ok(["initial", "consume", "repeat", "downstream"].includes(childMode));
      const taskId = process.env.AGENTFLOW_LIVE_FIXTURE_TASK!;
      const runId = process.env.AGENTFLOW_LIVE_FIXTURE_RUN!;
      assert.match(taskId, /^[a-f0-9-]{36}$/);
      assert.match(runId, /^[a-f0-9-]{36}$/);
      const saved = await storage.getArtifactByUri(`db://workflow_tasks/${taskId}/continuation`);
      let calls = 0;
      const replace = async (relative: string, overrides: Record<string, unknown>) => {
        const url = new URL(relative, import.meta.url).href;
        const original = await import(url);
        t.mock.module(url, { namedExports: { ...original, ...overrides } });
      };
      await replace("../packages/agent-registry/src/loaders.js", {
        loadProjectConfig: async () => { throw new Error("Use synthetic policy snapshot"); }
      });
      await replace("../packages/workflow-engine/src/stage-telemetry.js", {
        createStageTelemetry: () => ({ end() {}, setRoute() {}, event() {} }),
        flushStageTelemetry: async () => {}
      });
      await replace("../packages/workflow-engine/src/memory-graph-wiring.js", {
        buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {}
      });
      await replace("../packages/workflow-engine/src/fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
      await replace("../packages/model-providers/src/routing.js", {
        selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "Synthetic acceptance" })
      });
      const commands = await import("../packages/local-tools/src/command-executor.js");
      await replace("../packages/local-tools/src/command-executor.js", {
        executeAllowedCommand: async (input: Parameters<typeof commands.executeAllowedCommand>[0]) => {
          assert.ok([1, 2, 3, 4].map(command).includes(input.commandLine));
          await client.query("insert into continuation_fixture_executions(task_id,command_line) values ($1,$2)", [taskId, input.commandLine]);
          return commands.executeAllowedCommand(input);
        }
      });
      await replace("../packages/model-providers/src/index.js", {
        executeWithProviderFallback: async ({ stageInput }: { stageInput: StageExecutionInput }) => {
          calls++;
          assert.equal(stageInput.taskId, taskId);
          const row = (await client.query("select status,output_uri,finished_at from workflow_tasks where id=$1", [taskId])).rows[0];
          assert.deepEqual(row, { status: "running", output_uri: null, finished_at: null });
          if (childMode === "consume" || childMode === "repeat") {
            assert.ok(saved);
            const resume = stageInput.priorReceipts.findLast((receipt) => receipt.actionType === "stage_continuation_resumed");
            assert.ok(resume, "Fresh provider must receive the retained final result");
            const retained = JSON.parse(resume.summary.slice(resume.summary.indexOf("\n") + 1));
            assert.deepEqual(retained.actionResults, saved.content.actionResults);
            assert.deepEqual(stageInput.stateDeltas, saved.content.stateDeltas);
            assert.deepEqual(stageInput.fileReads, saved.content.fileReads);
            assert.ok((saved.content.actionResults as Array<Record<string, unknown>>).some((action) => action.commandLine === command(4) && action.exitCode === 0));
            assert.ok(stageInput.stateDeltas!.length > 0);
            assert.ok(stageInput.priorReceipts.some((receipt) => receipt.summary.includes(command(4)) && /v\d+\./.test(receipt.summary)));
            if (calls === 1) {
              const previous = (await client.query("select metadata from action_receipts where run_id=$1 and action_type='stage_continuation_scheduled' order by created_at desc limit 1", [runId])).rows[0].metadata;
              const stale = { runId, taskId, agentId, workerId: process.env.AGENTFLOW_LIVE_FIXTURE_PREVIOUS_WORKER!, fencingToken: previous.fencingToken };
              await assert.rejects(storage.assertWorkflowTaskLease(stale), /Stale workflow/);
              await assert.rejects(storage.checkpointWorkflowTaskContinuation({ ...stale, continuation: saved.content, delaySeconds: 5 }), /Stale workflow/);
              await assert.rejects(storage.completeWorkflowTask({ ...stale, summary: "Stale completion", artifact: {} }), /Stale workflow/);
              assert.equal(await storage.renewWorkflowTaskLease(stale), false);
              await storage.recordRunAction({ runId, taskId, agentId, actionType: "fixture_continuation_consumed", target: taskId,
                summary: "Fresh process consumed retained final results and state before completion; stale worker rejected.",
                artifactKind: "fixture_consumption", artifactContent: { round: saved.content.round, pid: process.pid } });
            }
          }
          const acceptanceContract = stageInput.acceptanceContract && structuredClone(stageInput.acceptanceContract);
          if (childMode === "downstream") {
            assert.ok(acceptanceContract);
            const prior = await client.query("select a.content from artifacts a join workflow_tasks t on t.id=a.task_id where a.run_id=$1 and a.kind='stage_output' and t.stage_id='inspect'", [runId]);
            assert.equal(prior.rows.length, 1);
            const proposal = structuredClone(prior.rows[0].content.acceptanceContract);
            const preflight = await storage.preflightWorkflowAcceptance(runId, { acceptanceContract: proposal });
            assert.equal(preflight.accepted, true, JSON.stringify(preflight));
            const original = proposal.deliverables[0].receipts.implementation[0];
            const recorded = (await client.query("select content from artifacts where uri=$1 and run_id=$2", [original.artifactUri, runId])).rows[0];
            assert.ok(recorded);
            const failedContent = { ...recorded.content, commandLine: `synthetic-failed-check-${taskId}`, exitCode: 1, timedOut: false };
            const failedUri = `db://workflow_runs/${runId}/command_output/synthetic-failed-${taskId}`;
            const failedRow = (await client.query("insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'command_output',$3,$4) returning created_at", [runId, taskId, failedUri, JSON.stringify(failedContent)])).rows[0];
            const failedReference = commandAcceptanceReference({ uri: failedUri, runId, taskId, stageId: stageInput.stageId, content: failedContent, createdAt: failedRow.created_at });
            assert.ok(failedReference);
            for (const control of ["missing", "failed", "stale", "cross-run"] as const) {
              const invalid = structuredClone(proposal);
              for (const gate of invalid.deliverables[0].requiredGates) {
                if (control === "missing") invalid.deliverables[0].receipts[gate] = [];
                else if (control === "failed") invalid.deliverables[0].receipts[gate] = [failedReference];
                else {
                  const reference = invalid.deliverables[0].receipts[gate][0];
                  if (control === "stale") reference.subjectHash = acceptanceDigest("stale synthetic source");
                  else reference.runId = randomUUID();
                }
              }
              const rejected = await storage.preflightWorkflowAcceptance(runId, { acceptanceContract: invalid });
              assert.equal(rejected.accepted, false);
              assert.ok(rejected.decisions.every((decision) => decision.mode === "structured" && Boolean(decision.reason)), control);
              await storage.recordRunAction({ runId, taskId, agentId, actionType: "fixture_negative_preflight", target: control,
                summary: `Synthetic ${control} evidence rejected across all acceptance gates.`,
                artifactKind: "fixture_negative_preflight", artifactContent: rejected });
            }
            if (stageInput.stageId === "supervise") {
              const { workflowRepairLesson } = await import("../apps/cli/src/workflow-supervision.js");
              assert.equal(workflowRepairLesson({ strategy: "replay-original", repairStatus: "completed", completedTasks: 4, failedTasks: 0, acceptanceVerified: preflight.accepted }).outcome, "reinforce");
              await storage.recordRunAction({ runId, taskId, agentId, actionType: "fixture_supervisor_audit", target: taskId,
                summary: "Independent synthetic supervisor resolved every stored acceptance gate.",
                artifactKind: "fixture_supervisor_audit", artifactContent: preflight });
            }
            return { output: { outcome: "completed", summary: "Synthetic downstream worker independently reviewed governed no-edit delivery evidence.",
              artifact: { acceptanceContract: proposal, findings: ["Stored acceptance preflight passed"], nextAction: "Advance the synthetic lifecycle" },
              requestedFileWrites: [], requestedCommands: [] },
              attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
          }
          if (acceptanceContract && childMode === "consume") {
            const evidence = await client.query("select a.uri,a.content,a.run_id::text as \"runId\",a.task_id::text as \"taskId\",t.stage_id as \"stageId\",a.created_at as \"createdAt\" from artifacts a join workflow_tasks t on t.id=a.task_id where a.run_id=$1 and a.kind='command_output' and a.content->>'commandLine'=$2 order by a.created_at desc limit 1", [runId, command(4)]);
            const reference = commandAcceptanceReference(evidence.rows[0]);
            assert.ok(reference, "Resume must consume an exact stored command reference");
            assert.equal(reference.subjectHash, acceptanceContract.subjectHash);
            assert.equal(evidence.rows[0].content.exitCode, 0);
            for (const deliverable of acceptanceContract.deliverables) {
              deliverable.status = "verified";
              for (const gate of deliverable.requiredGates) deliverable.receipts[gate] = [reference];
            }
            for (const gate of acceptanceContract.deliverables[0]!.requiredGates) {
              for (const control of ["missing", "stale", "cross-run"] as const) {
                const invalid = structuredClone(acceptanceContract);
                const deliverable = invalid.deliverables[0]!;
                if (control === "missing") deliverable.receipts[gate] = [];
                else {
                  const receipt = deliverable.receipts[gate]![0]!;
                  if (control === "stale") receipt.subjectHash = acceptanceDigest("stale synthetic source");
                  else receipt.runId = randomUUID();
                }
                const decision = await storage.getWorkflowAcceptanceDecision(runId, { acceptanceContract: invalid }, gate);
                assert.equal(decision.mode, "structured");
                assert.ok(decision.reason, `${gate} must reject ${control} evidence after durable resume`);
                assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "running");
              }
            }
          }
          return { output: { summary: "Synthetic workflow command observation recorded and reviewed.", artifact: { findings: ["Synthetic command observation"], nextAction: "Consume the durable command receipt before completing the stage.", consumed: childMode === "consume",
            ...(acceptanceContract ? { acceptanceContract } : {}) }, requestedFileWrites: [],
            requestedCommands: childMode === "consume" && calls > 1 ? [] : [command(childMode === "initial" ? calls : 4)] },
            attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
        }
      });
      const { runWorkerOnce } = await import("../packages/workflow-engine/src/executor.js");
      const result = await runWorkerOnce(1, { workerId: process.env.AGENTFLOW_LIVE_FIXTURE_WORKER!, projectRootUri: process.cwd(), recoverExpiredLeases: false });
      assert.equal(result.claimed, 1);
      assert.equal(result.completed, childMode === "consume" || childMode === "downstream" ? 1 : 0);
      const failures = await client.query("select action_type,summary from action_receipts where run_id=$1 order by created_at", [runId]);
      assert.equal(result.failed, childMode === "repeat" && saved?.content.round === 3 ? 1 : 0, JSON.stringify(failures.rows));
      assert.equal(calls, childMode === "downstream" ? 1 : childMode === "consume" ? 2 : 4);
      console.log(JSON.stringify({ mode: childMode, pid: process.pid, result }));
      return;
    }

    const config = projectConfigSchema.parse({ project: { name: "Synthetic continuation acceptance" },
      policies: { require_approval_for_external_actions: false }, actions: { allowed_commands: ["node --version *"], allowed_write_paths: [] } });
    const workflow = { stages: [{ id: "inspect", agent: agentId, goal: "Inspect synthetic observations", pattern: { type: "react", max_iterations: 3 } }] };
    const lifecycleWorkflow = { stages: [...workflow.stages,
      { id: "verify", agent: agentId, goal: "Verify retained synthetic delivery", depends_on: ["inspect"], pattern: { type: "verifier", max_iterations: 3 } },
      { id: "package", agent: agentId, goal: "Validate synthetic delivery packaging", depends_on: ["verify"], pattern: { type: "executor", max_iterations: 3 } },
      { id: "supervise", agent: agentId, goal: "Independently audit synthetic delivery receipts", depends_on: ["package"], pattern: { type: "verifier", max_iterations: 3 } }
    ] };
    for (const id of [agentId, "workflow-orchestrator"]) {
      await client.query("insert into agents(id,display_name,category,source_path,definition) values ($1,'Synthetic','test','synthetic',$2) on conflict(id) do nothing", [id, JSON.stringify({ prompt: "Inspect synthetic observations" })]);
    }
    await client.query("insert into workflows(id,name,source_path,definition) values ($1,'Synthetic','synthetic',$2)", [workflowId, JSON.stringify(workflow)]);
    const projectId = (await client.query("insert into projects(name,root_uri,config) values ('Synthetic',$1,$2) returning id", [process.cwd(), JSON.stringify(config)])).rows[0].id;
    await client.query("create table continuation_fixture_executions(task_id uuid not null, command_line text not null)");
    const launch = (mode: string, runId: string, taskId: string, worker: string, previousWorker = "") => {
      const env = { ...process.env, AGENTFLOW_LIVE_FIXTURE_MODE: mode, AGENTFLOW_LIVE_FIXTURE_RUN: runId,
        AGENTFLOW_LIVE_FIXTURE_TASK: taskId, AGENTFLOW_LIVE_FIXTURE_WORKER: worker, AGENTFLOW_LIVE_FIXTURE_PREVIOUS_WORKER: previousWorker };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 30_000 });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(child.stdout);
    };
    const checks: string[] = [];
    for (const scenario of ["consume", "repeat"]) {
      const runId = randomUUID();
      const taskId = randomUUID();
      const snapshot = scenario === "consume" ? lifecycleWorkflow : workflow;
      await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy,policy_snapshot,workflow_snapshot) values ($1,$2,$3,'queued','Inspect synthetic observations','2',$4,$5)", [runId, projectId, workflowId, JSON.stringify(config), JSON.stringify(snapshot)]);
      await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key) values ($1,$2,'inspect',$3,'queued',$4)", [taskId, runId, agentId, taskId]);
      if (scenario === "consume") {
        for (const stageId of ["verify", "package", "supervise"]) {
          const downstreamTaskId = randomUUID();
          await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key) values ($1,$2,$3,$4,'queued',$5)", [downstreamTaskId, runId, stageId, agentId, downstreamTaskId]);
        }
        const sourcePaths = ["package.json"];
        await enrollAcceptanceContract(client, runId, {
          version: 1, contractId: `synthetic:${runId}`, projectId, originRunId: runId,
          taskHash: acceptanceDigest("Inspect synthetic observations"), sourcePaths,
          subjectHash: await sourceSubjectHash(process.cwd(), sourcePaths),
          deliverables: [{ id: "synthetic-product", description: "Verify existing synthetic delivery through durable resume",
            requiredGates: ["implementation", "verification", "packaging", "supervision"],
            status: "pending", receipts: {}, gaps: [] }]
        });
      }
      let previousWorker = "";
      for (let round = 1; round <= (scenario === "consume" ? 2 : 4); round++) {
        const worker = `synthetic-${scenario}-${round}`;
        launch(round === 1 ? "initial" : scenario, runId, taskId, worker, previousWorker);
        previousWorker = worker;
        const row = (await client.query("select status,output_uri,finished_at,worker_id,lease_expires_at,available_at from workflow_tasks where id=$1", [taskId])).rows[0];
        const checkpoint = await storage.getArtifactByUri(`db://workflow_tasks/${taskId}/continuation`);
        assert.ok(checkpoint);
        assert.equal((await client.query("select count(*)::int as n from continuation_fixture_executions where task_id=$1", [taskId])).rows[0].n, 4, "Duplicate requests must never dispatch another command");
        assert.equal((await client.query("select count(*)::int as n from artifacts where run_id=$1 and kind='command_output'", [runId])).rows[0].n, 4);
        if (row.status === "queued") {
          assert.equal(checkpoint.content.round, round);
          assert.equal(checkpoint.content.delaySeconds, 5 * 2 ** (round - 1));
          assert.equal(checkpoint.content.unchangedRounds, round - 1);
          assert.equal(row.output_uri, null);
          assert.equal(row.finished_at, null);
          assert.equal(row.worker_id, null);
          assert.equal(row.lease_expires_at, null);
          const receipt = (await client.query("select metadata,created_at from action_receipts where run_id=$1 and action_type='stage_continuation_scheduled' order by created_at desc limit 1", [runId])).rows[0];
          assert.equal(receipt.metadata.delaySeconds, checkpoint.content.delaySeconds);
          assert.ok(Math.abs(row.available_at.getTime() - receipt.created_at.getTime() - Number(checkpoint.content.delaySeconds) * 1000) < 1000);
          assert.equal((await client.query("select count(*)::int as n from action_receipts where run_id=$1 and action_type='stage_completed'", [runId])).rows[0].n, 0);
          const run = (await client.query("select status,lease_owner,lease_expires_at from workflow_runs where id=$1", [runId])).rows[0];
          assert.deepEqual(run, { status: "running", lease_owner: null, lease_expires_at: null });
          assert.ok((checkpoint.content.actionResults as Array<Record<string, unknown>>).some((action) => action.commandLine === command(4) && action.exitCode === 0));
          // Assert the real scheduling interval first, then advance only this synthetic task to avoid sleeps.
          await client.query("update workflow_tasks set available_at=now() where id=$1", [taskId]);
        } else {
          assert.equal(row.status, scenario === "consume" ? "completed" : "blocked");
          assert.ok(row.finished_at);
          const output = await storage.getArtifactByUri(row.output_uri);
          assert.ok(output);
          assert.ok((output.content.actionResults as Array<Record<string, unknown>>).some((action) => action.commandLine === command(4) && action.exitCode === 0));
          assert.equal((await client.query("select status from workflow_runs where id=$1", [runId])).rows[0].status, scenario === "consume" ? "running" : row.status);
          if (scenario === "consume") {
            assert.equal(output.content.consumed, true);
            assert.equal((await client.query("select count(*)::int as n from action_receipts consumed join action_receipts completed on completed.run_id=consumed.run_id where consumed.run_id=$1 and consumed.action_type='fixture_continuation_consumed' and completed.action_type='stage_completed' and consumed.created_at<completed.created_at", [runId])).rows[0].n, 1);
            assert.equal((await client.query("select count(*)::int as n from action_receipts where run_id=$1 and action_type='local_command_reused'", [runId])).rows[0].n, 1);
          } else {
            assert.equal(checkpoint.content.round, 3);
            assert.match(String(output.content.blockedReason), /follow-up budget was exhausted/);
            assert.equal((await client.query("select count(*)::int as n from action_receipts where run_id=$1 and action_type='stage_completed'", [runId])).rows[0].n, 0);
          }
        }
      }
      if (scenario === "consume") {
        for (const stageId of ["verify", "package", "supervise"]) {
          const downstream = (await client.query("select id,status from workflow_tasks where run_id=$1 and stage_id=$2", [runId, stageId])).rows[0];
          assert.equal(downstream.status, "queued");
          launch("downstream", runId, downstream.id, `synthetic-${stageId}`);
          const finished = (await client.query("select status,output_uri from workflow_tasks where id=$1", [downstream.id])).rows[0];
          assert.equal(finished.status, "completed");
          const stageOutput = await storage.getArtifactByUri(finished.output_uri);
          assert.ok(stageOutput);
          assert.equal((await storage.preflightWorkflowAcceptance(runId, stageOutput.content)).accepted, true);
        }
        assert.equal((await client.query("select status from workflow_runs where id=$1", [runId])).rows[0].status, "completed");
        const terminal = await client.query("select content from artifacts where run_id=$1 and kind='terminal_acceptance'", [runId]);
        assert.equal(terminal.rows.length, 1);
        assert.equal(terminal.rows[0].content.accepted, true);
        assert.equal((await client.query("select count(*)::int as n from artifacts where run_id=$1 and kind='fixture_supervisor_audit'", [runId])).rows[0].n, 1);
        checks.push("verification-packaging-supervision-real-workers-and-terminal-acceptance");
      }
      checks.push(scenario === "consume" ? "fresh-worker-consumption-before-completion-and-stale-fencing" : "finite-three-checkpoints-backoff-and-terminal-block");
    }
    console.log(JSON.stringify({ checks, commandExecutionsPerScenario: 4, cleanupOwner: "test-continuation-postgres.ts disposable database finally block" }));
    console.log("CONTINUATION_LIVE_ACCEPTANCE_PASSED");
  } finally {
    await client.end();
  }
});

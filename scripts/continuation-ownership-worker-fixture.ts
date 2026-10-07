/** Only run through test-continuation-ownership-postgres.ts. Desired behavior stays unchanged for red and green. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { projectConfigSchema } from "../packages/agent-registry/src/schemas.js";
import * as storage from "../packages/storage/src/postgres.js";
import type { StageExecutionInput } from "../packages/model-providers/src/types.js";

const agentId = "synthetic-ownership-verifier";
const workflowId = "synthetic-ownership-workflow";
const ownedPath = "owned.ts";
const userPath = "user.ts";
const broken = 'export const value: number = "synthetic mismatch";\n';
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("same-run governed ownership survives durable continuation", async (t) => {
  assert.match(new URL(databaseUrl()).pathname.slice(1), /^agentflow_ownership_test_[a-f0-9]{32}$/);
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const mode = process.env.AGENTFLOW_OWNERSHIP_MODE;
    if (mode) {
      assert.ok(["prior", "initial", "resume"].includes(mode));
      const priorTaskId = process.env.AGENTFLOW_OWNERSHIP_PRIOR_TASK;
      const root = process.env.AGENTFLOW_OWNERSHIP_ROOT!;
      const runId = process.env.AGENTFLOW_OWNERSHIP_RUN!;
      const taskId = process.env.AGENTFLOW_OWNERSHIP_TASK!;
      const workerId = process.env.AGENTFLOW_OWNERSHIP_WORKER!;
      assert.match(runId, /^[a-f0-9-]{36}$/);
      assert.match(taskId, /^[a-f0-9-]{36}$/);
      const saved = await storage.getArtifactByUri(`db://workflow_tasks/${taskId}/continuation`);
      let calls = 0;
      const replace = async (relative: string, overrides: Record<string, unknown>) => {
        const url = new URL(relative, import.meta.url).href;
        const original = await import(url);
        t.mock.module(url, { namedExports: { ...original, ...overrides } });
      };
      await replace("../packages/agent-registry/src/loaders.js", { loadProjectConfig: async () => { throw new Error("Use isolated synthetic snapshot"); } });
      await replace("../packages/workflow-engine/src/stage-telemetry.js", { createStageTelemetry: () => ({ end() {}, setRoute() {}, event() {} }), flushStageTelemetry: async () => {} });
      await replace("../packages/workflow-engine/src/memory-graph-wiring.js", { buildMemoryContextForStage: async () => [], recordStageMemoryGraph: async () => {} });
      await replace("../packages/workflow-engine/src/fleet-usage.js", { recordDirectProviderUsage: async () => 0 });
      await replace("../packages/model-providers/src/routing.js", { selectModelRoute: async () => ({ providerId: "mock", modelTier: "fast", reason: "Isolated synthetic ownership reproduction" }) });
      await replace("../packages/model-providers/src/index.js", {
        executeWithProviderFallback: async ({ stageInput }: { stageInput: StageExecutionInput }) => {
          calls++;
          assert.equal(stageInput.taskId, taskId);
          if (mode === "resume" && calls === 1) {
            assert.ok(saved);
            assert.equal(saved.runId, runId);
            assert.equal(saved.taskId, taskId);
            const resume = stageInput.priorReceipts.findLast((r) => r.actionType === "stage_continuation_resumed");
            assert.ok(resume, "Real worker must hydrate serialized checkpoint before provider call");
            const restored = JSON.parse(resume.summary.slice(resume.summary.indexOf("\n") + 1));
            assert.deepEqual(restored.actionResults, saved.content.actionResults);
            const write = (restored.actionResults as Array<Record<string, unknown>>).find((a) => a.type === "file_write" && a.path === ownedPath);
            if (priorTaskId) assert.equal(write, undefined, "Verifier checkpoint must not supply earlier-stage ownership");
            else assert.ok(write);
            const priorWrite = priorTaskId ? (await client.query("select uri from artifacts where run_id=$1 and task_id=$2 and kind='file_write'", [runId, priorTaskId])).rows : [];
            if (priorTaskId) assert.equal(priorWrite.length, 1);
            const receipt = await storage.getArtifactByUri(String(priorTaskId ? priorWrite[0].uri : write!.artifactUri));
            assert.ok(receipt);
            assert.equal(receipt.runId, runId);
            assert.equal(receipt.taskId, priorTaskId ?? taskId);
            assert.equal(receipt.kind, "file_write");
            assert.equal(receipt.content.nextHash, hash(await fs.readFile(path.join(root, ownedPath), "utf8")));
            if (priorTaskId) {
              assert.equal(receipt.content.requestedByStageId, "prepare");
              assert.equal((await client.query("select status from workflow_tasks where id=$1", [priorTaskId])).rows[0].status, "completed");
              const finalized = (await client.query("select status,receipt from side_effect_receipts where project_id=$1 and idempotency_key=$2", [runId, receipt.content.idempotencyKey])).rows[0];
              assert.equal(finalized.status, "completed");
              assert.equal(finalized.receipt.artifactUri, receipt.uri);
            } else assert.equal(write!.nextHash, receipt.content.nextHash);
            const scheduled = (await client.query("select metadata from action_receipts where run_id=$1 and action_type='stage_continuation_scheduled' order by created_at desc limit 1", [runId])).rows[0];
            assert.ok(scheduled);
            const stale = { runId, taskId, agentId, workerId: "synthetic-owner-initial", fencingToken: scheduled.metadata.fencingToken };
            await assert.rejects(storage.assertWorkflowTaskLease(stale), /Stale workflow/i);
            await assert.rejects(storage.checkpointWorkflowTaskContinuation({ ...stale, continuation: saved.content, delaySeconds: 5 }), /Stale workflow/i);
            await assert.rejects(storage.completeWorkflowTask({ ...stale, summary: "Stale synthetic completion", artifact: {} }), /Stale workflow/i);
            assert.equal(await storage.renewWorkflowTaskLease(stale), false);
            console.log("OWNERSHIP_HYDRATION_AND_FENCING_PROVEN");
          }
          const retry = mode === "resume" && calls > 1;
          return { output: {
            outcome: retry ? "blocked" : "completed",
            ...(retry ? { blockedReason: "Synthetic agent-owned verification failure consumed; reproduction performs no repair." } : {}),
            summary: "Synthetic governed mutation and verification evidence inspected.",
            artifact: { findings: ["Isolated ownership attribution observation"], nextAction: "Inspect exact command classification" },
            requestedFileWrites: (mode === "prior" || (mode === "initial" && !priorTaskId)) && calls === 1 ? [{ path: ownedPath, content: broken }] : [],
            requestedCommands: mode === "prior" ? (calls === 1 ? ["node --version prior-observation"] : []) : mode === "initial" ? [`node --version observation-${calls}`] : retry ? [] : ["npm run typecheck"]
          }, attempts: [], actualProvider: "mock", actualModel: "mock", fallbackUsed: false };
        }
      });
      const { runWorkerOnce } = await import("../packages/workflow-engine/src/executor.js");
      const result = await runWorkerOnce(1, { workerId, projectRootUri: root, recoverExpiredLeases: false });
      assert.equal(result.claimed, 1);
      if (mode === "prior") {
        assert.equal(result.completed, 1);
        assert.equal(result.failed, 0);
        assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "completed");
        return;
      }
      assert.equal(result.completed, 0);
      if (mode === "initial") {
        assert.equal(result.failed, 0);
        assert.equal(calls, 4);
        const checkpoint = await storage.getArtifactByUri(`db://workflow_tasks/${taskId}/continuation`);
        assert.ok(checkpoint);
        assert.equal(checkpoint.content.round, 1);
        const hasWrite = (checkpoint.content.actionResults as Array<Record<string, unknown>>).some((a) => a.type === "file_write" && a.path === ownedPath);
        assert.equal(hasWrite, !priorTaskId);
      } else {
        assert.equal(result.failed, 1);
        const command = (await client.query("select content from artifacts where run_id=$1 and kind='command_output' and content->>'commandLine'='npm run typecheck' and content ? 'stdout'", [runId])).rows[0];
        assert.ok(command, "Actual local typecheck must execute");
        assert.equal(command.content.exitCode, 2);
        assert.equal(command.content.timedOut, false);
        assert.match(command.content.stdout + command.content.stderr, /error TS2322/);
      }
      return;
    }

    const compiler = process.env.AGENTFLOW_OWNERSHIP_COMPILER!;
    assert.ok(compiler);
    await fs.access(compiler);
    for (const id of [agentId, "workflow-orchestrator"]) await client.query("insert into agents(id,display_name,category,source_path,definition) values ($1,'Synthetic','test','synthetic',$2) on conflict(id) do nothing", [id, JSON.stringify({ prompt: "Inspect isolated synthetic evidence" })]);
    const workflow = { stages: [{ id: "inspect", agent: agentId, goal: "Inspect synthetic ownership", pattern: { type: "verifier", max_iterations: 3 } }] };
    await client.query("insert into workflows(id,name,source_path,definition) values ($1,'Synthetic','synthetic',$2)", [workflowId, JSON.stringify(workflow)]);
    for (const scenario of ["unrelated-user", "same-run-generated", "same-run-existing", "prior-stage-resumed"]) {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-ownership-fixture-")));
      try {
        const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
        git("init");
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { typecheck: `node ${JSON.stringify(compiler)} --noEmit --pretty false --skipLibCheck --types node --typeRoots ${JSON.stringify(path.join(path.dirname(path.dirname(path.dirname(compiler))), "@types"))} ${scenario === "unrelated-user" ? userPath : ownedPath}` } }));
        await fs.writeFile(path.join(root, userPath), "export const user = 1;\n");
        if (scenario === "same-run-existing") {
          await fs.writeFile(path.join(root, ownedPath), "export const value: number = 1;\n");
          git("add", ownedPath);
        }
        git("add", "package.json", userPath);
        const userIndex = git("show", `:${userPath}`);
        await fs.writeFile(path.join(root, userPath), scenario === "unrelated-user" ? broken : "export const user = 2;\n");
        const userBefore = await fs.readFile(path.join(root, userPath), "utf8");
        const config = projectConfigSchema.parse({ project: { name: "Synthetic ownership reproduction" }, policies: { require_approval_for_external_actions: false }, actions: { allowed_commands: ["node --version *", "npm run typecheck"], allowed_write_paths: [ownedPath], require_approval_for: [] } });
        const projectId = (await client.query("insert into projects(name,root_uri,config) values ('Synthetic',$1,$2) returning id", [root, JSON.stringify(config)])).rows[0].id;
        const runId = randomUUID();
        const taskId = randomUUID();
        const priorTaskId = scenario === "prior-stage-resumed" ? randomUUID() : undefined;
        const snapshot = priorTaskId ? { stages: [{ id: "prepare", agent: agentId, goal: "Record synthetic governed mutation", pattern: { type: "executor", max_iterations: 3 } }, ...workflow.stages] } : workflow;
        await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy,policy_snapshot,workflow_snapshot) values ($1,$2,$3,'queued','Inspect synthetic ownership evidence','2',$4,$5)", [runId, projectId, workflowId, JSON.stringify(config), JSON.stringify(snapshot)]);
        await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key) values ($1,$2,'inspect',$3,'queued',$4)", [taskId, runId, agentId, taskId]);
        const launch = (mode: string, activeTaskId = taskId) => {
          const env = { ...process.env, AGENTFLOW_OWNERSHIP_MODE: mode, AGENTFLOW_OWNERSHIP_ROOT: root, AGENTFLOW_OWNERSHIP_RUN: runId, AGENTFLOW_OWNERSHIP_TASK: activeTaskId, AGENTFLOW_OWNERSHIP_PRIOR_TASK: priorTaskId, AGENTFLOW_OWNERSHIP_WORKER: `synthetic-owner-${mode}` };
          delete env.NODE_TEST_CONTEXT;
          const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 35_000 });
          console.log(child.stdout);
          assert.equal(child.status, 0, `Fixture setup/runtime failure is not ownership red evidence: ${child.stdout}${child.stderr}`);
        };
        if (priorTaskId) {
          await client.query("update workflow_tasks set available_at=now()+interval '1 hour' where id=$1", [taskId]);
          await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key) values ($1,$2,'prepare',$3,'queued',$4)", [priorTaskId, runId, agentId, priorTaskId]);
          launch("prior", priorTaskId);
          assert.equal((await client.query("select status from workflow_tasks where id=$1", [priorTaskId])).rows[0].status, "completed");
          await client.query("update workflow_tasks set available_at=now() where id=$1", [taskId]);
        }
        launch("initial");
        const checkpoint = await storage.getArtifactByUri(`db://workflow_tasks/${taskId}/continuation`);
        assert.ok(checkpoint);
        assert.deepEqual(JSON.parse(JSON.stringify(checkpoint.content)), checkpoint.content);
        assert.equal((await client.query("select status from workflow_tasks where id=$1", [taskId])).rows[0].status, "queued");
        assert.equal((await client.query("select count(*)::int as n from artifacts where run_id=$1 and kind='file_write'", [runId])).rows[0].n, 1);
        if (scenario === "same-run-existing") {
          const write = (await client.query("select content from artifacts where run_id=$1 and kind='file_write'", [runId])).rows[0].content;
          assert.equal(write.existed, true, "Existing-file scenario must exercise a governed modification");
          assert.equal(write.nextHash, hash(broken));
          assert.equal(git("show", `:${ownedPath}`), "export const value: number = 1;\n");
          assert.equal(await fs.readFile(path.join(root, ownedPath), "utf8"), broken);
        }
        await client.query("update workflow_tasks set available_at=now() where id=$1", [taskId]);
        launch("resume");
        assert.equal(await fs.readFile(path.join(root, userPath), "utf8"), userBefore);
        assert.equal(git("show", `:${userPath}`), userIndex);
        const events = (await client.query("select action_type,summary from action_receipts where run_id=$1 order by created_at", [runId])).rows;
        const environmental = events.filter((e) => e.action_type === "local_command_verify_environmental");
        const retries = events.filter((e) => e.action_type === "local_command_verify_retry");
        console.log("CONTINUATION_OWNERSHIP_OBSERVATION " + JSON.stringify({ scenario, command: "npm run typecheck", durableWrites: 1, checkpointRound: checkpoint.content.round, environmental, retries, userIndexAndWorktreePreserved: true }));
        if (scenario === "unrelated-user") {
          assert.equal(environmental.length, 1);
          assert.match(environmental[0].summary, /ENVIRONMENTAL_VERIFY_FAILURE/);
          assert.ok(environmental[0].summary.includes(userPath));
          assert.equal(retries.length, 0);
          console.log("UNRELATED_USER_ENVIRONMENTAL_CONTROL_PASSED");
        } else {
          assert.equal(environmental.length, 0, "CONTINUATION_OWNERSHIP_DEFECT: same-run governed file was classified environmental after serialized continuation");
          assert.equal(retries.length, 1, "Same-run command failure must reach bounded agent retry");
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await client.end();
  }
});

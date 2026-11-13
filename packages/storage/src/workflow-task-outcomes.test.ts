import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as api from "./postgres.js";
import { withClient } from "./client.js";
import { projectConfigSchema, workflowSchema } from "../../agent-registry/src/schemas.js";

test("task outcomes use the locked run epoch independently of stage generations", async t => {
  const fixtureUrl = process.env.TEST_DATABASE_URL;
  assert.ok(fixtureUrl && fixtureUrl === process.env.DATABASE_URL, "Run through the repository's isolated fixture wrapper");
  assert.match(new URL(fixtureUrl).pathname, /^\/agentflow_suite_test_[a-f0-9]{32}$/u);
  await withClient(async client => assert.match((await client.query("select current_database() name")).rows[0].name, /^agentflow_suite_test_[a-f0-9]{32}$/u));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "task-outcome-epochs-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await withClient(async client => {
    await client.query("insert into agents(id,display_name,category,source_path,definition) values('implementation-agent','Synthetic implementer','test','synthetic','{}'),('workflow-orchestrator','Synthetic orchestrator','test','synthetic','{}') on conflict(id) do nothing");
  });
  const create = async (label: string, parallel = false) => {
    const projectRoot = path.join(root, label); await fs.mkdir(projectRoot);
    const workflow = workflowSchema.parse({
      id: "task-outcome-epoch-" + randomUUID(), name: "Synthetic outcome ownership", description: "Independent stage and run counters",
      lead: "implementation-agent", execution: { kind: "read-only" },
      stages: Array.from({ length: parallel ? 2 : 3 }, (_, index) => ({
        id: "inspect-" + index, agent: "implementation-agent", goal: "Inspect synthetic epoch ownership", output: "evidence",
        ...(parallel ? { parallel_group: "pair", depends_on: [] } : {})
      }))
    });
    await withClient(async client => {
      await client.query("insert into workflows(id,name,source_path,definition) values($1,$2,'synthetic',$3)", [workflow.id, workflow.name, JSON.stringify(workflow)]);
    });
    const config = projectConfigSchema.parse({ project: { name: "Synthetic outcome ownership", autonomy: 2 } });
    const run = await api.createWorkflowRun({ projectName: config.project.name, projectRootUri: projectRoot, projectProfile: "test",
      projectConfig: config, workflow, task: "Inspect bounded synthetic ownership " + label, autonomy: "2", policyProfile: "local",
      policySnapshot: config, policySnapshotHash: "0".repeat(64) });
    return { runId: run.runId, claim: async () => {
      const claim = await api.claimNextWorkflowTask({ runId: run.runId, projectRootUri: projectRoot, workerId: "synthetic-epoch-worker" });
      assert.ok(claim); return claim;
    } };
  };
  const identity = (claim: any) => ({ taskId: claim.taskId, runId: claim.runId, workerId: claim.workerId, fencingToken: claim.fencingToken });
  const start = (claim: any) => api.startWorkflowTask(identity(claim));
  const complete = (claim: any) => api.completeWorkflowTask({ ...identity(claim), agentId: claim.agentId,
    summary: "Synthetic stage observation retained", artifact: { findings: ["Synthetic fixture observation"] } });
  const runState = (runId: string) => withClient(async client => (await client.query(
    'select status,lease_owner,lease_expires_at,lease_epoch::text as epoch from workflow_runs where id=$1', [runId])).rows[0]);

  await t.test("middle-stage completion clears the authoritative run lease and terminal keys retain stage identity", async () => {
    const fixture = await create("sequential");
    const first = await fixture.claim(); await start(first); await complete(first);
    const middle = await fixture.claim(); await start(middle);
    const owned = await runState(fixture.runId);
    assert.notEqual(middle.fencingToken, owned.epoch, "A new stage's generation must not be confused with a later run epoch");
    await complete(middle);
    const released = await runState(fixture.runId);
    assert.equal(released.status, "running"); assert.equal(released.epoch, owned.epoch);
    assert.equal(released.lease_owner, null); assert.equal(released.lease_expires_at, null);
    const last = await fixture.claim(); await start(last); await complete(last);
    await withClient(async client => {
      const transition = (await client.query("select idempotency_key,metadata from workflow_run_transitions where run_id=$1 and to_status='completed'", [fixture.runId])).rows[0];
      assert.equal(transition.idempotency_key, `run-completed:${last.taskId}:${last.fencingToken}`);
      assert.equal(transition.metadata.taskId, last.taskId);
    });
  });

  await t.test("same-worker reclaimed completion rejects the old generation and preserves an active sibling", async () => {
    const fixture = await create("parallel", true), old = await fixture.claim(); await start(old);
    const sibling = await fixture.claim(); await start(sibling);
    await api.checkpointWorkflowTaskContinuation({ ...identity(old), agentId: old.agentId, continuation: { synthetic: true }, delaySeconds: 1 });
    await withClient(async client => {
      // Advance only the owned synthetic fixture's availability clock.
      await client.query("update workflow_tasks set available_at=now() where id=$1 and run_id=$2", [old.taskId, fixture.runId]);
    });
    const current = await fixture.claim(); await start(current);
    assert.equal(current.taskId, old.taskId); assert.notEqual(current.fencingToken, old.fencingToken);
    const owned = await runState(fixture.runId); assert.notEqual(current.fencingToken, owned.epoch);
    const before = await withClient(async client => ({
      tasks: (await client.query("select to_jsonb(t) value from workflow_tasks t where run_id=$1 order by id", [fixture.runId])).rows.map(row => row.value),
      receipts: (await client.query("select count(*)::int n from action_receipts where run_id=$1", [fixture.runId])).rows[0].n
    }));
    await assert.rejects(complete(old), /Stale workflow fencing token/);
    assert.deepEqual(await withClient(async client => ({
      tasks: (await client.query("select to_jsonb(t) value from workflow_tasks t where run_id=$1 order by id", [fixture.runId])).rows.map(row => row.value),
      receipts: (await client.query("select count(*)::int n from action_receipts where run_id=$1", [fixture.runId])).rows[0].n
    })), before);
    await complete(current);
    assert.deepEqual(await runState(fixture.runId), owned);
    const siblingAfter = await withClient(async client => (await client.query("select to_jsonb(t) value from workflow_tasks t where id=$1", [sibling.taskId])).rows[0].value);
    assert.deepEqual(siblingAfter, before.tasks.find((task: any) => task.id === sibling.taskId));
  });

  await t.test("public approval hold forwards the locked run epoch without changing stage-token receipts", async () => {
    const fixture = await create("approval");
    const first = await fixture.claim(); await start(first); await complete(first);
    const current = await fixture.claim(); await start(current);
    const owned = await runState(fixture.runId); assert.notEqual(current.fencingToken, owned.epoch);
    const approval = await api.requestActionApproval({ ...identity(current), agentId: current.agentId, stageId: current.stageId,
      actionType: "file_write", target: "src/synthetic.txt", rationale: "Synthetic governed approval fixture",
      policyDecision: { approvalRequired: true, allowedByPolicy: true }, payload: {}, idempotencyKey: "synthetic-epoch-" + randomUUID() });
    assert.equal(await api.holdWorkflowTaskForApprovals({ ...identity(current), agentId: current.agentId,
      approvalIds: [approval.approvalId], continuation: { round: 2, synthetic: true } }), "waiting");
    const released = await runState(fixture.runId);
    assert.equal(released.epoch, owned.epoch); assert.equal(released.lease_owner, null); assert.equal(released.lease_expires_at, null);
    await withClient(async client => {
      const held = (await client.query("select status,worker_id,lease_generation::text generation,available_at='infinity'::timestamptz waiting from workflow_tasks where id=$1", [current.taskId])).rows[0];
      assert.equal(held.status, "queued"); assert.equal(held.worker_id, null); assert.equal(held.waiting, true);
      assert.equal(held.generation, current.fencingToken);
      const receipt = (await client.query("select metadata from action_receipts where run_id=$1 and action_type='stage_approval_held'", [fixture.runId])).rows[0];
      assert.equal(receipt.metadata.fencingToken, current.fencingToken);
      const checkpoint = (await client.query("select content from artifacts where run_id=$1 and task_id=$2 and kind='stage_continuation'", [fixture.runId, current.taskId])).rows[0].content;
      assert.equal(checkpoint.round, 2); assert.equal(checkpoint.synthetic, true);
    });
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { cancelWorkflowRun, databaseUrl, requeueRunningWorkflowTasks, requeueExpiredWorkflowTaskLeases, resumeWorkflowRunFromCheckpoint, dismissFailedWorkflowRun, reinstateFailedWorkflowRun } from "./postgres.js";
import { tripBreaker } from "./guarded-autonomy.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { cancelRemainingWorkflowStages } from "./stage-lifecycle.js";
import { runNotificationOutboxSchemaSql } from "./run-notifications.js";

test("stage cancellations and manual requeues have atomic, per-stage events", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const original = pg.Pool.prototype.connect;
  const run = "00000000-0000-4000-8000-000000000001";
  const task = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query(`create temporary table workflow_runs(id uuid primary key, status text, state_version bigint default 0,
      lease_epoch bigint default 0, lease_owner text, lease_expires_at timestamptz, finished_at timestamptz,
      requester_channel text default 'synthetic', evaluation_metadata jsonb default '{}');
      create temporary table workflow_tasks(id uuid primary key,run_id uuid,agent_id text,status text,finished_at timestamptz,
        started_at timestamptz,worker_id text,lease_expires_at timestamptz,available_at timestamptz);
      create temporary table workflow_run_transitions(run_id uuid,from_status text,to_status text,state_version bigint,
        lease_epoch bigint,actor text,reason text,idempotency_key text,metadata jsonb,created_at timestamptz default now());
      create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,summary text,
        metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version integer);
      create temporary table run_notifications(id uuid primary key default gen_random_uuid(),run_id uuid,channel text,kind text,
        title text,body text,status text default 'pending',created_at timestamptz default now(),delivered_at timestamptz)`);
    await client.query(runNotificationOutboxSchemaSql);
    pg.Pool.prototype.connect = (async () => Object.assign(client, { release() {} })) as unknown as typeof original;
    await client.query("insert into workflow_runs(id,status) values($1,'running')", [run]);
    for (const [i, status] of ["queued", "leased", "running", "completed", "failed", "cancelled"].entries()) {
      await client.query("insert into workflow_tasks(id,run_id,agent_id,status) values($1,$2,'synthetic-agent',$3)", [task(i + 1), run, status]);
    }
    assert.equal(await requeueRunningWorkflowTasks(run), 2);
    assert.equal(await requeueRunningWorkflowTasks(run), 0);
    assert.equal((await client.query("select count(*)::int n from action_receipts where action_type='stage_requeued'")).rows[0].n, 2);
    // Block/failure paths exclude their already-handled primary stage.
    await client.query("begin");
    assert.equal(await cancelRemainingWorkflowStages(client, { runId: run, exceptTaskId: task(1), reason: "Synthetic sibling failure" }), 2);
    assert.equal((await client.query("select status from workflow_tasks where id=$1", [task(1)])).rows[0].status, "queued");
    await client.query("rollback");
    assert.equal((await client.query("select count(*)::int n from action_receipts where action_type='stage_cancelled'")).rows[0].n, 0);
    await client.query("alter table run_notifications add constraint reject_stage_event check(title<>'stage cancelled') not valid");
    await assert.rejects(cancelWorkflowRun(run), /reject_stage_event/u);
    assert.equal((await client.query("select status from workflow_runs")).rows[0].status, "running");
    assert.equal((await client.query("select count(*)::int n from workflow_tasks where status='queued'")).rows[0].n, 3);
    await client.query("alter table run_notifications drop constraint reject_stage_event");
    assert.equal(await cancelWorkflowRun(run), true);
    assert.equal(await cancelWorkflowRun(run), false);
    const events = (await client.query("select body from run_notifications where title='stage cancelled'")).rows.map(row => JSON.parse(row.body));
    assert.deepEqual(events.map(e => e.subject).sort(), [task(1), task(2), task(3)]);
    assert.ok(events.every(e => e.type === "stage.changed" && e.action === "stage_cancelled"));
    assert.equal((await client.query("select status from workflow_tasks where id=$1", [task(4)])).rows[0].status, "completed");
    await client.query("alter table workflow_runs add column project_id uuid; create temporary table projects(id uuid primary key,root_uri text)");
    await client.query("insert into projects values($1,'/synthetic')", [run]);
    await client.query("update workflow_runs set project_id=$1,status='running'", [run]);
    await client.query("update workflow_tasks set status='leased',lease_expires_at=now()-interval '1 minute' where id=$1", [task(1)]);
    const expiredInput = { runId: run, projectRootUri: "/synthetic", actor: "synthetic", reason: "Expired lease" };
    assert.deepEqual(await requeueExpiredWorkflowTaskLeases({ ...expiredInput, projectRootUri: "/wrong" }), { requeuedTasks: 0, affectedRuns: 0 });
    assert.deepEqual(await requeueExpiredWorkflowTaskLeases(expiredInput), { requeuedTasks: 1, affectedRuns: 1 });
    assert.deepEqual(await requeueExpiredWorkflowTaskLeases(expiredInput), { requeuedTasks: 0, affectedRuns: 0 });
    assert.equal((await client.query("select count(*)::int n from action_receipts where action_type='stage_requeued'")).rows[0].n, 3);
    await client.query(`alter table workflow_runs add column updated_at timestamptz,add column workflow_id text,add column provider_override text;
      alter table workflow_tasks add column lease_generation bigint default 0;
      create temporary table breaker_events(scope text,scope_id text,generation bigint,state text,reason text,actor text,human_authored boolean,evidence_hashes jsonb,created_at timestamptz default now())`);
    await client.query("update workflow_tasks set status='running' where id=$1",[task(1)]);
    await client.query("alter table run_notifications add constraint reject_stage_event check(title<>'stage requeued') not valid");
    const breaker = {scope:"project" as const,scopeId:"/synthetic",state:"tripped" as const,reason:"Synthetic breaker",actor:"synthetic",humanAuthored:true};
    await assert.rejects(tripBreaker(breaker), /reject_stage_event/u);
    assert.equal((await client.query("select count(*)::int n from breaker_events")).rows[0].n,0);
    assert.equal((await client.query("select status from workflow_tasks where id=$1",[task(1)])).rows[0].status,"running");
    await client.query("alter table run_notifications drop constraint reject_stage_event");
    await tripBreaker(breaker);
    const checkpoint = await resumeWorkflowRunFromCheckpoint({runId:run,actor:"synthetic",reason:"Synthetic checkpoint"});
    assert.ok(checkpoint.requeuedTasks > 0);
    assert.equal((await client.query("select count(*)::int n from run_notifications where title='checkpoint resume requested'")).rows[0].n,1);
    await client.query("update workflow_runs set status='failed'");
    await dismissFailedWorkflowRun({runId:run,actor:"synthetic",reason:"Synthetic dismiss"});
    assert.equal((await client.query("select status from workflow_runs")).rows[0].status,"cancelled");
    await reinstateFailedWorkflowRun({runId:run,actor:"synthetic",reason:"Synthetic reinstate"});
    assert.equal((await client.query("select status from workflow_runs")).rows[0].status,"failed");
    for(const title of ["failed run dismissed","failed run reinstated"]) assert.equal((await client.query("select count(*)::int n from run_notifications where title=$1",[title])).rows[0].n,1);
    await client.query("begin");
    await appendActionReceipt(client,{runId:run,agentId:"synthetic",actionType:"workflow_created",target:run,summary:"Synthetic creation",metadata:"{}"});
    assert.equal((await client.query("select count(*)::int n from run_notifications where title='workflow created'")).rows[0].n,1);
    await client.query("rollback");
    assert.equal((await client.query("select count(*)::int n from run_notifications where title='workflow created'")).rows[0].n,0);
    await assert.rejects(cancelRemainingWorkflowStages(client, { runId: run, reason: "No transaction" }), /transaction/u);
  } finally {
    pg.Pool.prototype.connect = original;
    await client.end();
  }
});

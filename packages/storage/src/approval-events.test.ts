import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl } from "./postgres.js";
import { claimActionApprovalExecution, expireStaleApprovals } from "./action-approvals.js";
import { runNotificationOutboxSchemaSql } from "./run-notifications.js";

test("approval expiry commits its event once and rolls back when event persistence fails", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const original = pg.Pool.prototype.connect;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query(`create temporary table workflow_runs(id uuid primary key, requester_channel text, evaluation_metadata jsonb default '{}');
      create temporary table action_approvals(id uuid primary key, run_id uuid, agent_id text, target text, status text, updated_at timestamptz, expires_at timestamptz);
      create temporary table action_receipts(run_id uuid, agent_id text, action_type text, target text, summary text, metadata jsonb, prev_hash text, receipt_hash text, created_at timestamptz, metadata_serialization_version integer);
      create temporary table run_notifications(id uuid primary key default gen_random_uuid(), run_id uuid, channel text, kind text, title text, body text, status text default 'pending', created_at timestamptz default now(), delivered_at timestamptz)`);
    await client.query(runNotificationOutboxSchemaSql);
    const isolated = Object.assign(client, { release() {} });
    pg.Pool.prototype.connect = (async () => isolated) as unknown as typeof original;
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query("insert into workflow_runs(id,requester_channel) values($1,'synthetic')", [id]);
    await client.query("insert into action_approvals values($1,$1,'test-agent','synthetic','pending',now(),now()-interval '1 minute')", [id]);
    assert.equal(await expireStaleApprovals(), 1);
    assert.equal(await expireStaleApprovals(), 0);
    const events = await client.query("select body from run_notifications");
    assert.equal(events.rowCount, 1);
    assert.equal(JSON.parse(events.rows[0].body).action, "action_approval_expired");
    assert.equal(JSON.parse(events.rows[0].body).subject, id);
    await client.query("update action_approvals set status='pending'");
    await client.query("alter table run_notifications add constraint reject_new_event check (title='impossible') not valid");
    await assert.rejects(expireStaleApprovals(), /reject_new_event/u);
    assert.equal((await client.query("select status from action_approvals")).rows[0].status, "pending");
    assert.equal((await client.query("select count(*)::int as n from action_receipts")).rows[0].n, 1);
    await client.query("alter table run_notifications drop constraint reject_new_event");
    await client.query(`alter table workflow_runs add column project_id uuid, add column workflow_id text, add column task text;
      create temporary table projects(id uuid primary key, name text, root_uri text);
      alter table action_approvals add column task_id uuid, add column stage_id text,
      add column action_type text, add column rationale text, add column policy_decision jsonb,
      add column payload jsonb, add column idempotency_key text, add column decided_by text,
      add column decided_role text, add column decided_at timestamptz, add column executed_by text,
      add column executed_role text, add column executed_at timestamptz, add column execution_claim_token uuid,
      add column execution_claim_expires_at timestamptz, add column decision_note text, add column created_at timestamptz`);
    await client.query("insert into projects values($1,'synthetic','/synthetic')", [id]);
    await client.query("update workflow_runs set project_id=$1", [id]);
    await client.query("update action_approvals set status='approved'");
    const claimed = await claimActionApprovalExecution({ approvalId: id, actor: "synthetic" });
    assert.ok(claimed?.claimToken);
    assert.equal(await claimActionApprovalExecution({ approvalId: id, actor: "another" }), null);
    assert.equal((await client.query("select count(*)::int as n from run_notifications")).rows[0].n, 2);
    await client.query("update action_approvals set execution_claim_expires_at=now()-interval '1 second'");
    await client.query("alter table run_notifications add constraint reject_claim_event check (title='impossible') not valid");
    await assert.rejects(claimActionApprovalExecution({ approvalId: id, actor: "replacement" }), /reject_claim_event/u);
    assert.equal((await client.query("select execution_claim_token from action_approvals")).rows[0].execution_claim_token, claimed.claimToken);
  } finally {
    pg.Pool.prototype.connect = original;
    await client.end();
  }
});

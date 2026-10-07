import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl, recordRunAction, verifyRunReceiptChain, transitionWorkflowRun } from "./postgres.js";
import { computeReceiptHash } from "../../workflow-engine/src/receipt-chain.js";
import { runNotificationOutboxSchemaSql } from "./run-notifications.js";
import { createHash } from "node:crypto";
import { appendActionReceipt } from "./receipt-writer.js";
import { replayRecordedLifecycleEvents } from "./recorded-lifecycle.js";

// Real PostgreSQL JSONB conversion; all test relations are session-local.
test("untouched receipt survives PostgreSQL JSONB round trip", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query(`create temporary table workflow_runs (
      id uuid primary key, project_id uuid, status text, state_version bigint default 0,
      lease_epoch bigint default 0, lease_owner text, lease_expires_at timestamptz,
      finished_at timestamptz, requester_channel text default 'dashboard', evaluation_metadata jsonb default '{}'
    )`);
    await client.query(`create temporary table workflow_run_transitions (
      run_id uuid, from_status text, to_status text, state_version bigint,
      lease_epoch bigint, actor text, reason text, idempotency_key text, metadata jsonb,
      created_at timestamptz default now()
    )`);
    await client.query(`create temporary table run_notifications (
      id uuid primary key default gen_random_uuid(), run_id uuid, channel text, kind text,
      title text, body text, status text default 'pending', created_at timestamptz default now(), delivered_at timestamptz
    )`);
    await client.query(runNotificationOutboxSchemaSql);
    await client.query("create temporary table projects(id uuid primary key,root_uri text)");
    await client.query(`create temporary table action_receipts (
      run_id uuid, agent_id text, action_type text, target text, summary text,
      metadata jsonb, prev_hash text, receipt_hash text, created_at timestamptz default now()
    )`);
    await client.query("insert into pg_temp.action_receipts (receipt_hash) values ('synthetic-legacy-hash')");
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.query("alter table pg_temp.action_receipts add column if not exists metadata_serialization_version integer");
    }
    const legacyMigration = await client.query("select receipt_hash, metadata_serialization_version from pg_temp.action_receipts");
    assert.deepEqual(legacyMigration.rows, [{ receipt_hash: "synthetic-legacy-hash", metadata_serialization_version: null }]);
    await client.query("delete from pg_temp.action_receipts where run_id is null");
    await client.query(`create temporary table artifacts (
      run_id uuid, task_id uuid, kind text, uri text unique, content jsonb
    )`);
    const isolated = Object.assign(client, { release() {} });
    pg.Pool.prototype.connect = (async () => isolated) as unknown as typeof originalConnect;
    const runId = "00000000-0000-4000-8000-000000000001";
    await client.query("insert into workflow_runs (id, status) values ($1, 'queued')", [runId]);
    await client.query("insert into projects values($1,'/synthetic')", [runId]);
    await client.query("update workflow_runs set project_id=$1 where id=$1", [runId]);
    const artifactContent = { longerKey: { longerNestedKey: "synthetic", a: 1 }, a: true };
    const metadataBeforeStorage = JSON.stringify(artifactContent);
    await recordRunAction({ runId, agentId: "workflow-orchestrator",
      actionType: "workflow_supervisor_repair_suppressed",
      target: "synthetic-target", summary: "Synthetic round-trip receipt.",
      artifactKind: "synthetic_roundtrip", artifactContent });
    const result = await client.query(`select agent_id, action_type, target, summary,
      metadata::text as metadata, created_at, prev_hash, receipt_hash, metadata_serialization_version
      from pg_temp.action_receipts where run_id=$1`, [runId]);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    const content = { runId, agentId: row.agent_id as string,
      actionType: row.action_type as string, target: row.target as string,
      summary: row.summary as string, createdAt: (row.created_at as Date).toISOString(),
      metadata: metadataBeforeStorage, metadataSerializationVersion: row.metadata_serialization_version ?? undefined };
    const originalHash = computeReceiptHash(row.prev_hash, content);
    const storedTextHash = computeReceiptHash(row.prev_hash, { ...content, metadata: row.metadata });
    const compactStoredMetadata = JSON.stringify(JSON.parse(row.metadata));
    const compactStoredHash = computeReceiptHash(row.prev_hash, { ...content, metadata: compactStoredMetadata });
    const verification = await verifyRunReceiptChain(runId);
    console.log(JSON.stringify({ case: "synthetic PostgreSQL round trip", metadataBeforeStorage,
      metadataAfterStorage: row.metadata, compactStoredMetadata, originalHash,
      storedHash: row.receipt_hash, storedTextHash, compactStoredHash, verification }));
    assert.equal(originalHash, row.receipt_hash, "original writer preimage reproduces stored hash");
    assert.deepEqual(JSON.parse(row.metadata), artifactContent, "metadata values survive JSONB storage");
    // Keep this product contract identical for the subsequent green run.
    assert.deepEqual(verification, { valid: true, checked: 1 },
      "untouched receipt must verify after storage round trip");
    assert.equal(row.metadata_serialization_version, 2);
    assert.equal(storedTextHash, row.receipt_hash);
    assert.equal(compactStoredHash, row.receipt_hash);
    // Lifecycle writers must participate in the same chain as artifact receipts.
    await client.query("begin");
    await transitionWorkflowRun(client, { runId, to: "leased", actor: "synthetic-worker",
      reason: "Synthetic lifecycle transition", idempotencyKey: "synthetic-lease" });
    await client.query("commit");
    const notification = (await client.query("select body from run_notifications where run_id=$1", [runId])).rows[0];
    assert.equal(JSON.parse(notification.body).state, "leased");
    await client.query("begin");
    await transitionWorkflowRun(client, { runId, to: "leased", actor: "synthetic-worker",
      reason: "Synthetic lifecycle transition", idempotencyKey: "synthetic-lease" });
    await client.query("commit");
    assert.equal((await client.query("select count(*)::int as count from run_notifications")).rows[0].count, 1);
    await client.query("begin");
    await transitionWorkflowRun(client, { runId, to: "cancelled", actor: "synthetic-worker",
      reason: "Synthetic cancellation", idempotencyKey: "synthetic-cancel" });
    const cancelled = (await client.query("select body from run_notifications where event_key='transition:2'")).rows[0];
    assert.equal(JSON.parse(cancelled.body).state, "cancelled");
    await client.query("rollback");
    assert.equal((await client.query("select count(*)::int as count from run_notifications")).rows[0].count, 1,
      "rolled-back transitions must not leave a deliverable notification");
    await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "synthetic_after_transition",
      target: "synthetic-target", summary: "Receipt after lifecycle transition", artifactKind: "synthetic_after",
      artifactContent: {} });
    assert.deepEqual(await verifyRunReceiptChain(runId), { valid: true, checked: 3 },
      "lifecycle transition must not introduce an unhashed gap or restart GENESIS");
    for (const mutation of [
      "metadata = '{\"a\":false}'::jsonb",
      "summary = 'altered'",
      "prev_hash = null",
      "metadata_serialization_version = null",
      "metadata_serialization_version = 99",
    ]) {
      await client.query("begin");
      await client.query(`update pg_temp.action_receipts set ${mutation}`);
      assert.equal((await verifyRunReceiptChain(runId)).valid, false, mutation);
      await client.query("rollback");
    }
    await client.query("begin");
    await client.query("insert into artifacts(run_id,kind,uri,content) values ($1,'stage_output','db://synthetic/result',$2)", [runId, JSON.stringify({ summary: "Synthetic deliverable" })]);
    await transitionWorkflowRun(client, { runId, to: "running", actor: "synthetic-worker", reason: "started", idempotencyKey: "snapshot-running" });
    await transitionWorkflowRun(client, { runId, to: "completed", actor: "synthetic-worker", reason: "finished", idempotencyKey: "snapshot-completed" });
    const frozenBody = (await client.query("select body from run_notifications where event_key='transition:3'")).rows[0].body;
    const frozen = JSON.parse(frozenBody).result;
    assert.equal(frozen.acceptance, "unverified");
    assert.deepEqual(frozen.artifacts, [{ uri: "db://synthetic/result", kind: "stage_output", contentSha256: createHash("sha256").update(JSON.stringify({ summary: "Synthetic deliverable" })).digest("hex") }]);
    await client.query("update artifacts set content='{}' where uri='db://synthetic/result'");
    assert.equal((await client.query("select body from run_notifications where event_key='transition:3'")).rows[0].body, frozenBody);
    await client.query("rollback");
    await client.query("begin");
    await appendActionReceipt(client, { runId, agentId: "workflow-orchestrator", actionType: "stage_completed", target: "synthetic-stage", summary: "Stage done", metadata: "{}" });
    await appendActionReceipt(client, { runId, agentId: "workflow-orchestrator", actionType: "action_approval_approved", target: "synthetic-target", summary: "Approved", metadata: JSON.stringify({ approvalId: "synthetic-approval", secret: "must-not-be-exported" }) });
    const stream = await replayRecordedLifecycleEvents({ projectRootUri: "/synthetic", runId });
    assert.deepEqual(stream.map(event => event.type), ["run.changed", "stage.changed", "approval.changed"]);
    assert.equal(stream.at(-1)?.subject, "synthetic-approval");
    assert.equal(JSON.stringify(stream).includes("must-not-be-exported"), false);
    assert.deepEqual(await replayRecordedLifecycleEvents({ projectRootUri: "/other", runId }), []);
    assert.deepEqual(await replayRecordedLifecycleEvents({ projectRootUri: "/synthetic", runId, after: stream[1].cursor }), [stream[2]]);
    assert.equal((await client.query("select count(*)::int as count from run_notifications where event_key like 'receipt:%'")).rows[0].count, 2);
    await client.query("rollback");
    assert.equal((await client.query("select count(*)::int as count from run_notifications where event_key like 'receipt:%'")).rows[0].count, 0);
    // Legacy hashes are never rewritten or silently canonicalized as version 2.
    const legacyHash = computeReceiptHash(row.prev_hash, { ...content, metadataSerializationVersion: undefined });
    await client.query("update pg_temp.action_receipts set metadata_serialization_version=null, receipt_hash=$1", [legacyHash]);
    assert.equal((await verifyRunReceiptChain(runId)).valid, false);
    const persisted = await client.query("select receipt_hash from pg_temp.action_receipts");
    assert.equal(persisted.rows[0].receipt_hash, legacyHash);
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end();
  }
});

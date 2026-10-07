import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl, recordRunAction, verifyRunReceiptChain, transitionWorkflowRun } from "./postgres.js";
import { computeReceiptHash } from "../../workflow-engine/src/receipt-chain.js";

// Real PostgreSQL JSONB conversion; all test relations are session-local.
test("untouched receipt survives PostgreSQL JSONB round trip", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query(`create temporary table workflow_runs (
      id uuid primary key, status text, state_version bigint default 0,
      lease_epoch bigint default 0, lease_owner text, lease_expires_at timestamptz,
      finished_at timestamptz
    )`);
    await client.query(`create temporary table workflow_run_transitions (
      run_id uuid, from_status text, to_status text, state_version bigint,
      lease_epoch bigint, actor text, reason text, idempotency_key text, metadata jsonb
    )`);
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

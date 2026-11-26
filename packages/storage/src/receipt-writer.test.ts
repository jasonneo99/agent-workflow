import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { databaseUrl, recordRunAction, verifyRunReceiptChain } from "./postgres.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { chainReceipt } from "../../workflow-engine/src/receipt-chain.js";

test("all operational receipt writers use the transactional chain append", async () => {
  for (const file of ["postgres.ts", "workflow-task-authority.ts", "workflow-task-outcomes.ts", "run-transitions.ts", "run-supersession.ts", "action-approvals.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /insert\s+into\s+action_receipts/i, file);
    assert.match(source, /appendActionReceipt/, file);
  }
});

test("concurrent PostgreSQL appends, rollback, tied clocks and complete coverage", async () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalNow = Date.now;
  const admin = new pg.Client({ connectionString: databaseUrl() });
  // Only this uniquely named synthetic schema is created and removed. No public
  // run, receipt, hash or table is changed, including on failure.
  const schema = `receipt_test_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let isolated: pg.Client | undefined;
  try {
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    created = true;
    await admin.query(`set search_path to ${schema}`);
    await admin.query("create table workflow_runs (id uuid primary key)");
    await admin.query(`create table action_receipts (
      run_id uuid references workflow_runs(id), agent_id text, action_type text,
      target text, summary text, metadata jsonb, prev_hash text, receipt_hash text,
      created_at timestamptz default now(), metadata_serialization_version integer
    )`);
    await admin.query("create table artifacts (run_id uuid, task_id uuid, kind text, uri text unique, content jsonb)");
    const url = new URL(databaseUrl());
    url.searchParams.set("options", `-csearch_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    isolated = new pg.Client({ connectionString: url.toString() });
    await isolated.connect();
    const runId = randomUUID();
    await admin.query("insert into workflow_runs (id) values ($1)", [runId]);
    const input = { runId, agentId: "synthetic", actionType: "test", target: "test", summary: "test", metadata: "{}" };
    await assert.rejects(appendActionReceipt(isolated, input), /transaction blocks/);
    Date.now = () => 1_700_000_000_000;
    // Distinct pool connections contend on an initially empty chain. A fixed
    // clock would previously produce both forks and ambiguous ordering.
    await Promise.all(Array.from({ length: 12 }, (_, i) => recordRunAction({ ...input,
      summary: `writer-${i}`, artifactKind: "test", idempotencyKey: `writer-${i}`, artifactContent: { i } })));
    Date.now = () => 1;
    await recordRunAction({ ...input, artifactKind: "clock_regression", artifactContent: {} });
    assert.deepEqual(await verifyRunReceiptChain(runId), { valid: true, checked: 13 });
    const rows = (await admin.query("select * from action_receipts order by created_at")).rows;
    assert.equal(new Set(rows.map(r => r.created_at.toISOString())).size, 13);
    await isolated.query("begin");
    await appendActionReceipt(isolated, input);
    await isolated.query("rollback");
    assert.deepEqual(await verifyRunReceiptChain(runId), { valid: true, checked: 13 });
    await admin.query("begin");
    await admin.query("update action_receipts set summary='tampered' where summary='writer-0'");
    assert.equal((await verifyRunReceiptChain(runId)).valid, true, "uncommitted tampering is invisible to other sessions");
    await admin.query("rollback");
    // Commit a synthetic gap: coverage must fail, not silently verify a suffix.
    await admin.query("insert into action_receipts (run_id,agent_id,action_type,target,summary,metadata) values ($1,'synthetic','legacy','test','unhashed','{}')", [runId]);
    const coverage = await verifyRunReceiptChain(runId);
    assert.equal(coverage.valid, false);
    assert.match(coverage.reason!, /unchained/);
    assert.equal((await verifyRunReceiptChain(randomUUID())).valid, false);

    const tiedId = randomUUID();
    await admin.query("insert into workflow_runs (id) values ($1)", [tiedId]);
    const base = { ...input, runId: tiedId, createdAt: "2026-01-01T00:00:00.000Z", metadataSerializationVersion: 2 };
    const first = chainReceipt("GENESIS", base);
    const second = chainReceipt(first.receiptHash, { ...base, summary: "second" });
    // Insert reverse timestamp-tied order; hash links still establish order.
    for (const r of [second, first]) await admin.query(`insert into action_receipts
      (run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,created_at,metadata_serialization_version)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,2)`,
    [tiedId,r.agentId,r.actionType,r.target,r.summary,r.metadata,r.prevHash,r.receiptHash,r.createdAt]);
    assert.deepEqual(await verifyRunReceiptChain(tiedId), { valid: true, checked: 2 });
    await recordRunAction({ ...input, runId: tiedId, artifactKind: "after_tie", artifactContent: {} });
    assert.deepEqual(await verifyRunReceiptChain(tiedId), { valid: true, checked: 3 }, "append selects hash tip despite timestamp ties");
    await admin.query("update action_receipts set prev_hash='GENESIS' where run_id=$1 and summary='second'", [tiedId]);
    assert.equal((await verifyRunReceiptChain(tiedId)).valid, false, "fork rejected");

    // Client clock skew in either direction: evidence written by the database
    // before the receipt stays older, and evidence written after sorts newer.
    await admin.query("create table evidence (label text, created_at timestamptz default clock_timestamp())");
    for (const [label, skewMs] of [["ahead", 86_400_000], ["behind", -86_400_000]] as const) {
      const skewId = randomUUID();
      await admin.query("insert into workflow_runs (id) values ($1)", [skewId]);
      await admin.query("insert into evidence (label) values ($1)", [`${label}-before`]);
      Date.now = () => originalNow() + skewMs;
      await recordRunAction({ ...input, runId: skewId, artifactKind: `skew_${label}`, artifactContent: {} });
      Date.now = originalNow;
      await admin.query("insert into evidence (label) values ($1)", [`${label}-after`]);
      const order = (await admin.query<{ before: boolean; after: boolean; near: boolean }>(
        `select e1.created_at < r.created_at as before, e2.created_at > r.created_at as after,
           abs(extract(epoch from r.created_at - clock_timestamp())) < 60 as near
         from action_receipts r, evidence e1, evidence e2
         where r.run_id = $1 and e1.label = $2 and e2.label = $3`, [skewId, `${label}-before`, `${label}-after`])).rows[0]!;
      assert.deepEqual(order, { before: true, after: true, near: true }, `receipt uses the database clock with client ${label}`);
    }
  } finally {
    Date.now = originalNow;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    await isolated?.end();
    if (created) await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});

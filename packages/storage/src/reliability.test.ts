import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withClient } from "./client.js";
import { claimSideEffect, finalizeSideEffect, getSideEffectReceipt } from "./reliability.js";

test("durable effect receipt lookup is exact and read-only for missing, pending, uncertain and completed effects", async () => {
  assert.ok(process.env.TEST_DATABASE_URL && process.env.DATABASE_URL === process.env.TEST_DATABASE_URL,
    "Use the repository disposable test database wrapper");
  const database = new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1);
  assert.match(database, /^agentflow_suite_test_[a-f0-9]{32}$/u);
  await withClient(async client => assert.equal((await client.query("select current_database() name")).rows[0].name, database));
  const projectId = `synthetic-receipt-${randomUUID()}`;
  const input = (idempotencyKey: string) => ({ projectId, idempotencyKey, operation: "local_command", target: "node fixture.mjs" });
  const pending = input("pending"), uncertain = input("uncertain"), completed = input("completed");
  await claimSideEffect(pending);
  await claimSideEffect(uncertain);
  await withClient(async client => { await client.query("update side_effect_receipts set claim_expires_at=now()-interval '1 second' where project_id=$1 and idempotency_key=$2", [projectId, uncertain.idempotencyKey]); });
  assert.equal((await claimSideEffect(uncertain)).status, "uncertain");
  const claim = await claimSideEffect(completed);
  const receipt = { artifactUri: "db://synthetic/command", exitCode: 0, timedOut: false };
  assert.equal(await finalizeSideEffect({ ...completed, claimToken: claim.claimToken!, receipt }), true);
  const rows = () => withClient(async client => (await client.query("select to_jsonb(e) value from side_effect_receipts e where project_id=$1 order by idempotency_key", [projectId])).rows);
  const before = await rows();
  assert.equal(await getSideEffectReceipt(input("missing")), null);
  assert.equal(await getSideEffectReceipt({ projectId: `${projectId}-foreign`, idempotencyKey: "completed" }), null);
  assert.deepEqual(await getSideEffectReceipt(pending), { status: "pending", operation: "local_command", target: pending.target, receipt: {} });
  assert.deepEqual(await getSideEffectReceipt(uncertain), { status: "uncertain", operation: "local_command", target: uncertain.target, receipt: {} });
  assert.deepEqual(await getSideEffectReceipt(completed), { status: "completed", operation: "local_command", target: completed.target, receipt });
  assert.deepEqual(await rows(), before, "Lookup must not claim, finalize, resolve or rewrite any effect");
});

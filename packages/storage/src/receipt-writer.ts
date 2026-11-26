import type pg from "pg";
import { chainReceipt, RECEIPT_CHAIN_GENESIS } from "../../workflow-engine/src/receipt-chain.js";
import { recordedLifecycleEvent } from "./recorded-lifecycle.js";
import { enqueueRunNotification } from "./run-notifications.js";

// A legacy receipt written from a fast client clock can sit ahead of the
// database clock; ordering still holds through the +1 ms rule, without stalling.
const MAX_CLOCK_WAIT_SECONDS = 0.05;

/** Append inside the caller's transaction so the action and its receipt are atomic.
 * The parent row lock serializes every writer, including an empty chain.
 * Timestamps come from the database clock, the same clock artifacts and other
 * rows use, so client clock skew cannot order a receipt after later evidence.
 * They stay strictly increasing at millisecond precision (the hashed format):
 * the receipt takes the next whole millisecond and the writer waits out that
 * sub-millisecond gap, so any row written afterwards sorts after it.
 */
export async function appendActionReceipt(client: pg.Client, input: {
  runId: string; agentId: string; actionType: string; target: string;
  summary: string; metadata: string;
}): Promise<void> {
  // A savepoint deliberately rejects accidental autocommit callers.
  await client.query("savepoint receipt_append");
  const run = await client.query("select id from workflow_runs where id = $1::uuid for update", [input.runId]);
  if (!run.rows.length) throw new Error("Cannot append a receipt without its workflow run");
  const previous = await client.query<{ receipt_hash: string | null; created_at: Date }>(
    `select receipt_hash, created_at from action_receipts
     where run_id = $1::uuid order by created_at desc limit 1`, [input.runId]);
  const latest = previous.rows[0];
  // Never silently restart a chain after an unhashed lifecycle receipt.
  const tip = await client.query<{ receipt_hash: string }>(
    `select r.receipt_hash from action_receipts r where r.run_id = $1::uuid
     and r.receipt_hash is not null and not exists (
       select 1 from action_receipts child where child.run_id = r.run_id
       and child.prev_hash = r.receipt_hash
     ) order by r.created_at desc limit 1`, [input.runId]);
  const clock = await client.query<{ created_at: Date }>(
    `with next as (
       select greatest(date_trunc('milliseconds', clock_timestamp()) + interval '1 millisecond',
         coalesce($1::timestamptz + interval '1 millisecond', '-infinity'::timestamptz)) as created_at
     )
     select created_at, pg_sleep(least(${MAX_CLOCK_WAIT_SECONDS}, greatest(0, extract(epoch from created_at - clock_timestamp()))::double precision))
     from next`, [latest?.created_at ?? null]);
  const createdAt = clock.rows[0]!.created_at.toISOString();
  const receipt = chainReceipt(tip.rows[0]?.receipt_hash ?? RECEIPT_CHAIN_GENESIS, {
    ...input, createdAt, metadataSerializationVersion: 2,
  });
  await client.query(
    `insert into action_receipts (run_id, agent_id, action_type, target, summary,
      metadata, prev_hash, receipt_hash, created_at, metadata_serialization_version)
     values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz, 2)`,
    [input.runId, input.agentId, input.actionType, input.target, input.summary,
      input.metadata, receipt.prevHash, receipt.receiptHash, createdAt]);
  const approvalId = input.actionType.startsWith("action_approval_") ? JSON.parse(input.metadata)?.approvalId : null;
  const event = recordedLifecycleEvent({ ...input, receiptHash: receipt.receiptHash, createdAt,
    approvalId: typeof approvalId === "string" ? approvalId : null });
  // Run transitions and initial approval requests already have outbox writers.
  if (event && !["workflow_run_transition", "workflow_replayed", "action_approval_requested"].includes(input.actionType)) {
    await enqueueRunNotification(client, { runId: input.runId, kind: "progress",
      eventKey: `receipt:${receipt.receiptHash}`, title: input.actionType.replaceAll("_", " "), body: JSON.stringify(event) });
  }
  await client.query("release savepoint receipt_append");
}

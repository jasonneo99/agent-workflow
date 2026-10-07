import type pg from "pg";
import { chainReceipt, RECEIPT_CHAIN_GENESIS } from "../../workflow-engine/src/receipt-chain.js";
import { recordedLifecycleEvent } from "./recorded-lifecycle.js";
import { enqueueRunNotification } from "./run-notifications.js";

/** Append inside the caller's transaction so the action and its receipt are atomic.
 * The parent row lock serializes every writer, including an empty chain. Keep
 * timestamps strictly increasing at JavaScript's millisecond precision so ties
 * and a backwards wall clock cannot reorder newly written receipts.
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
  const createdAt = new Date(Math.max(Date.now(), latest ? latest.created_at.getTime() + 1 : 0)).toISOString();
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

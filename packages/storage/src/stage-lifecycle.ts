import type pg from "pg";
import { appendActionReceipt } from "./receipt-writer.js";

/** Caller owns the transaction and run lifecycle decision. Emit only for rows
 * changed by this statement, preserving completed and already-terminal stages.
 */
export async function cancelRemainingWorkflowStages(client: pg.Client, input: {
  runId: string; exceptTaskId?: string; reason: string;
}): Promise<number> {
  await client.query("savepoint stage_cancellations");
  const cancelled = await client.query<{ id: string; agent_id: string }>(
    `update workflow_tasks set status='cancelled', finished_at=now()
     where run_id=$1::uuid and ($2::uuid is null or id<>$2::uuid)
       and status in ('queued','leased','running') returning id::text, agent_id`,
    [input.runId, input.exceptTaskId ?? null]);
  for (const task of cancelled.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    await appendActionReceipt(client, {
      runId: input.runId, agentId: task.agent_id, actionType: "stage_cancelled",
      target: task.id, summary: input.reason,
      metadata: JSON.stringify({ nextStatus: "cancelled", causeTaskId: input.exceptTaskId ?? null })
    });
  }
  await client.query("release savepoint stage_cancellations");
  return cancelled.rowCount ?? 0;
}

import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";

export async function supersedeWorkflowRun(input: {
  runId: string;
  actor: string;
  reason: string;
  supersededBy?: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
    // Lock before the duplicate check, including concurrent superseders.
    await client.query("select id from workflow_runs where id = $1::uuid for update", [input.runId]);
    const result = await client.query<{ id: string }>(
      `select wr.id::text
       from workflow_runs wr
       where wr.id = $1::uuid
         and wr.status in ('failed', 'blocked', 'cancelled')
         and not exists (
           select 1 from action_receipts existing
           where existing.run_id = wr.id and existing.action_type = 'failed_run_superseded'
         )`,
      [input.runId]
    );
    if (result.rows[0]) await appendActionReceipt(client, { runId: input.runId,
      agentId: "workflow-orchestrator", actionType: "failed_run_superseded", target: input.runId,
      summary: input.reason, metadata: JSON.stringify({ actor: input.actor, reason: input.reason, supersededBy: input.supersededBy ?? null }) });
    await client.query("commit");
    return Boolean(result.rows[0]);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

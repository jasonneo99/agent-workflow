import { withClient } from "./client.js";

export async function supersedeWorkflowRun(input: {
  runId: string;
  actor: string;
  reason: string;
  supersededBy?: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
       select wr.id, 'workflow-orchestrator', 'failed_run_superseded', wr.id::text, $2, $3
       from workflow_runs wr
       where wr.id = $1::uuid
         and wr.status in ('failed', 'blocked', 'cancelled')
         and not exists (
           select 1 from action_receipts existing
           where existing.run_id = wr.id and existing.action_type = 'failed_run_superseded'
         )
       returning id::text`,
      [input.runId, input.reason, JSON.stringify({ actor: input.actor, reason: input.reason, supersededBy: input.supersededBy ?? null })]
    );
    return Boolean(result.rows[0]);
  });
}

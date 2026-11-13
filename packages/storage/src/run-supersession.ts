import { withClient } from "./client.js";
import { appendActionReceipt } from "./receipt-writer.js";
import {assertGenericRunRecoveryAllowed} from './managed-run-recovery.js';

export async function supersedeWorkflowRun(input: {
  runId: string;
  actor: string;
  reason: string;
  supersededBy?: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
    await assertGenericRunRecoveryAllowed(client,input.runId,'supersede');
    const { acceptanceDigest, acceptancePreflight } = await import("./acceptance.js");
    if (!input.supersededBy || input.supersededBy === input.runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.supersededBy)) { await client.query("rollback"); return false; }
    const identities = await client.query<{ id: string; projectId: string; workflowId: string; task: string; status: string; contract: import("../../model-providers/src/types.js").StructuredAcceptanceContract | null }>(`select id::text, project_id::text as "projectId", workflow_id as "workflowId", task, status, evaluation_metadata->'acceptanceContract' as contract from workflow_runs where id=any($1::uuid[]) order by id for update`, [[input.runId, input.supersededBy]]);
    const source = identities.rows.find((row) => row.id === input.runId);
    const replacement = identities.rows.find((row) => row.id === input.supersededBy);
    const requirements = (contract: NonNullable<typeof source> ["contract"]) => contract && ({ version: contract.version, projectId: contract.projectId, taskHash: contract.taskHash, sourcePaths: contract.sourcePaths, deliverables: contract.deliverables.map(({ id, description, requiredGates, advisory, severity }) => ({ id, description, requiredGates, advisory, severity })) });
    if (!source || !replacement || replacement.status !== "completed" || source.projectId !== replacement.projectId || source.workflowId !== replacement.workflowId || source.task !== replacement.task || !source.contract || !replacement.contract || source.contract.projectId !== source.projectId || replacement.contract.projectId !== replacement.projectId || replacement.contract.originRunId !== replacement.id || source.contract.taskHash !== acceptanceDigest(source.task) || replacement.contract.taskHash !== acceptanceDigest(replacement.task) || acceptanceDigest(requirements(source.contract)) !== acceptanceDigest(requirements(replacement.contract))) {
      await client.query("rollback");
      return false;
    }
    const readiness = await client.query<{ ready: boolean }>(`select exists(select 1 from workflow_tasks where run_id=$1::uuid) and not exists(select 1 from workflow_tasks where run_id=$1::uuid and status<>'completed') and not exists(select 1 from action_approvals where run_id=any($2::uuid[]) and (status='pending' or (status='approved' and executed_at is null) or status='failed')) and exists(select 1 from workflow_tasks verifier where verifier.run_id=$1::uuid and verifier.status='completed' and verifier.agent_id='auto-test-runner' and verifier.output_uri is not null and not exists(select 1 from workflow_tasks implementation where implementation.run_id=verifier.run_id and implementation.agent_id=verifier.agent_id and implementation.stage_id ~ '^(implement|fix|backend|frontend|database)')) as ready`, [replacement.id, [source.id, replacement.id]]);
    const output = await client.query<{ content: Record<string, unknown> }>(`select a.content from artifacts a join workflow_tasks t on t.id=a.task_id and t.run_id=a.run_id where a.run_id=$1::uuid and a.kind='stage_output' and t.status='completed' order by t.finished_at desc, a.created_at desc, a.id desc limit 1`, [replacement.id]);
    const preflight = readiness.rows[0]?.ready && output.rows[0] ? await acceptancePreflight(client, replacement.id, output.rows[0].content) : null;
    if (!preflight?.accepted) {
      await client.query("rollback");
      return false;
    }
    // Both identities remain locked; recovery links and historical receipts are unchanged.
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

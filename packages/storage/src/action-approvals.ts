import { transitionWorkflowRun } from "./run-transitions.js";
import { withClient } from "./client.js";

export interface ActionApprovalStatus {
  id: string;
  runId: string;
  taskId: string | null;
  stageId: string;
  agentId: string;
  actionType: string;
  target: string;
  status: string;
  rationale: string;
  policyDecision: Record<string, unknown>;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  decidedBy: string | null;
  decidedRole: string | null;
  decidedAt: string | null;
  executedBy: string | null;
  executedRole: string | null;
  executedAt: string | null;
  executionClaimToken: string | null;
  executionClaimExpiresAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
  workflowId: string;
  workflowTask: string;
  projectName: string;
  projectRootUri: string;
}

const actionApprovalSelect = `
  aa.id::text,
  aa.run_id::text as "runId",
  aa.task_id::text as "taskId",
  aa.stage_id as "stageId",
  aa.agent_id as "agentId",
  aa.action_type as "actionType",
  aa.target,
  aa.status,
  aa.rationale,
  aa.policy_decision as "policyDecision",
  aa.payload,
  aa.idempotency_key as "idempotencyKey",
  aa.decided_by as "decidedBy",
  aa.decided_role as "decidedRole",
  aa.decided_at::text as "decidedAt",
  aa.executed_by as "executedBy",
  aa.executed_role as "executedRole",
  aa.executed_at::text as "executedAt",
  aa.execution_claim_token::text as "executionClaimToken",
  aa.execution_claim_expires_at::text as "executionClaimExpiresAt",
  aa.decision_note as "decisionNote",
  aa.created_at::text as "createdAt",
  aa.updated_at::text as "updatedAt",
  wr.workflow_id as "workflowId",
  wr.task as "workflowTask",
  p.name as "projectName",
  p.root_uri as "projectRootUri"
`;

export async function requestActionApproval(input: {
  runId: string;
  taskId?: string | null;
  stageId: string;
  agentId: string;
  actionType: string;
  target: string;
  rationale: string;
  policyDecision: Record<string, unknown>;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ approvalId: string; artifactUri: string; status: string }> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const approval = await client.query<{ id: string; status: string }>(
        input.taskId === null || input.taskId === undefined
          ? `with existing as (
               update action_approvals
               set updated_at = now()
               where run_id = $1::uuid
                 and task_id is null
                 and action_type = $5
                 and idempotency_key = $10
               returning id::text, status
             ), inserted as (
               insert into action_approvals (
                 run_id, task_id, stage_id, agent_id, action_type, target,
                 rationale, policy_decision, payload, idempotency_key
               )
               select $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10
               where not exists (select 1 from existing)
               returning id::text, status
             )
             select * from existing
             union all
             select * from inserted`
          : `insert into action_approvals (
               run_id, task_id, stage_id, agent_id, action_type, target,
               rationale, policy_decision, payload, idempotency_key
             )
             values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (run_id, task_id, action_type, idempotency_key) do update
             set updated_at = now()
             returning id::text, status`,
        [
          input.runId,
          input.taskId ?? null,
          input.stageId,
          input.agentId,
          input.actionType,
          input.target,
          input.rationale,
          JSON.stringify(input.policyDecision),
          JSON.stringify(input.payload),
          input.idempotencyKey
        ]
      );
      const approvalId = approval.rows[0].id;
      const artifactContent = {
        approvalId,
        actionType: input.actionType,
        target: input.target,
        rationale: input.rationale,
        policyDecision: input.policyDecision,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        requestedByTaskId: input.taskId,
        requestedByStageId: input.stageId,
        status: approval.rows[0].status
      };
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, $2, 'action_approval_requested', $3, $4, $5)`,
        [
          input.runId,
          input.agentId,
          input.target,
          `Approval requested for ${input.actionType}: ${input.target}`,
          JSON.stringify(artifactContent)
        ]
      );
      const artifactUri = `db://workflow_runs/${input.runId}/action_approval/${input.idempotencyKey}`;
      await client.query(
        `insert into artifacts (run_id, task_id, kind, uri, content)
         values ($1::uuid, $2::uuid, 'action_approval', $3, $4)
         on conflict (uri) do update
         set content = excluded.content`,
        [
          input.runId,
          input.taskId ?? null,
          artifactUri,
          JSON.stringify(artifactContent)
        ]
      );
      await client.query("commit");
      return { approvalId, artifactUri, status: approval.rows[0].status };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function completeApprovalRequestRun(input: {
  runId: string;
  agentId: string;
  summary: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `update workflow_tasks
         set status = 'completed',
             finished_at = now()
         where run_id = $1::uuid
           and status = 'queued'`,
        [input.runId]
      );
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, $2, 'approval_request_completed', $3, $4, $5)`,
        [
          input.runId,
          input.agentId,
          String(input.metadata.target ?? "approval-request"),
          input.summary,
          JSON.stringify(input.metadata)
        ]
      );
      await transitionWorkflowRun(client, { runId: input.runId, to: "leased", actor: input.agentId, reason: "Approval-only run was claimed by the approval service.", idempotencyKey: "approval-run-leased" });
      await transitionWorkflowRun(client, { runId: input.runId, to: "running", actor: input.agentId, reason: "Approval-only run processing started.", idempotencyKey: "approval-run-running" });
      await transitionWorkflowRun(client, { runId: input.runId, to: "completed", actor: input.agentId, reason: input.summary, idempotencyKey: "approval-run-completed" });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function listActionApprovals(input: {
  status?: string;
  runId?: string;
  projectRootUri?: string;
  limit?: number;
} = {}): Promise<ActionApprovalStatus[]> {
  return withClient(async (client) => {
    const result = await client.query<ActionApprovalStatus>(
      `select ${actionApprovalSelect}
       from action_approvals aa
       join workflow_runs wr on wr.id = aa.run_id
       join projects p on p.id = wr.project_id
       where ($1::text is null or aa.status = $1)
         and ($2::uuid is null or aa.run_id = $2::uuid)
         and ($3::text is null or p.root_uri = $3)
       order by
         case aa.status when 'pending' then 0 when 'approved' then 1 when 'failed' then 2 when 'dismissed' then 3 when 'executed' then 4 when 'rejected' then 5 else 6 end,
         aa.created_at desc
       limit $4`,
      [input.status ?? null, input.runId ?? null, input.projectRootUri ?? null, input.limit ?? 50]
    );
    return result.rows;
  });
}

export async function getActionApproval(approvalId: string): Promise<ActionApprovalStatus | null> {
  return withClient(async (client) => {
    const result = await client.query<ActionApprovalStatus>(
      `select ${actionApprovalSelect}
       from action_approvals aa
       join workflow_runs wr on wr.id = aa.run_id
       join projects p on p.id = wr.project_id
       where aa.id = $1::uuid
       limit 1`,
      [approvalId]
    );
    return result.rows[0] ?? null;
  });
}

export async function dismissSupersededActionApprovals(input: {
  runId: string;
  taskId: string;
  actionType: "local_command" | "file_write";
  target: string;
  actor: string;
}): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query(
      `update action_approvals
          set status = 'dismissed',
              decided_by = coalesce(decided_by, $5),
              decided_role = coalesce(decided_role, 'operator'),
              decided_at = coalesce(decided_at, now()),
              decision_note = concat_ws(E'\n', nullif(decision_note, ''), 'Superseded after the worker executed the same policy-allowed action directly.'),
              updated_at = now()
        where run_id = $1::uuid
          and task_id = $2::uuid
          and action_type = $3
          and target = $4
          and status in ('pending', 'approved', 'failed')`,
      [input.runId, input.taskId, input.actionType, input.target, input.actor]
    );
    return result.rowCount ?? 0;
  });
}

export async function decideActionApproval(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  actor: string;
  actorRole?: string;
  note?: string;
}): Promise<ActionApprovalStatus | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<ActionApprovalStatus>(
        `update action_approvals aa
         set status = $2,
             decided_by = $3,
             decided_at = now(),
             decision_note = $4,
             decided_role = $5,
             updated_at = now()
         from workflow_runs wr, projects p
         where aa.id = $1::uuid
           and aa.status = 'pending'
           and wr.id = aa.run_id
           and p.id = wr.project_id
         returning ${actionApprovalSelect}`,
        [input.approvalId, input.decision, input.actor, input.note ?? null, input.actorRole ?? null]
      );
      const approval = result.rows[0];
      if (!approval) {
        await client.query("rollback");
        return null;
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, $2, $3, $4, $5, $6)`,
        [
          approval.runId,
          approval.agentId,
          `action_approval_${input.decision}`,
          approval.target,
          `${input.decision} by ${input.actor}${input.note ? `: ${input.note}` : ""}`,
          JSON.stringify({
            approvalId: approval.id,
            decision: input.decision,
            actor: input.actor,
            actorRole: input.actorRole ?? null,
            note: input.note ?? "",
            actionType: approval.actionType,
            target: approval.target,
            idempotencyKey: approval.idempotencyKey
          })
        ]
      );
      await client.query("commit");
      return approval;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function markActionApprovalExecution(input: {
  approvalId: string;
  status: "executed" | "failed" | "dismissed";
  actor: string;
  actorRole?: string;
  summary: string;
  artifactUri?: string;
  error?: string;
  executionClaimToken?: string;
}): Promise<ActionApprovalStatus | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<ActionApprovalStatus>(
        `update action_approvals aa
         set status = $2,
             decided_by = coalesce(aa.decided_by, $3),
             decided_role = coalesce(aa.decided_role, $5),
             decided_at = coalesce(aa.decided_at, now()),
             executed_by = $3,
             executed_role = $5,
             executed_at = now(),
             decision_note = concat_ws(E'\n', nullif(aa.decision_note, ''), $4::text),
             updated_at = now()
         from workflow_runs wr, projects p
         where aa.id = $1::uuid
           and aa.status in ('approved', 'failed', 'executing')
           and ($6::uuid is null or (
             aa.status = 'executing'
             and aa.execution_claim_token = $6::uuid
             and aa.execution_claim_expires_at > now()
           ))
           and wr.id = aa.run_id
           and p.id = wr.project_id
         returning ${actionApprovalSelect}`,
        [input.approvalId, input.status, input.actor, input.summary, input.actorRole ?? null, input.executionClaimToken ?? null]
      );
      const approval = result.rows[0];
      if (!approval) {
        await client.query("rollback");
        if (input.executionClaimToken) throw new Error("Approval execution claim was lost before finalization.");
        return null;
      }
      if (input.status === "executed") {
        await client.query(
          `update action_approvals
              set status = 'dismissed',
                  decision_note = concat_ws(E'\n', nullif(decision_note, ''), 'Superseded by a successfully executed approval for the same action.'),
                  updated_at = now()
            where id <> $1::uuid
              and run_id = $2::uuid
              and task_id is not distinct from $3::uuid
              and action_type = $4
              and target = $5
              and status in ('pending', 'approved', 'failed')`,
          [approval.id, approval.runId, approval.taskId, approval.actionType, approval.target]
        );
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, $2, $3, $4, $5, $6)`,
        [
          approval.runId,
          approval.agentId,
          `action_approval_${input.status}`,
          approval.target,
          input.summary,
          JSON.stringify({
            approvalId: approval.id,
            status: input.status,
            actor: input.actor,
            actorRole: input.actorRole ?? null,
            actionType: approval.actionType,
            target: approval.target,
            idempotencyKey: approval.idempotencyKey,
            artifactUri: input.artifactUri,
            error: input.error
          })
        ]
      );
      await client.query("commit");
      return approval;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function claimActionApprovalExecution(input: {
  approvalId: string;
  actor: string;
  actorRole?: string;
  claimSeconds?: number;
}): Promise<{ approval: ActionApprovalStatus; claimToken: string } | null> {
  const claimSeconds = Math.max(30, Math.min(3600, input.claimSeconds ?? 300));
  return withClient(async (client) => {
    const result = await client.query<ActionApprovalStatus>(
      `update action_approvals aa
       set status = 'executing',
           execution_claim_token = gen_random_uuid(),
           execution_claim_expires_at = now() + ($4::int * interval '1 second'),
           executed_by = $2,
           executed_role = $3,
           updated_at = now()
       from workflow_runs wr, projects p
       where aa.id = $1::uuid
         and (
           aa.status in ('approved', 'failed')
           or (aa.status = 'executing' and aa.execution_claim_expires_at <= now())
         )
         and wr.id = aa.run_id
         and p.id = wr.project_id
       returning ${actionApprovalSelect}`,
      [input.approvalId, input.actor, input.actorRole ?? null, claimSeconds]
    );
    const approval = result.rows[0];
    return approval?.executionClaimToken ? { approval, claimToken: approval.executionClaimToken } : null;
  });
}

export async function recoverInterruptedActionApprovalExecutions(input: {
  actor: string;
}): Promise<ActionApprovalStatus[]> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<ActionApprovalStatus>(
        `update action_approvals aa
         set status = 'approved',
             execution_claim_token = null,
             execution_claim_expires_at = null,
             updated_at = now()
         from workflow_runs wr, projects p
         where aa.status = 'executing'
           and aa.executed_by = $1
           and aa.executed_at is null
           and wr.id = aa.run_id
           and p.id = wr.project_id
         returning ${actionApprovalSelect}`,
        [input.actor]
      );
      for (const approval of result.rows) {
        await client.query(
          `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
           values ($1::uuid, $2, 'action_approval_execution_recovered', $3, $4, $5)`,
          [
            approval.runId,
            approval.agentId,
            approval.target,
            `Recovered an interrupted ${approval.actionType} execution owned by ${input.actor}; the approved action is eligible for a fresh idempotent execution attempt.`,
            JSON.stringify({ approvalId: approval.id, actor: input.actor, priorStatus: "executing", nextStatus: "approved" })
          ]
        );
      }
      await client.query("commit");
      return result.rows;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

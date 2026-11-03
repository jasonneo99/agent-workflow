import { withClient } from "./client.js";
import { assertActiveTaskFence } from "./workflow-task-authority.js";
import { cancelRemainingWorkflowStages } from "./stage-lifecycle.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { transitionWorkflowRun } from "./run-transitions.js";
import { isWorkflowRunState } from "./run-state-machine.js";
import { acceptanceDigest, acceptanceGate, acceptancePreflight, storedAcceptanceDecision } from "./acceptance.js";


export async function cancelWorkflowRun(runId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query<{ status: string }>(`select status from workflow_runs where id = $1::uuid`, [runId]);
      if (!current.rows[0] || !isWorkflowRunState(current.rows[0].status) || ["completed", "blocked", "failed", "cancelled"].includes(current.rows[0].status)) {
        await client.query("rollback");
        return false;
      }
      await transitionWorkflowRun(client, { runId, to: "cancelled", actor: "operator", reason: "Run cancellation requested.", idempotencyKey: `cancel:${runId}` });
      await cancelRemainingWorkflowStages(client, { runId, reason: "Stage cancelled by run cancellation." });
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function completeWorkflowTask(input: {
  taskId: string;
  runId: string;
  agentId: string;
  summary: string;
  artifact: Record<string, unknown>;
  workerId: string;
  fencingToken: string;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      const claim = await assertActiveTaskFence(client, input);
      const identity = await client.query<{ stageId: string }>(
        `select stage_id as "stageId" from workflow_tasks where id=$1 and run_id=$2`, [input.taskId, input.runId]
      );
      const gate = acceptanceGate(identity.rows[0]?.stageId ?? "");
      if (gate) {
        const acceptance = await storedAcceptanceDecision(client, input.runId, gate, input.artifact);
        if (acceptance.reason) throw new Error(`Structured acceptance rejected completion: ${acceptance.reason}`);
        if (acceptance.mode === "structured") input.artifact = { ...input.artifact, acceptanceDecision: acceptance };
      }
      const outputUri = `db://workflow_tasks/${input.taskId}/output`;
      await client.query(
        `insert into artifacts (run_id, task_id, kind, uri, content)
         values ($1, $2, 'stage_output', $3, $4)
         on conflict (uri) do update
         set content = excluded.content`,
        [
          input.runId,
          input.taskId,
          outputUri,
          JSON.stringify(input.artifact)
        ]
      );
      await client.query(
        `update workflow_tasks
         set status = 'completed',
             output_uri = $2,
             finished_at = now()
         where id = $1`,
        [input.taskId, outputUri]
      );

      const completedStage = await client.query<{ stageId: string }>(
        `select stage_id as "stageId" from workflow_tasks where id = $1`, [input.taskId]
      );
      if (completedStage.rows[0]) {
        await client.query(
          `update workflow_handoffs
           set transferred_artifacts = transferred_artifacts || $3::jsonb, updated_at = now()
           where run_id = $1 and source_stage_id = $2 and status in ('proposed', 'retrying')`,
          [input.runId, completedStage.rows[0].stageId, JSON.stringify([{ uri: outputUri, kind: "stage_output", summary: input.summary }])]
        );
        const finishedHandoffs = await client.query<{ id: string }>(
          `update workflow_handoffs set status = 'completed', completed_at = now(), updated_at = now()
           where run_id = $1 and destination_stage_id = $2 and status = 'accepted'
           returning id::text`, [input.runId, completedStage.rows[0].stageId]
        );
        for (const handoff of finishedHandoffs.rows) {
          await client.query(
            `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, metadata)
             values ($1, $2, 'completed', $3, $4)`,
            [handoff.id, input.runId, input.agentId, JSON.stringify({ outputUri })]
          );
        }
      }

      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: input.agentId,
        actionType: "stage_completed",
        target: input.taskId,
        summary: input.summary,
        metadata: JSON.stringify(input.artifact)
      });

      const ready = await client.query<{ id: string }>(
        `select wr.id::text
         from workflow_runs wr
         where wr.id = $1
           and not exists (
             select 1
             from workflow_tasks wt
             where wt.run_id = wr.id
               and wt.status in ('queued', 'leased', 'running', 'failed', 'blocked')
           )
         for update`,
        [input.runId]
      );
      if (ready.rows[0]) {
        const terminalAcceptance = await acceptancePreflight(client, input.runId, input.artifact);
        if (terminalAcceptance.decisions.some((decision) => decision.mode === "structured" || decision.reason)
          && !terminalAcceptance.accepted) {
          throw new Error(`Structured acceptance rejected terminal completion: ${terminalAcceptance.decisions
            .filter((decision) => decision.reason).map((decision) => `${decision.gate}: ${decision.reason}`).join("; ")}`);
        }
        await client.query(
          `insert into artifacts(run_id,task_id,kind,uri,content) values ($1,$2,'terminal_acceptance',$3,$4)`,
          [input.runId, input.taskId, `db://workflow_runs/${input.runId}/terminal_acceptance/${input.taskId}`, JSON.stringify(terminalAcceptance)]
        );
        await transitionWorkflowRun(client, {
          runId: input.runId,
          to: "completed",
          actor: input.workerId,
          reason: "All workflow tasks completed.",
          idempotencyKey: `run-completed:${input.taskId}:${input.fencingToken}`,
          metadata: { taskId: input.taskId }
        });
      } else {
        await client.query(
          `update workflow_runs set lease_owner = null, lease_expires_at = null
           where id = $1::uuid and lease_owner = $2 and lease_epoch = $3::bigint
             and not exists (
               select 1 from workflow_tasks sibling
               where sibling.run_id = $1::uuid
                 and sibling.id <> $4::uuid
                 and sibling.status in ('leased', 'running')
             )`,
          [input.runId, input.workerId, claim.runLeaseEpoch, input.taskId]
        );
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function blockWorkflowTask(input: {
  taskId: string;
  runId: string;
  agentId: string;
  summary: string;
  reason: string;
  artifact: Record<string, unknown>;
  workerId: string;
  fencingToken: string;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await assertActiveTaskFence(client, input);
      const outputUri = `db://workflow_tasks/${input.taskId}/output`;
      const normalizedArtifact = JSON.parse(JSON.stringify(input.artifact)) as Record<string, unknown>;
      await client.query(
        `insert into artifacts (run_id, task_id, kind, uri, content)
         values ($1, $2, 'stage_output', $3, $4)
         on conflict (uri) do update set content = excluded.content`,
        [input.runId, input.taskId, outputUri, JSON.stringify(normalizedArtifact)]
      );
      await client.query(
        `update workflow_tasks set status = 'blocked', output_uri = $2, finished_at = now() where id = $1`,
        [input.taskId, outputUri]
      );
      await cancelRemainingWorkflowStages(client, { runId: input.runId, exceptTaskId: input.taskId,
        reason: "Stage cancelled because another stage blocked the run." });
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: input.agentId,
        actionType: "stage_blocked",
        target: input.taskId,
        summary: input.summary,
        metadata: JSON.stringify({ reason: input.reason, outputUri, outputDigest: acceptanceDigest(normalizedArtifact) })
      });
      await client.query(
        `update workflow_handoffs
         set status = 'failed', failed_at = now(), updated_at = now()
         where run_id = $1 and destination_stage_id = (select stage_id from workflow_tasks where id = $2)
           and status in ('proposed', 'accepted', 'retrying')`,
        [input.runId, input.taskId]
      );
      await transitionWorkflowRun(client, {
        runId: input.runId,
        to: "blocked",
        actor: input.workerId,
        reason: input.reason,
        idempotencyKey: `run-blocked:${input.taskId}:${input.fencingToken}`,
        metadata: { taskId: input.taskId }
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function failWorkflowTask(input: {
  taskId: string;
  runId: string;
  agentId: string;
  error: string;
  workerId: string;
  fencingToken: string;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await assertActiveTaskFence(client, input);
      await client.query(
        `update workflow_tasks
         set status = 'failed',
             finished_at = now()
         where id = $1`,
        [input.taskId]
      );
      const failedStage = await client.query<{ stageId: string }>(
        `select stage_id as "stageId" from workflow_tasks where id = $1`, [input.taskId]
      );
      if (failedStage.rows[0]) {
        const failedHandoffs = await client.query<{ id: string }>(
          `update workflow_handoffs set status = 'failed', failed_at = now(), updated_at = now()
           where run_id = $1 and destination_stage_id = $2 and status = 'accepted' returning id::text`,
          [input.runId, failedStage.rows[0].stageId]
        );
        for (const handoff of failedHandoffs.rows) {
          await client.query(
            `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, note, metadata)
             values ($1, $2, 'failed', $3, $4, $5)`,
            [handoff.id, input.runId, input.agentId, input.error, JSON.stringify({ taskId: input.taskId })]
          );
        }
      }

      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: input.agentId,
        actionType: "stage_failed",
        target: input.taskId,
        summary: input.error,
        metadata: JSON.stringify({ error: input.error })
      });

      await cancelRemainingWorkflowStages(client, { runId: input.runId, exceptTaskId: input.taskId,
        reason: "Stage cancelled because another stage failed the run." });

      await transitionWorkflowRun(client, {
        runId: input.runId,
        to: "failed",
        actor: input.workerId,
        reason: input.error,
        idempotencyKey: `run-failed:${input.taskId}:${input.fencingToken}`,
        metadata: { taskId: input.taskId }
      });

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

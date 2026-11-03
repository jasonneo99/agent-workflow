import type pg from "pg";
import { withClient } from "./client.js";
import { holdWorkflowTaskForApprovalsOnClient } from "./approval-waits.js";
import { appendActionReceipt } from "./receipt-writer.js";
import { transitionWorkflowRun } from "./run-transitions.js";
import { isWorkflowRunState } from "./run-state-machine.js";

/** Persist unfinished stage state and yield its lease without promoting the stage. */
export async function checkpointWorkflowTaskContinuation(input: {
  taskId: string; runId: string; agentId: string; workerId: string; fencingToken: string;
  continuation: Record<string, unknown>; delaySeconds: number;
}): Promise<void> {
  if (!Number.isInteger(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 3600) {
    throw new Error("Continuation delay must be an integer between 1 and 3600 seconds.");
  }
  const content = JSON.stringify(input.continuation);
  if (Buffer.byteLength(content, "utf8") > 4_000_000) throw new Error("Continuation checkpoint exceeds the 4000000-byte limit.");
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await assertActiveTaskFence(client, input);
      const owner = await client.query(`select 1 from workflow_tasks where id=$1::uuid and run_id=$2::uuid and agent_id=$3`, [input.taskId, input.runId, input.agentId]);
      if (owner.rowCount !== 1) throw new Error("Continuation task identity mismatch.");
      const uri = `db://workflow_tasks/${input.taskId}/continuation`;
      await client.query(`insert into artifacts (run_id, task_id, kind, uri, content) values ($1::uuid,$2::uuid,'stage_continuation',$3,$4::jsonb) on conflict (uri) do update set content=excluded.content`, [input.runId, input.taskId, uri, content]);
      await client.query(`update workflow_tasks set status='queued', started_at=null, finished_at=null, worker_id=null, lease_expires_at=null, available_at=now()+($3::int * interval '1 second') where id=$1::uuid and run_id=$2::uuid`, [input.taskId, input.runId, input.delaySeconds]);
      await client.query(`update workflow_runs set lease_owner=null, lease_expires_at=null where id=$1::uuid and lease_owner=$2 and lease_epoch=$3::bigint and not exists (select 1 from workflow_tasks where run_id=$1::uuid and status in ('leased','running'))`, [input.runId, input.workerId, input.fencingToken]);
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: input.agentId,
        actionType: "stage_continuation_scheduled",
        target: input.taskId,
        summary: "Unfinished stage checkpointed for bounded continuation.",
        metadata: JSON.stringify({ uri, delaySeconds: input.delaySeconds, fencingToken: input.fencingToken })
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

// Continuations use a separate artifact kind; they are never completed-stage
// outputs and cannot satisfy downstream dependency or checkpoint promotion.

export async function holdWorkflowTaskForApprovals(input: Parameters<typeof holdWorkflowTaskForApprovalsOnClient>[1]): Promise<"waiting" | "resolved" | "declined"> {
  return withClient(async client => {
    await client.query("begin");
    try {
      await assertActiveTaskFence(client, input);
      const owner = await client.query(`select 1 from workflow_tasks where id=$1::uuid and run_id=$2::uuid and agent_id=$3`, [input.taskId, input.runId, input.agentId]);
      if (owner.rowCount !== 1) throw new Error("Approval wait task identity mismatch.");
      const state = await holdWorkflowTaskForApprovalsOnClient(client, input);
      await client.query("commit");
      return state;
    } catch (error) { await client.query("rollback"); throw error; }
  });
}
export function workflowRunLeaseTransitionKey(taskId:string,leaseEpoch:string):string {
  return `run-leased:${taskId}:${leaseEpoch}`;
}

export async function acquireWorkflowRunLease(client: pg.Client, input: {
  runId: string;
  workerId: string;
  leaseSeconds: number;
  taskId: string;
}): Promise<string> {
  const locked = await client.query<{ status: string; leaseEpoch: string; leaseOwner: string | null }>(
    `select status, lease_epoch::text as "leaseEpoch", lease_owner as "leaseOwner" from workflow_runs where id = $1::uuid for update`,
    [input.runId]
  );
  const run = locked.rows[0];
  if (!run || !isWorkflowRunState(run.status)) throw new Error(`Workflow run has no authoritative state: ${input.runId}`);
  if (run.status === "queued") {
    await transitionWorkflowRun(client, {
      runId: input.runId,
      to: "leased",
      actor: input.workerId,
      reason: "Worker acquired the first runnable task.",
      idempotencyKey: workflowRunLeaseTransitionKey(input.taskId,run.leaseEpoch),
      metadata: { taskId: input.taskId }
    });
  } else if (run.status !== "leased" && run.status !== "running") {
    throw new Error(`Cannot lease task for terminal workflow run in ${run.status}.`);
  }
  const authority = run.leaseOwner === input.workerId && (run.status === "leased" || run.status === "running")
    ? await client.query<{ leaseEpoch: string }>(
      `update workflow_runs
       set lease_expires_at = now() + ($3::int * interval '1 second')
       where id = $1::uuid and lease_owner = $2
       returning lease_epoch::text as "leaseEpoch"`,
      [input.runId, input.workerId, input.leaseSeconds]
    )
    : await client.query<{ leaseEpoch: string }>(
      `update workflow_runs
       set lease_epoch = lease_epoch + 1,
           lease_owner = $2,
           lease_expires_at = now() + ($3::int * interval '1 second')
       where id = $1::uuid
       returning lease_epoch::text as "leaseEpoch"`,
      [input.runId, input.workerId, input.leaseSeconds]
    );
  const leaseEpoch = authority.rows[0].leaseEpoch;
  await appendActionReceipt(client, {
        runId: input.runId,
        agentId: "workflow-orchestrator",
        actionType: "workflow_run_lease_acquired",
        target: input.taskId,
        summary: `Run authority leased to ${input.workerId}.`,
        metadata: JSON.stringify({ workerId: input.workerId, taskId: input.taskId, leaseEpoch })
      });
  return leaseEpoch;
}

export async function requeueRunningWorkflowTasks(runId: string): Promise<number> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string; agent_id: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_expires_at = null,
             available_at = now()
         where run_id = $1::uuid
           and status in ('leased','running')
         returning id::text, agent_id`,
        [runId]
      );
      if (result.rowCount && result.rowCount > 0) {
        await client.query(`update workflow_runs set lease_owner = null, lease_expires_at = null where id = $1::uuid and status in ('leased','running')`, [runId]);
      }
      for (const task of result.rows.sort((a, b) => a.id.localeCompare(b.id))) {
        await appendActionReceipt(client, { runId, agentId: task.agent_id,
          actionType: "stage_requeued", target: task.id,
          summary: "Active stage requeued for another execution attempt.",
          metadata: JSON.stringify({ nextStatus: "queued" }) });
      }
      await client.query("commit");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function requeueExpiredWorkflowTaskLeases(input: {
  runId?: string;
  projectRootUri?: string;
  actor: string;
  reason: string;
}): Promise<{ requeuedTasks: number; affectedRuns: number }> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ runId: string; taskId: string; agentId: string; workerId: string | null; leaseExpiresAt: string | null }>(
        `with expired as (
           select wt.id, wt.run_id, wt.worker_id, wt.lease_expires_at
           from workflow_tasks wt
           join workflow_runs wr on wr.id = wt.run_id
           join projects p on p.id = wr.project_id
           where wt.status in ('leased','running')
             and wt.lease_expires_at is not null
             and wt.lease_expires_at < now()
             and ($1::uuid is null or wt.run_id = $1::uuid)
             and ($2::text is null or p.root_uri = $2)
           for update of wt skip locked
         )
         update workflow_tasks wt
         set status = 'queued',
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_expires_at = null,
             available_at = now()
         from expired
         where wt.id = expired.id
         returning wt.run_id::text as "runId",
                   wt.id::text as "taskId",
                   wt.agent_id as "agentId",
                   expired.worker_id as "workerId",
                   expired.lease_expires_at::text as "leaseExpiresAt"`,
        [input.runId ?? null, input.projectRootUri ?? null]
      );
      const runIds = [...new Set(result.rows.map((row) => row.runId))].sort();
      if (runIds.length) {
        await client.query(
          `update workflow_runs
           set lease_owner = null,
               lease_expires_at = null
           where id = any($1::uuid[])
             and status in ('leased','running')`,
          [runIds]
        );
        for (const runId of runIds) {
          const tasks = result.rows.filter((row) => row.runId === runId);
          for (const task of tasks.sort((a, b) => a.taskId.localeCompare(b.taskId))) {
            await appendActionReceipt(client, { runId, agentId: task.agentId,
              actionType: "stage_requeued", target: task.taskId,
              summary: "Stage requeued after its worker lease expired.",
              metadata: JSON.stringify({ nextStatus: "queued", cause: "expired_worker_lease" }) });
          }
          await appendActionReceipt(client, {
        runId: runId,
        agentId: "workflow-orchestrator",
        actionType: "expired_worker_lease_requeued",
        target: runId,
        summary: input.reason,
        metadata: JSON.stringify({
                actor: input.actor,
                reason: input.reason,
                requeuedTasks: tasks.length,
                tasks
              })
      });
        }
      }
      await client.query("commit");
      return {
        requeuedTasks: result.rowCount ?? 0,
        affectedRuns: runIds.length
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

// Only interpolate this internally constructed predicate; values remain bound.
export async function coordinatorWorkerFencePredicate(client: pg.Client, workerParameter: string): Promise<string> {
  const available = Boolean((await client.query("select to_regclass('queue_coordinator_assignments') name")).rows[0]?.name);
  if (!available) return "not (coalesce(wr.evaluation_metadata, '{}'::jsonb) ? 'queueCoordinatorClaimId')";
  return `(not (coalesce(wr.evaluation_metadata, '{}'::jsonb) ? 'queueCoordinatorClaimId') or exists (
    select 1 from queue_coordinator_assignments assignment
    join work_intents intent on intent.project_id=assignment.project_id::text
      and intent.owner=assignment.owner and intent.fencing_token::text=assignment.intent_fence
      and intent.expires_at>now()
    where assignment.id::text=wr.evaluation_metadata->>'queueCoordinatorClaimId'
      and assignment.child_run_id=wr.id and assignment.project_id=wr.project_id
      and assignment.fence::text=wr.evaluation_metadata->>'queueCoordinatorFence'
      and assignment.state='running'
      and ${workerParameter}=assignment.owner || ':' || assignment.fence::text
  ))`;
}

export async function startWorkflowTask(input: { taskId: string; runId: string; workerId: string; fencingToken: string }): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select set_config('agentflow.execution_pipeline','1',true)");
      const result = await client.query(`update workflow_tasks set status='running',started_at=coalesce(started_at,now()) where id=$1 and run_id=$2 and status='leased' and worker_id=$3 and lease_generation=$4::bigint and lease_expires_at>now()`, [input.taskId,input.runId,input.workerId,input.fencingToken]);
      if (result.rowCount !== 1) throw new Error("Stale workflow fencing token or expired task lease.");
      await transitionWorkflowRun(client, {
        runId: input.runId,
        to: "running",
        actor: input.workerId,
        reason: "Leased worker started task execution.",
        idempotencyKey: `run-started:${input.taskId}:${input.fencingToken}`,
        expectedLeaseEpoch: input.fencingToken,
        expectedLeaseOwner: input.workerId,
        metadata: { taskId: input.taskId }
      });
      await appendActionReceipt(client, { runId: input.runId, agentId: "workflow-orchestrator",
        actionType: "stage_started", target: input.taskId, summary: "Leased worker started stage execution.",
        metadata: JSON.stringify({ taskId: input.taskId, fencingToken: input.fencingToken }) });
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function assertWorkflowTaskLease(input: {
  taskId: string;
  workerId: string;
  fencingToken: string;
}): Promise<void> {
  await withClient(async (client) => assertActiveTaskFence(client, input));
}

export async function assertActiveTaskFence(client: pg.Client, input: { taskId: string; workerId: string; fencingToken: string }): Promise<void> {
  const coordinatorFence = await coordinatorWorkerFencePredicate(client, "$2");
  const result = await client.query(
    `select 1
     from workflow_tasks wt
     join workflow_runs wr on wr.id = wt.run_id
     where wt.id=$1 and wt.status='running' and wt.worker_id=$2
       and wt.lease_generation=$3::bigint and wt.lease_expires_at>now()
       and wr.status in ('leased','running')
       and ${coordinatorFence}
     for update of wt, wr`,
    [input.taskId, input.workerId, input.fencingToken]
  );
  if (result.rowCount !== 1) throw new Error("Stale workflow fencing token or expired task lease.");
}

export async function renewWorkflowTaskLease(input: {
  taskId: string;
  runId: string;
  workerId: string;
  fencingToken: string;
  leaseSeconds?: number;
}): Promise<boolean> {
  const leaseSeconds = Math.max(30, Math.min(3600, input.leaseSeconds ?? 120));
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const task = await client.query(
        `update workflow_tasks
         set lease_expires_at = now() + ($5::int * interval '1 second')
         where id = $1::uuid and run_id = $2::uuid and status = 'running'
           and worker_id = $3 and lease_generation = $4::bigint and lease_expires_at > now()
         returning id`,
        [input.taskId, input.runId, input.workerId, input.fencingToken, leaseSeconds]
      );
      if (task.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update workflow_runs
         set lease_expires_at = now() + ($4::int * interval '1 second')
         where id = $1::uuid and lease_owner = $2 and lease_epoch = $3::bigint
           and status in ('leased','running') and lease_expires_at > now()
         returning id`,
        [input.runId, input.workerId, input.fencingToken, leaseSeconds]
      );
      const activeRun = await client.query(
        `select 1 from workflow_runs
         where id = $1::uuid and status in ('leased','running')
         for update`,
        [input.runId]
      );
      if (activeRun.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

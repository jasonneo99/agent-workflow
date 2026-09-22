import type pg from "pg";
import { assertWorkflowRunFence, assertWorkflowRunTransition, isWorkflowRunState, type WorkflowRunState } from "./run-state-machine.js";

export type WorkflowRunTransitionInput = {
  runId: string;
  to: WorkflowRunState;
  actor: string;
  reason: string;
  idempotencyKey: string;
  expectedLeaseEpoch?: string;
  expectedLeaseOwner?: string;
  metadata?: Record<string, unknown>;
};

export async function transitionWorkflowRun(
  client: pg.Client,
  input: WorkflowRunTransitionInput
): Promise<{ changed: boolean; status: WorkflowRunState; stateVersion: string; leaseEpoch: string }> {
  const prior = await client.query<{ toStatus: string }>(
    `select to_status as "toStatus"
     from workflow_run_transitions
     where run_id = $1::uuid and idempotency_key = $2`,
    [input.runId, input.idempotencyKey]
  );
  if (prior.rows[0]) {
    if (prior.rows[0].toStatus !== input.to) {
      throw new Error(`Workflow run transition idempotency key was reused for ${prior.rows[0].toStatus} -> ${input.to}.`);
    }
    const current = await client.query<{ status: string; stateVersion: string; leaseEpoch: string }>(
      `select status, state_version::text as "stateVersion", lease_epoch::text as "leaseEpoch"
       from workflow_runs where id = $1::uuid`,
      [input.runId]
    );
    if (!current.rows[0] || !isWorkflowRunState(current.rows[0].status)) throw new Error(`Workflow run not found: ${input.runId}`);
    return { changed: false, status: current.rows[0].status, stateVersion: current.rows[0].stateVersion, leaseEpoch: current.rows[0].leaseEpoch };
  }

  const locked = await client.query<{ status: string; stateVersion: string; leaseEpoch: string; leaseOwner: string | null }>(
    `select status,
            state_version::text as "stateVersion",
            lease_epoch::text as "leaseEpoch",
            lease_owner as "leaseOwner"
     from workflow_runs where id = $1::uuid for update`,
    [input.runId]
  );
  const run = locked.rows[0];
  if (!run || !isWorkflowRunState(run.status)) throw new Error(`Workflow run has no authoritative state: ${input.runId}`);
  if (input.expectedLeaseEpoch !== undefined && (
    input.expectedLeaseOwner === undefined
  )) {
    throw new Error("Workflow run fencing requires an expected lease owner.");
  }
  if (input.expectedLeaseEpoch !== undefined) {
    assertWorkflowRunFence(
      { leaseEpoch: run.leaseEpoch, leaseOwner: run.leaseOwner },
      { leaseEpoch: input.expectedLeaseEpoch, leaseOwner: input.expectedLeaseOwner! }
    );
  }
  const action = assertWorkflowRunTransition(run.status, input.to);
  if (action === "idempotent") {
    return { changed: false, status: run.status, stateVersion: run.stateVersion, leaseEpoch: run.leaseEpoch };
  }
  const updated = await client.query<{ status: WorkflowRunState; stateVersion: string; leaseEpoch: string }>(
    `update workflow_runs
     set status = $2,
         state_version = state_version + 1,
         finished_at = case when $2 = any($3::text[]) then coalesce(finished_at, now()) else null end,
         lease_owner = case when $2 = any($3::text[]) then null else lease_owner end,
         lease_expires_at = case when $2 = any($3::text[]) then null else lease_expires_at end
     where id = $1::uuid
     returning status, state_version::text as "stateVersion", lease_epoch::text as "leaseEpoch"`,
    [input.runId, input.to, ["completed", "blocked", "failed", "cancelled"]]
  );
  const next = updated.rows[0];
  await client.query(
    `insert into workflow_run_transitions (
       run_id, from_status, to_status, state_version, lease_epoch,
       actor, reason, idempotency_key, metadata
     ) values ($1::uuid, $2, $3, $4::bigint, $5::bigint, $6, $7, $8, $9)`,
    [input.runId, run.status, input.to, next.stateVersion, next.leaseEpoch, input.actor, input.reason, input.idempotencyKey, JSON.stringify(input.metadata ?? {})]
  );
  await client.query(
    `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
     values ($1::uuid, 'workflow-orchestrator', 'workflow_run_transition', $2::text, $3, $4)`,
    [input.runId, input.runId, `${run.status} -> ${input.to}: ${input.reason}`, JSON.stringify({ actor: input.actor, from: run.status, to: input.to, stateVersion: next.stateVersion, leaseEpoch: next.leaseEpoch, idempotencyKey: input.idempotencyKey, ...(input.metadata ?? {}) })]
  );
  return { changed: true, ...next };
}

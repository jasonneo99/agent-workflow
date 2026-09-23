import type pg from "pg";
import type { AgentCard, ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import type { RegistryRecord } from "../../agent-registry/src/loaders.js";
import { createExecutorSnapshots, type ExecutorSnapshot } from "../../executor-adapters/src/index.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import { completedStageProvidesPinnedBuildEvidence } from "../../model-providers/src/quality.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withClient } from "./client.js";
import { transitionWorkflowRun } from "./run-transitions.js";
import { findRecentDuplicateRun } from "./run-deduplication.js";
import { isWorkflowRunState, type WorkflowRunState } from "./run-state-machine.js";
export { databaseUrl, withClient } from "./client.js";
export { deleteProjectFiles, getProjectIndexState, upsertProject, upsertProjectFiles, upsertProjectIndexState, type ProjectIndexState } from "./project-index.js";
export { acquireWorkIntent, claimSideEffect, finalizeSideEffect, listWorkIntents, recordSideEffectOnce, releaseWorkIntent, renewWorkIntent, withProjectExecutionLock } from "./reliability.js";
export { listWorkflowReuseEvidence } from "./reuse.js";
export { transitionWorkflowRun, type WorkflowRunTransitionInput } from "./run-transitions.js";
export {
  claimActionApprovalExecution,
  completeApprovalRequestRun,
  decideActionApproval,
  dismissSupersededActionApprovals,
  getActionApproval,
  listActionApprovals,
  markActionApprovalExecution,
  recoverInterruptedActionApprovalExecutions,
  requestActionApproval,
  type ActionApprovalStatus
} from "./action-approvals.js";
export function workflowDefinitionHash(definition: unknown): string {
  return createHash("sha256").update(stableJson(definition)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export async function seedRegistry(
  agents: RegistryRecord<AgentCard>[],
  workflows: RegistryRecord<WorkflowDefinition>[]
): Promise<{ agents: number; workflows: number }> {
  return withClient(async (client) => {
    for (const record of agents) {
      await client.query(
        `insert into agents (id, display_name, category, source_path, definition, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (id) do update
         set display_name = excluded.display_name,
             category = excluded.category,
             source_path = excluded.source_path,
             definition = excluded.definition,
             updated_at = now()`,
        [
          record.value.id,
          record.value.display_name,
          record.value.category,
          record.path,
          JSON.stringify(record.value)
        ]
      );
    }
    for (const record of workflows) {
      await client.query(
        `insert into workflows (id, name, source_path, definition, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (id) do update
         set name = excluded.name,
             source_path = excluded.source_path,
             definition = excluded.definition,
             updated_at = now()`,
        [
          record.value.id,
          record.value.name,
          record.path,
          JSON.stringify(record.value)
        ]
      );
    }

    return {
      agents: agents.length,
      workflows: workflows.length
    };
  });
}

export async function migrateStorage(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`
      ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS policy_profile text NOT NULL DEFAULT 'local',
      ADD COLUMN IF NOT EXISTS policy_snapshot jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS policy_snapshot_hash text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS model_tier_override text,
      ADD COLUMN IF NOT EXISTS provider_override text,
      ADD COLUMN IF NOT EXISTS evaluation_metadata jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS workflow_snapshot jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS workflow_definition_version text NOT NULL DEFAULT '1',
      ADD COLUMN IF NOT EXISTS workflow_definition_hash text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS construction_rationale jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS executor_snapshot jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lease_epoch bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lease_owner text,
      ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS replacement_run_id uuid REFERENCES workflow_runs(id),
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_runs_replacement_run_idx
      ON workflow_runs(replacement_run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_runs_status_started_idx
      ON workflow_runs(status, started_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_runs_replay_source_idx
      ON workflow_runs ((evaluation_metadata->>'replayOfRunId'))
      WHERE evaluation_metadata ? 'replayOfRunId'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_runs_repair_source_idx
      ON workflow_runs ((evaluation_metadata->>'sourceRunId'))
      WHERE evaluation_metadata ? 'sourceRunId'
    `);
    await client.query(`
      WITH legacy_replacements AS (
        SELECT DISTINCT ON (source.id)
          source.id AS source_id,
          child.id AS replacement_id
        FROM workflow_runs source
        JOIN workflow_runs child
          ON child.id <> source.id
         AND (
           child.evaluation_metadata->>'replayOfRunId' = source.id::text
           OR child.evaluation_metadata->>'sourceRunId' = source.id::text
         )
        WHERE source.replacement_run_id IS NULL
        ORDER BY source.id, child.started_at DESC, child.id DESC
      )
      UPDATE workflow_runs source
      SET replacement_run_id = legacy.replacement_id,
          updated_at = now()
      FROM legacy_replacements legacy
      WHERE source.id = legacy.source_id
        AND source.replacement_run_id IS NULL
    `);
    await client.query(`
      UPDATE workflow_runs
      SET status = 'cancelled'
      WHERE status = 'dismissed'
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check
          CHECK (status IN ('queued','leased','running','completed','blocked','failed','cancelled'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_run_transitions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        from_status text NOT NULL,
        to_status text NOT NULL,
        state_version bigint NOT NULL,
        lease_epoch bigint NOT NULL,
        actor text NOT NULL,
        reason text NOT NULL,
        idempotency_key text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id, idempotency_key),
        UNIQUE(run_id, state_version)
      );
      CREATE INDEX IF NOT EXISTS workflow_run_transitions_run_created_idx
      ON workflow_run_transitions(run_id, created_at)
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workflow_run_transitions ADD CONSTRAINT workflow_run_transitions_from_status_check
          CHECK (from_status IN ('queued','leased','running','completed','blocked','failed','cancelled'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DO $$ BEGIN
        ALTER TABLE workflow_run_transitions ADD CONSTRAINT workflow_run_transitions_to_status_check
          CHECK (to_status IN ('queued','leased','running','completed','blocked','failed','cancelled'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      INSERT INTO workflow_run_transitions (
        run_id, from_status, to_status, state_version, lease_epoch,
        actor, reason, idempotency_key, metadata
      )
      SELECT id, status, status, state_version, lease_epoch,
             'migration', 'Backfilled authoritative run state.',
             'run-state-backfill-v1', jsonb_build_object('backfilled', true)
      FROM workflow_runs wr
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_run_transitions existing WHERE existing.run_id = wr.id
      )
      ON CONFLICT (run_id, idempotency_key) DO NOTHING
    `);
    await client.query(`
      ALTER TABLE workflow_tasks
      ADD COLUMN IF NOT EXISTS worker_id text,
      ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
      ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS executor_snapshot jsonb NOT NULL DEFAULT '{}'
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_intents (
        id uuid PRIMARY KEY,
        project_id text NOT NULL,
        owner text NOT NULL,
        objective_hash text NOT NULL,
        file_scopes jsonb NOT NULL DEFAULT '[]',
        expires_at timestamptz NOT NULL,
        fencing_token bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id, owner)
      );
      CREATE INDEX IF NOT EXISTS work_intents_active_idx ON work_intents(project_id, expires_at);
      CREATE TABLE IF NOT EXISTS side_effect_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id text NOT NULL,
        idempotency_key text NOT NULL,
        operation text NOT NULL,
        target text NOT NULL,
        receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'completed',
        claim_token uuid,
        claim_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id, idempotency_key)
      )
    `);
    await client.query(`
      ALTER TABLE side_effect_receipts
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
      ADD COLUMN IF NOT EXISTS claim_token uuid,
      ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid REFERENCES workflow_runs(id),
        task_id uuid REFERENCES workflow_tasks(id),
        kind text NOT NULL,
        uri text NOT NULL UNIQUE,
        content jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS artifacts_run_kind_idx
      ON artifacts(run_id, kind, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_schedule_idx
      ON workflow_tasks(run_id, status, available_at, started_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS action_approvals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid REFERENCES workflow_runs(id),
        task_id uuid REFERENCES workflow_tasks(id),
        stage_id text NOT NULL,
        agent_id text REFERENCES agents(id),
        action_type text NOT NULL,
        target text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        rationale text NOT NULL,
        policy_decision jsonb NOT NULL DEFAULT '{}',
        payload jsonb NOT NULL DEFAULT '{}',
        idempotency_key text NOT NULL,
        decided_by text,
        decided_role text,
        decided_at timestamptz,
        executed_by text,
        executed_role text,
        executed_at timestamptz,
        decision_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id, task_id, action_type, idempotency_key)
      )
    `);
    await client.query(`
      ALTER TABLE action_approvals
      ADD COLUMN IF NOT EXISTS decided_role text
    `);
    await client.query(`
      ALTER TABLE action_approvals
      ADD COLUMN IF NOT EXISTS executed_by text
    `);
    await client.query(`
      ALTER TABLE action_approvals
      ADD COLUMN IF NOT EXISTS executed_role text
    `);
    await client.query(`
      ALTER TABLE action_approvals
      ADD COLUMN IF NOT EXISTS executed_at timestamptz,
      ADD COLUMN IF NOT EXISTS execution_claim_token uuid,
      ADD COLUMN IF NOT EXISTS execution_claim_expires_at timestamptz
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS action_approvals_status_created_idx
      ON action_approvals(status, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS action_receipts_run_type_created_idx
      ON action_receipts(run_id, action_type, created_at DESC)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS action_approvals_run_level_idempotency_idx
      ON action_approvals(run_id, action_type, idempotency_key)
      WHERE task_id IS NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_index_state (
        project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        head_commit text,
        indexed_files integer NOT NULL DEFAULT 0,
        deleted_files integer NOT NULL DEFAULT 0,
        metadata jsonb NOT NULL DEFAULT '{}',
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_handoffs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        sender_agent_id text NOT NULL REFERENCES agents(id),
        receiver_agent_id text NOT NULL REFERENCES agents(id),
        source_stage_id text NOT NULL,
        destination_stage_id text NOT NULL,
        transferred_artifacts jsonb NOT NULL DEFAULT '[]',
        context_summary text NOT NULL,
        acceptance_criteria jsonb NOT NULL DEFAULT '[]',
        status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'retrying', 'completed', 'failed')),
        idempotency_key text NOT NULL,
        proposed_at timestamptz NOT NULL DEFAULT now(),
        accepted_at timestamptz,
        rejected_at timestamptz,
        retrying_at timestamptz,
        completed_at timestamptz,
        failed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id, idempotency_key)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_handoff_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        handoff_id uuid NOT NULL REFERENCES workflow_handoffs(id) ON DELETE CASCADE,
        run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'retrying', 'completed', 'failed')),
        actor_agent_id text REFERENCES agents(id),
        note text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_handoff_receipts (
        handoff_id uuid NOT NULL REFERENCES workflow_handoffs(id) ON DELETE CASCADE,
        receipt_id uuid NOT NULL REFERENCES action_receipts(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (handoff_id, receipt_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_handoffs_run_status_idx ON workflow_handoffs(run_id, status, proposed_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_handoff_events_handoff_created_idx ON workflow_handoff_events(handoff_id, created_at)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS workflow_handoff_events_one_proposal_idx ON workflow_handoff_events(handoff_id) WHERE status = 'proposed'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id text NOT NULL,
        node_id text NOT NULL,
        node_type text NOT NULL CHECK (node_type IN ('goal','task','evidence','artifact','decision','action','result')),
        title text NOT NULL,
        body text NOT NULL DEFAULT '',
        token_estimate integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}',
        UNIQUE(project_id, node_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id text NOT NULL,
        from_node text NOT NULL,
        to_node text NOT NULL,
        edge_type text NOT NULL CHECK (edge_type IN ('decomposes','supports','produces','decided_by','executes','leads_to','supersedes','relates')),
        cost numeric NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id, from_node, to_node, edge_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_nodes_project_type_idx ON memory_nodes(project_id, node_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_edges_project_from_idx ON memory_edges(project_id, from_node)`);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_edges_project_to_idx ON memory_edges(project_id, to_node)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_baselines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id uuid REFERENCES projects(id),
        workflow_id text REFERENCES workflows(id),
        workload_hash text NOT NULL,
        metrics jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS performance_metrics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        baseline_id uuid REFERENCES performance_baselines(id) ON DELETE CASCADE,
        run_id uuid REFERENCES workflow_runs(id) ON DELETE CASCADE,
        stage_id text NOT NULL,
        latency_ms double precision NOT NULL CHECK (latency_ms >= 0),
        cpu_ms double precision CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
        memory_mb double precision CHECK (memory_mb IS NULL OR memory_mb >= 0),
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS performance_baselines_project_created_idx ON performance_baselines(project_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS performance_metrics_run_stage_idx ON performance_metrics(run_id, stage_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS performance_metrics_baseline_created_idx ON performance_metrics(baseline_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx ON workflow_runs(project_id, status, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status_idx ON workflow_runs(workflow_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_idx ON workflow_tasks(run_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS action_receipts_run_created_idx ON action_receipts(run_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS artifacts_task_kind_idx ON artifacts(task_id, kind)`);
  });
}

async function acquireWorkflowRunLease(client: pg.Client, input: {
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
      idempotencyKey: `run-leased:${input.taskId}`,
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
  await client.query(
    `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
     values ($1::uuid, 'workflow-orchestrator', 'workflow_run_lease_acquired', $3, $2, $4)`,
    [input.runId, `Run authority leased to ${input.workerId}.`, input.taskId, JSON.stringify({ workerId: input.workerId, taskId: input.taskId, leaseEpoch })]
  );
  return leaseEpoch;
}

export async function resetStorage(input: { includeRegistry?: boolean } = {}): Promise<{
  artifacts: number;
  workflowHandoffs: number;
  actionReceipts: number;
  workflowTasks: number;
  workflowRuns: number;
  projectFiles: number;
  memoryItems: number;
  projects: number;
  agents?: number;
  workflows?: number;
}> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await deleteFrom(client, "workflow_handoff_receipts");
      await deleteFrom(client, "workflow_handoff_events");
      const workflowHandoffs = await deleteFrom(client, "workflow_handoffs");
      const artifacts = await deleteFrom(client, "artifacts");
      const actionReceipts = await deleteFrom(client, "action_receipts");
      const workflowTasks = await deleteFrom(client, "workflow_tasks");
      const workflowRuns = await deleteFrom(client, "workflow_runs");
      const projectFiles = await deleteFrom(client, "project_files");
      const memoryItems = await deleteFrom(client, "memory_items");
      const projects = await deleteFrom(client, "projects");
      const result = {
        artifacts,
        workflowHandoffs,
        actionReceipts,
        workflowTasks,
        workflowRuns,
        projectFiles,
        memoryItems,
        projects
      };

      if (input.includeRegistry) {
        const workflows = await deleteFrom(client, "workflows");
        const agents = await deleteFrom(client, "agents");
        await client.query("commit");
        return {
          ...result,
          agents,
          workflows
        };
      }

      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function deleteFrom(client: pg.Client, tableName: string): Promise<number> {
  const result = await client.query(`delete from ${tableName}`);
  return result.rowCount ?? 0;
}

export interface ProjectFileSummary {
  sourceUri: string;
  contentHash: string;
  tokenEstimate: number;
  summary: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface WorkflowQueueItem {
  runId: string;
  workflowId: string;
  runStatus: string;
  task: string;
  projectName: string;
  projectRootUri: string;
  startedAt: string;
  finishedAt: string | null;
  blockedReason?: string | null;
  failedReason?: string | null;
  totalTasks: number;
  queuedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  nextStageId: string | null;
  nextAgentId: string | null;
  runningStageId: string | null;
  runningAgentId: string | null;
  runningWorkerId: string | null;
  runningLeaseExpiresAt: string | null;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
  recoveryRunId: string | null;
  recoveryRunStatus: string | null;
  recoveryStartedAt: string | null;
  recoveryRelation: "replay" | "repair" | null;
}

export async function listWorkflowQueue(limit = 50, options?: { projectRootUri?: string }): Promise<WorkflowQueueItem[]> {
  return withClient(async (client) => {
    const projectRootUri = options?.projectRootUri?.trim() || null;
    const result = await client.query<WorkflowQueueItem>(
      `select
         wr.id::text as "runId",
         wr.workflow_id as "workflowId",
         wr.status as "runStatus",
         wr.task,
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         null::text as "recoveryRunId",
         null::text as "recoveryRunStatus",
         null::text as "recoveryStartedAt",
         null::text as "recoveryRelation",
         case when wr.status = 'blocked' then (
           select coalesce(ar.metadata->>'reason', ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_blocked'
           order by ar.created_at desc
           limit 1
         ) else null end as "blockedReason",
         case when wr.status = 'failed' then (
           select coalesce(nullif(ar.metadata->>'failureReason', ''), nullif(ar.metadata->>'reason', ''), ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_failed'
           order by ar.created_at desc
           limit 1
         ) else null end as "failedReason",
         count(wt.*)::int as "totalTasks",
         count(*) filter (where wt.status = 'queued')::int as "queuedTasks",
         count(*) filter (where wt.status in ('leased','running'))::int as "runningTasks",
         count(*) filter (where wt.status = 'completed')::int as "completedTasks",
         count(*) filter (where wt.status in ('failed', 'blocked'))::int as "failedTasks",
         count(*) filter (where wt.status = 'cancelled')::int as "cancelledTasks",
         (array_agg(wt.stage_id order by wt.available_at asc) filter (where wt.status = 'queued'))[1] as "nextStageId",
         (array_agg(wt.agent_id order by wt.available_at asc) filter (where wt.status = 'queued'))[1] as "nextAgentId",
         (array_agg(wt.stage_id order by wt.started_at asc nulls last) filter (where wt.status in ('leased', 'running')))[1] as "runningStageId",
         (array_agg(wt.agent_id order by wt.started_at asc nulls last) filter (where wt.status in ('leased', 'running')))[1] as "runningAgentId",
         (array_agg(wt.worker_id order by wt.started_at asc nulls last) filter (where wt.status in ('leased', 'running')))[1] as "runningWorkerId",
         (array_agg(wt.lease_expires_at::text order by wt.started_at asc nulls last) filter (where wt.status in ('leased', 'running')))[1] as "runningLeaseExpiresAt",
         (min(wt.available_at) filter (where wt.status = 'queued'))::text as "oldestQueuedAt",
         (min(coalesce(wt.started_at, wt.available_at)) filter (where wt.status in ('leased', 'running')))::text as "oldestRunningAt"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       join workflow_tasks wt on wt.run_id = wr.id
       where ($2::text is null or p.root_uri = $2)
         -- Evaluation failures are comparison evidence, not actionable workflow
         -- failures. They remain visible on the Evaluations surface.
         and not (wr.status in ('failed', 'blocked') and wr.evaluation_metadata ? 'suiteId')
         and not exists (
           select 1
           from action_receipts dismissed
           where dismissed.run_id = wr.id
             and dismissed.action_type = 'failed_run_dismissed'
             and not exists (
               select 1
               from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         )
         and (wr.status in ('queued', 'leased', 'running', 'failed', 'blocked')
          or exists (
            select 1 from workflow_tasks active
            where active.run_id = wr.id
              and active.status in ('queued', 'leased', 'running', 'failed', 'blocked')
          ))
       group by wr.id, p.id
       order by
         case wr.status when 'running' then 0 when 'queued' then 1 when 'blocked' then 2 when 'failed' then 3 else 4 end,
         coalesce(min(coalesce(wt.started_at, wt.available_at)) filter (where wt.status in ('leased', 'running')), min(wt.available_at) filter (where wt.status = 'queued'), wr.started_at) asc
       limit $1`,
      [limit, projectRootUri]
    );
    if (!result.rows.length) return result.rows;

    type RecoveryEdge = {
      sourceId: string;
      id: string;
      status: string;
      startedAt: string;
      relation: "replay" | "repair";
    };
    const originsByCurrent = new Map(result.rows.map((row) => [row.runId, [row.runId]]));
    const visitedByOrigin = new Map(result.rows.map((row) => [row.runId, new Set([row.runId])]));
    const recoveryByOrigin = new Map<string, Omit<RecoveryEdge, "sourceId">>();
    for (let depth = 0; depth < 20 && originsByCurrent.size; depth += 1) {
      const edges = await client.query<RecoveryEdge>(
        `select source.id::text as "sourceId", child.id::text, child.status,
                child.started_at::text as "startedAt",
                case when child.evaluation_metadata->>'replayOfRunId' = source.id::text
                  then 'replay' else 'repair' end as relation
           from workflow_runs source
           join workflow_runs child on child.id = source.replacement_run_id
          where source.id = any($1::uuid[])`,
        [[...originsByCurrent.keys()]]
      );
      const nextOrigins = new Map<string, string[]>();
      for (const edge of edges.rows) {
        for (const origin of originsByCurrent.get(edge.sourceId) ?? []) {
          const visited = visitedByOrigin.get(origin) ?? new Set<string>();
          if (visited.has(edge.id)) continue;
          visited.add(edge.id);
          visitedByOrigin.set(origin, visited);
          const prior = recoveryByOrigin.get(origin);
          recoveryByOrigin.set(origin, { id: edge.id, status: edge.status, startedAt: edge.startedAt, relation: prior?.relation ?? edge.relation });
          nextOrigins.set(edge.id, [...(nextOrigins.get(edge.id) ?? []), origin]);
        }
      }
      originsByCurrent.clear();
      for (const [runId, origins] of nextOrigins) originsByCurrent.set(runId, origins);
    }
    return result.rows.map((row) => {
      const recovery = recoveryByOrigin.get(row.runId);
      return recovery ? {
        ...row,
        recoveryRunId: recovery.id,
        recoveryRunStatus: recovery.status,
        recoveryStartedAt: recovery.startedAt,
        recoveryRelation: recovery.relation
      } : row;
    });
  });
}

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
      await client.query(
        `update workflow_tasks
         set status = 'cancelled',
             finished_at = now()
         where run_id = $1::uuid
           and status in ('queued', 'leased', 'running')`,
        [runId]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function requeueRunningWorkflowTasks(runId: string): Promise<number> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_expires_at = null,
             available_at = now()
         where run_id = $1::uuid
           and status in ('leased','running')
         returning id::text`,
        [runId]
      );
      if (result.rowCount && result.rowCount > 0) {
        await client.query(`update workflow_runs set lease_owner = null, lease_expires_at = null where id = $1::uuid and status in ('leased','running')`, [runId]);
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
      const result = await client.query<{ runId: string; taskId: string; workerId: string | null; leaseExpiresAt: string | null }>(
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
                   expired.worker_id as "workerId",
                   expired.lease_expires_at::text as "leaseExpiresAt"`,
        [input.runId ?? null, input.projectRootUri ?? null]
      );
      const runIds = [...new Set(result.rows.map((row) => row.runId))];
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
          await client.query(
            `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
             values ($1::uuid, 'workflow-orchestrator', 'expired_worker_lease_requeued', $2::text, $3, $4)`,
            [
              runId,
              runId,
              input.reason,
              JSON.stringify({
                actor: input.actor,
                reason: input.reason,
                requeuedTasks: tasks.length,
                tasks
              })
            ]
          );
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

export interface StaleTerminalWorkflowRun {
  runId: string;
  workflowId: string;
  runStatus: string;
  task: string;
  projectRootUri: string;
  startedAt: string | null;
  finishedAt: string | null;
  totalTasks: number;
  queuedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  recommendedStatus: "completed" | "cancelled";
}

export interface StaleRunReconciliationResult {
  kind: "agentflow_stale_run_reconciliation_result";
  generatedAt: string;
  mode: "preview" | "execute";
  candidates: StaleTerminalWorkflowRun[];
  reconciled: Array<{
    runId: string;
    status: "completed" | "cancelled";
    updated: boolean;
  }>;
}

export async function listStaleTerminalWorkflowRuns(limit = 50): Promise<StaleTerminalWorkflowRun[]> {
  return withClient(async (client) => {
    const result = await client.query<Omit<StaleTerminalWorkflowRun, "recommendedStatus">>(
      `select
         wr.id::text as "runId",
         wr.workflow_id as "workflowId",
         wr.status as "runStatus",
         wr.task,
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         count(wt.*)::int as "totalTasks",
         count(*) filter (where wt.status = 'queued')::int as "queuedTasks",
         count(*) filter (where wt.status in ('leased','running'))::int as "runningTasks",
         count(*) filter (where wt.status = 'completed')::int as "completedTasks",
         count(*) filter (where wt.status = 'failed')::int as "failedTasks",
         count(*) filter (where wt.status = 'cancelled')::int as "cancelledTasks"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       join workflow_tasks wt on wt.run_id = wr.id
       where wr.status in ('queued', 'leased', 'running')
       group by wr.id, p.id
       having count(*) > 0
          and count(*) filter (where wt.status in ('queued', 'leased', 'running', 'failed')) = 0
       order by wr.started_at asc
       limit $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      ...row,
      recommendedStatus: row.completedTasks > 0 ? "completed" : "cancelled"
    }));
  });
}

export async function reconcileStaleTerminalWorkflowRuns(input: {
  execute: boolean;
  limit?: number;
  actor?: string;
}): Promise<StaleRunReconciliationResult> {
  const candidates = await listStaleTerminalWorkflowRuns(input.limit ?? 50);
  const reconciled: StaleRunReconciliationResult["reconciled"] = [];
  if (!input.execute) {
    return {
      kind: "agentflow_stale_run_reconciliation_result",
      generatedAt: new Date().toISOString(),
      mode: "preview",
      candidates,
      reconciled
    };
  }

  await withClient(async (client) => {
    await client.query("begin");
    try {
      for (const candidate of candidates) {
        const eligible = await client.query<{ id: string; status: WorkflowRunState }>(
          `select wr.id::text, wr.status
           from workflow_runs wr
           where wr.id = $1::uuid
             and wr.status in ('queued', 'leased', 'running')
             and exists (
               select 1
               from workflow_tasks any_task
               where any_task.run_id = wr.id
             )
             and not exists (
               select 1
               from workflow_tasks active
               where active.run_id = wr.id
                 and active.status in ('queued', 'leased', 'running', 'failed')
             )
             and (
               ($2::text = 'completed' and exists (
                 select 1
                 from workflow_tasks completed_task
                 where completed_task.run_id = wr.id
                   and completed_task.status = 'completed'
               ))
               or
               ($2::text = 'cancelled' and not exists (
                 select 1
                 from workflow_tasks completed_task
                 where completed_task.run_id = wr.id
                   and completed_task.status = 'completed'
               ))
             )
           for update`,
          [candidate.runId, candidate.recommendedStatus]
        );
        let updated = false;
        if (eligible.rows[0]) {
          const currentStatus = eligible.rows[0].status;
          // Reconciliation must preserve the authoritative lifecycle even when
          // an interrupted worker left a queued/leased parent behind terminal
          // child tasks. Advance through the missing non-terminal states rather
          // than attempting the forbidden queued -> completed shortcut.
          if (candidate.recommendedStatus === "completed" && currentStatus === "queued") {
            await transitionWorkflowRun(client, {
              runId: candidate.runId,
              to: "leased",
              actor: input.actor ?? "system",
              reason: "Reconciliation restored the missing parent lease state for terminal child tasks.",
              idempotencyKey: "stale-run-reconcile:leased"
            });
          }
          if (candidate.recommendedStatus === "completed" && (currentStatus === "queued" || currentStatus === "leased")) {
            await transitionWorkflowRun(client, {
              runId: candidate.runId,
              to: "running",
              actor: input.actor ?? "system",
              reason: "Reconciliation restored the missing parent running state for terminal child tasks.",
              idempotencyKey: "stale-run-reconcile:running"
            });
          }
          await transitionWorkflowRun(client, {
            runId: candidate.runId,
            to: candidate.recommendedStatus,
            actor: input.actor ?? "system",
            reason: "All child tasks were terminal during reconciliation.",
            idempotencyKey: `stale-run-reconcile:${candidate.recommendedStatus}`
          });
          updated = true;
        }
        reconciled.push({
          runId: candidate.runId,
          status: candidate.recommendedStatus,
          updated
        });
        if (updated) {
          await client.query(
            `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
             values ($1::uuid, 'workflow-orchestrator', 'stale_run_reconciled', $2::text, $3, $4)`,
            [
              candidate.runId,
              candidate.runId,
              `Reconciled stale ${candidate.runStatus} run to ${candidate.recommendedStatus} because all child tasks were terminal.`,
              JSON.stringify({
                actor: input.actor ?? "system",
                previousStatus: candidate.runStatus,
                newStatus: candidate.recommendedStatus,
                totalTasks: candidate.totalTasks,
                completedTasks: candidate.completedTasks,
                cancelledTasks: candidate.cancelledTasks
              })
            ]
          );
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return {
    kind: "agentflow_stale_run_reconciliation_result",
    generatedAt: new Date().toISOString(),
    mode: "execute",
    candidates,
    reconciled
  };
}

export async function retryFailedWorkflowRun(runId: string): Promise<number> {
  const replay = await replayWorkflowRun({
    sourceRunId: runId,
    actor: "retry-failed-run",
    reason: "Retry requested; terminal history is immutable, so a checkpoint-preserving replacement run was created.",
    preserveCompletedCheckpoints: true
  });
  if (replay) {
    await dismissFailedWorkflowRun({
      runId,
      actor: "retry-failed-run",
      reason: `Superseded by replacement run ${replay.runId}; immutable history and receipts preserved.`
    });
  }
  return replay?.queuedTasks ?? 0;
}

export async function resumeWorkflowRunFromCheckpoint(input: {
  runId: string;
  actor: string;
  reason: string;
  includeFailed?: boolean;
}): Promise<{
  requeuedTasks: number;
  completedTasks: number;
  totalTasks: number;
  replacementRunId?: string;
}> {
  if (input.includeFailed) {
    const terminal = await withClient(async (client) => {
      const result = await client.query<{ status: string }>(`select status from workflow_runs where id = $1::uuid`, [input.runId]);
      return result.rows[0]?.status;
    });
    if (terminal === "failed" || terminal === "blocked" || terminal === "cancelled") {
      const replay = await replayWorkflowRun({
        sourceRunId: input.runId,
        actor: input.actor,
        reason: input.reason,
        preserveCompletedCheckpoints: true
      });
      if (replay) {
        await dismissFailedWorkflowRun({
          runId: input.runId,
          actor: input.actor,
          reason: `Superseded by replacement run ${replay.runId}; immutable history and receipts preserved.`
        });
      }
      return {
        requeuedTasks: replay?.queuedTasks ?? 0,
        completedTasks: replay?.completedTasks ?? 0,
        totalTasks: replay?.tasks ?? 0,
        replacementRunId: replay?.runId
      };
    }
  }
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const run = await client.query<{ id: string }>(
        `select id::text
         from workflow_runs
         where id = $1::uuid
           and status in ('queued', 'leased', 'running')
         for update`,
        [input.runId]
      );
      if (!run.rows[0]) {
        await client.query("rollback");
        return { requeuedTasks: 0, completedTasks: 0, totalTasks: 0 };
      }

      const resumableStatuses = ["queued", "running"];
      const result = await client.query<{ id: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_expires_at = null,
             available_at = now()
         where run_id = $1::uuid
           and status = any($2::text[])
         returning id::text`,
        [input.runId, resumableStatuses]
      );
      const counts = await client.query<{ total: number; completed: number }>(
        `select
           count(*)::int as total,
           count(*) filter (where status = 'completed')::int as completed
         from workflow_tasks
         where run_id = $1::uuid`,
        [input.runId]
      );
      if ((result.rowCount ?? 0) > 0) await client.query(
        `update workflow_runs set lease_owner = null, lease_expires_at = null where id = $1::uuid`,
        [input.runId]
      );
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, 'workflow-orchestrator', 'checkpoint_resume_requested', $2::text, $3, $4)`,
        [
          input.runId,
          input.runId,
          input.reason,
          JSON.stringify({
            actor: input.actor,
            reason: input.reason,
            includeFailed: input.includeFailed === true,
            requeuedTasks: result.rowCount ?? 0,
            completedTasks: counts.rows[0]?.completed ?? 0,
            totalTasks: counts.rows[0]?.total ?? 0
          })
        ]
      );
      await client.query("commit");
      return {
        requeuedTasks: result.rowCount ?? 0,
        completedTasks: counts.rows[0]?.completed ?? 0,
        totalTasks: counts.rows[0]?.total ?? 0
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function dismissFailedWorkflowRun(input: {
  runId: string;
  actor: string;
  reason: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const runResult = await client.query<{ id: string }>(
        `select wr.id::text
         from workflow_runs wr
         where wr.id = $1 and wr.status in ('failed', 'blocked', 'cancelled')
         for update`,
        [input.runId]
      );
      if (!runResult.rows[0]) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, 'workflow-orchestrator', 'failed_run_dismissed', $2::text, $3, $4)`,
        [input.runId, input.runId, input.reason, JSON.stringify({ actor: input.actor, reason: input.reason, bulk: false })]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function reinstateFailedWorkflowRun(input: {
  runId: string;
  actor: string;
  reason: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
       select wr.id, 'workflow-orchestrator', 'failed_run_reinstated', wr.id::text, $2, $3
       from workflow_runs wr
       where wr.id = $1::uuid
         and wr.status in ('failed', 'blocked', 'cancelled')
         and exists (
           select 1 from action_receipts dismissed
           where dismissed.run_id = wr.id and dismissed.action_type = 'failed_run_dismissed'
         )
       returning id::text`,
      [input.runId, input.reason, JSON.stringify({ actor: input.actor, reason: input.reason })]
    );
    return Boolean(result.rows[0]);
  });
}

export async function dismissAllFailedWorkflowRuns(input: {
  projectRootUri?: string;
  actor: string;
  reason: string;
}): Promise<number> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const runs = await client.query<{ id: string }>(
        `select wr.id::text
         from workflow_runs wr
         join projects p on p.id = wr.project_id
         where wr.status in ('failed', 'blocked', 'cancelled')
           and ($1::text is null or p.root_uri = $1)
         for update of wr`,
        [input.projectRootUri ?? null]
      );
      const runIds = runs.rows.map((row) => row.id);
      if (!runIds.length) {
        await client.query("rollback");
        return 0;
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         select id, 'workflow-orchestrator', 'failed_run_dismissed', id::text, $2, $3
         from workflow_runs where id = any($1::uuid[])`,
        [runIds, input.reason, JSON.stringify({ actor: input.actor, reason: input.reason, bulk: true, projectRootUri: input.projectRootUri ?? null })]
      );
      await client.query("commit");
      return runIds.length;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export interface ProjectStorageSummary {
  id: string;
  name: string;
  rootUri: string;
  profile: string;
  config: Record<string, unknown>;
  updatedAt: string;
  indexedFiles: number;
  indexedTokens: number;
  lastIndexedAt: string | null;
  memoryItems: number;
  runCount: number;
  completedRuns: number;
  failedRuns: number;
  queuedRuns: number;
  runningRuns: number;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastWorkflowId: string | null;
  lastRunStatus: string | null;
}

export async function listProjectStorageSummaries(limit = 100): Promise<ProjectStorageSummary[]> {
  return withClient(async (client) => {
    const result = await client.query<ProjectStorageSummary>(
      `select
         p.id::text,
         p.name,
         p.root_uri as "rootUri",
         p.profile,
         p.config,
         p.updated_at::text as "updatedAt",
         coalesce(pf.indexed_files, 0)::int as "indexedFiles",
         coalesce(pf.indexed_tokens, 0)::int as "indexedTokens",
         pf.last_indexed_at::text as "lastIndexedAt",
         coalesce(mi.memory_items, 0)::int as "memoryItems",
         coalesce(wr.run_count, 0)::int as "runCount",
         coalesce(wr.completed_runs, 0)::int as "completedRuns",
         coalesce(wr.failed_runs, 0)::int as "failedRuns",
         coalesce(wr.queued_runs, 0)::int as "queuedRuns",
         coalesce(wr.running_runs, 0)::int as "runningRuns",
         latest.started_at::text as "lastRunAt",
         latest.id::text as "lastRunId",
         latest.workflow_id as "lastWorkflowId",
         latest.status as "lastRunStatus"
       from projects p
       left join lateral (
         select
           count(*) as indexed_files,
           coalesce(sum(token_estimate), 0) as indexed_tokens,
           max(updated_at) as last_indexed_at
         from project_files
         where project_id = p.id
       ) pf on true
       left join lateral (
         select count(*) as memory_items
         from memory_items
         where project_id = p.id
       ) mi on true
       left join lateral (
         select
           count(*) as run_count,
           count(*) filter (where status = 'completed') as completed_runs,
           count(*) filter (where status = 'failed') as failed_runs,
           count(*) filter (where status = 'queued') as queued_runs,
           count(*) filter (where status in ('leased', 'running')) as running_runs
         from workflow_runs
         where project_id = p.id
       ) wr on true
       left join lateral (
         select id, workflow_id, status, started_at
         from workflow_runs
         where project_id = p.id
         order by started_at desc
         limit 1
       ) latest on true
       order by greatest(coalesce(latest.started_at, '-infinity'::timestamptz), p.updated_at) desc
       limit $1`,
      [limit]
    );
    return result.rows;
  });
}

export async function listProjectFileSummaries(input: {
  projectRootUri: string;
  limit: number;
}): Promise<ProjectFileSummary[]> {
  return withClient(async (client) => {
    const result = await client.query<ProjectFileSummary>(
      `select
         pf.source_uri as "sourceUri",
         pf.content_hash as "contentHash",
         pf.token_estimate as "tokenEstimate",
         pf.summary,
         pf.metadata,
         pf.updated_at::text as "updatedAt"
       from project_files pf
       join projects p on p.id = pf.project_id
       where p.root_uri = $1
       order by pf.source_uri asc
       limit $2`,
      [input.projectRootUri, input.limit]
    );
    return result.rows;
  });
}

export interface CreateRunInput {
  projectName: string;
  projectRootUri: string;
  projectProfile: string;
  projectConfig: unknown;
  workflow: WorkflowDefinition;
  task: string;
  autonomy: string;
  policyProfile: string;
  policySnapshot: unknown;
  policySnapshotHash: string;
  modelTierOverride?: "fast" | "standard" | "reasoning";
  providerOverride?: string;
  evaluationMetadata?: Record<string, unknown>;
  workflowVersion?: string | number;
  workflowHash?: string;
  constructionRationale?: unknown;
  compiledBrief?: string;
  compiledBriefMetadata?: Record<string, unknown>;
}
export async function createWorkflowRun(input: CreateRunInput): Promise<{ projectId: string; runId: string; tasks: number; deduplicated?: boolean }> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const projectResult = await client.query<{ id: string }>(
        `insert into projects (name, root_uri, profile, config, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (root_uri) do update
         set name = excluded.name,
             profile = excluded.profile,
             config = excluded.config,
             updated_at = now()
         returning id`,
        [
          input.projectName,
          input.projectRootUri,
          input.projectProfile,
          JSON.stringify(input.projectConfig)
        ]
      );
      const projectId = projectResult.rows[0].id;
      const workflowVersion = String(input.workflowVersion ?? "1");
      const workflowHash = input.workflowHash ?? workflowDefinitionHash(input.workflow);
      const evaluationMetadataJson = JSON.stringify(input.evaluationMetadata ?? {});
      const constructionRationaleJson = JSON.stringify(input.constructionRationale ?? {});
      const compiledBriefJson = input.compiledBrief
        ? JSON.stringify({ text: input.compiledBrief, metadata: input.compiledBriefMetadata ?? {} })
        : null;
      const duplicate = await findRecentDuplicateRun(client, {
        projectId,
        workflowId: input.workflow.id,
        task: input.task,
        autonomy: input.autonomy,
        policyProfile: input.policyProfile,
        policySnapshotHash: input.policySnapshotHash,
        modelTierOverride: input.modelTierOverride ?? null,
        providerOverride: input.providerOverride ?? null,
        workflowVersion,
        workflowHash,
        evaluationMetadataJson,
        constructionRationaleJson,
        compiledBriefJson
      });
      if (duplicate) {
        await client.query("commit");
        return { projectId, runId: duplicate.id, tasks: duplicate.tasks, deduplicated: true };
      }
      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot,
           workflow_definition_version, workflow_definition_hash, construction_rationale, compiled_brief_uri
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         returning id`,
        [
          projectId,
          input.workflow.id,
          input.task,
          input.autonomy,
          input.policyProfile,
          JSON.stringify(input.policySnapshot),
          input.policySnapshotHash,
          input.modelTierOverride ?? null,
          input.providerOverride ?? null,
          evaluationMetadataJson,
          JSON.stringify(input.workflow),
          workflowVersion,
          workflowHash,
          constructionRationaleJson,
          null
        ]
      );
      const runId = runResult.rows[0].id;
      const compiledBriefUri = `db://workflow_runs/${runId}/compiled-brief`;

      if (input.compiledBrief) {
        await client.query(
          `insert into artifacts (run_id, kind, uri, content)
           values ($1, 'compiled_brief', $2, $3)
           on conflict (uri) do update
           set content = excluded.content`,
          [
            runId,
            compiledBriefUri,
            compiledBriefJson
          ]
        );
        await client.query(
          `update workflow_runs
           set compiled_brief_uri = $2
           where id = $1`,
          [runId, compiledBriefUri]
        );
      }

      const taskIds: Record<string, string> = {};
      for (const stage of input.workflow.stages) {
        const taskResult = await client.query<{ id: string }>(
          `insert into workflow_tasks (run_id, stage_id, agent_id, status, idempotency_key)
           values ($1, $2, $3, 'queued', $4)
           returning id::text`,
          [
            runId,
            stage.id,
            stage.agent,
            `${runId}:${stage.id}:${stage.agent}`
          ]
        );
        taskIds[stage.id] = taskResult.rows[0].id;
      }
      for (let stageIndex = 0; stageIndex < input.workflow.stages.length; stageIndex += 1) {
        const destination = input.workflow.stages[stageIndex];
        const dependencies = destination.depends_on ?? (stageIndex === 0 ? [] : [input.workflow.stages[stageIndex - 1].id]);
        for (const sourceStageId of dependencies) {
          const source = input.workflow.stages.find((stage) => stage.id === sourceStageId);
          if (!source) continue;
          const handoff = await client.query<{ id: string }>(
            `insert into workflow_handoffs (run_id, sender_agent_id, receiver_agent_id, source_stage_id, destination_stage_id,
               transferred_artifacts, context_summary, acceptance_criteria, idempotency_key)
             values ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8)
             returning id::text`,
            [runId, source.agent, destination.agent, source.id, destination.id,
              `Transfer ${source.output} from ${source.id} to ${destination.id}.`,
              JSON.stringify(destination.acceptance_criteria ?? [destination.goal]), `${source.id}:${destination.id}`]
          );
          await client.query(
            `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, metadata)
             values ($1, $2, 'proposed', $3, $4)`,
            [handoff.rows[0].id, runId, source.agent, JSON.stringify({ generatedFromWorkflowDefinition: true })]
          );
        }
      }
      const revision = input.workflow.stages.some((stage) => stage.executor)
        ? exactGitRevision(input.projectRootUri)
        : "";
      const executorSnapshots = revision ? createExecutorSnapshots({
        project: input.policySnapshot as ProjectConfig,
        workflow: input.workflow,
        revision,
        runId,
        taskIds,
        projectRootUri: input.projectRootUri
      }) : {};
      for (const [stageId, snapshot] of Object.entries(executorSnapshots)) {
        await client.query(
          `update workflow_tasks set executor_snapshot = $3 where run_id = $1 and stage_id = $2`,
          [runId, stageId, JSON.stringify(snapshot)]
        );
      }
      await client.query(`update workflow_runs set executor_snapshot = $2 where id = $1`, [runId, JSON.stringify(executorSnapshots)]);

      await client.query("commit");
      return {
        projectId,
        runId,
        tasks: input.workflow.stages.length
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function replayWorkflowRun(input: {
  sourceRunId: string;
  actor: string;
  reason: string;
  preserveCompletedCheckpoints?: boolean;
  skipStageIds?: string[];
  evaluationMetadataPatch?: Record<string, unknown>;
  autonomyOverride?: string;
}): Promise<{ projectId: string; runId: string; tasks: number; completedTasks: number; skippedTasks: number; queuedTasks: number } | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const source = await client.query<{
        projectId: string;
        projectName: string;
        projectRootUri: string;
        projectProfile: string;
        projectConfig: Record<string, unknown>;
        workflowId: string;
        workflowSnapshot: WorkflowDefinition | null;
        executorSnapshot: Record<string, ExecutorSnapshot>;
        workflowDefinition: WorkflowDefinition | null;
        task: string;
        autonomy: string;
        policyProfile: string;
        policySnapshot: Record<string, unknown>;
        policySnapshotHash: string;
        modelTierOverride: string | null;
        providerOverride: string | null;
        evaluationMetadata: Record<string, unknown>;
        workflowDefinitionVersion: string;
        workflowDefinitionHash: string;
        constructionRationale: Record<string, unknown>;
        compiledBrief: string | null;
        compiledBriefMetadata: Record<string, unknown> | null;
        replacementRunId: string | null;
      }>(
        `select
           p.id::text as "projectId",
           p.name as "projectName",
           p.root_uri as "projectRootUri",
           p.profile as "projectProfile",
           p.config as "projectConfig",
           wr.workflow_id as "workflowId",
           nullif(wr.workflow_snapshot, '{}'::jsonb) as "workflowSnapshot",
           wr.executor_snapshot as "executorSnapshot",
           wf.definition as "workflowDefinition",
           wr.task,
           wr.autonomy,
           wr.policy_profile as "policyProfile",
           wr.policy_snapshot as "policySnapshot",
           wr.policy_snapshot_hash as "policySnapshotHash",
           wr.model_tier_override as "modelTierOverride",
           wr.provider_override as "providerOverride",
           wr.evaluation_metadata as "evaluationMetadata",
           wr.workflow_definition_version as "workflowDefinitionVersion",
           wr.workflow_definition_hash as "workflowDefinitionHash",
           wr.construction_rationale as "constructionRationale",
           wr.replacement_run_id::text as "replacementRunId",
           artifact.content->>'text' as "compiledBrief",
           artifact.content->'metadata' as "compiledBriefMetadata"
         from workflow_runs wr
         join projects p on p.id = wr.project_id
         left join workflows wf on wf.id = wr.workflow_id
         left join artifacts artifact on artifact.uri = wr.compiled_brief_uri
         where wr.id = $1
         for update of wr`,
        [input.sourceRunId]
      );
      const sourceRun = source.rows[0];
      if (!sourceRun) {
        await client.query("rollback");
        return null;
      }
      if (sourceRun.replacementRunId) {
        const existing = await client.query<{
          tasks: number;
          completedTasks: number;
          skippedTasks: number;
        }>(
          `select count(*)::int as tasks,
                  count(*) filter (where status = 'completed')::int as "completedTasks",
                  0::int as "skippedTasks"
             from workflow_tasks
            where run_id = $1::uuid`,
          [sourceRun.replacementRunId]
        );
        const counts = existing.rows[0] ?? { tasks: 0, completedTasks: 0, skippedTasks: 0 };
        await client.query("commit");
        return {
          projectId: sourceRun.projectId,
          runId: sourceRun.replacementRunId,
          tasks: counts.tasks,
          completedTasks: counts.completedTasks,
          skippedTasks: counts.skippedTasks,
          queuedTasks: Math.max(0, counts.tasks - counts.completedTasks)
        };
      }
      const workflow = sourceRun.workflowSnapshot ?? sourceRun.workflowDefinition;
      if (!workflow) {
        throw new Error(`Source run workflow is unavailable: ${input.sourceRunId}`);
      }
      const sourceTasks = input.preserveCompletedCheckpoints
        ? await client.query<{
          id: string;
          stageId: string;
          status: string;
          attempts: number;
          startedAt: string | null;
          finishedAt: string | null;
          artifactContent: Record<string, unknown> | null;
          approvalCount: number;
          executedApprovalCount: number;
        }>(
          `select wt.id::text,
                  wt.stage_id as "stageId",
                  wt.status,
                  wt.attempts,
                  wt.started_at::text as "startedAt",
                  wt.finished_at::text as "finishedAt",
                  artifact.content as "artifactContent",
                  count(aa.id)::int as "approvalCount",
                  count(aa.id) filter (where aa.status = 'executed')::int as "executedApprovalCount"
             from workflow_tasks wt
             left join action_approvals aa on aa.task_id = wt.id
             left join lateral (
               select content
                 from artifacts
                where run_id = wt.run_id and task_id = wt.id and kind = 'stage_output'
                order by created_at desc
                limit 1
             ) artifact on true
            where wt.run_id = $1::uuid
            group by wt.id, artifact.content`,
          [input.sourceRunId]
        )
        : { rows: [] };
      const sourceTaskByStage = new Map(sourceTasks.rows.map((task) => [task.stageId, task]));
      const replayPolicy = resolveExecutionPolicy(sourceRun.projectConfig as ProjectConfig, sourceRun.policyProfile);
      const autonomyRank = (value: string): number => value === "wide-open" ? 6 : Number.parseInt(value, 10);
      if (input.autonomyOverride !== undefined && (
        !["0", "1", "2", "3", "4", "5", "wide-open"].includes(input.autonomyOverride)
        || autonomyRank(input.autonomyOverride) > autonomyRank(String(replayPolicy.project.project.autonomy))
      )) {
        throw new Error(`Requested autonomy ${input.autonomyOverride} exceeds or violates the resolved project policy.`);
      }
      const replayPolicySnapshot = input.autonomyOverride === undefined
        ? replayPolicy.snapshot
        : {
          ...replayPolicy.snapshot,
          project: { ...replayPolicy.snapshot.project, autonomy: input.autonomyOverride }
        } as ProjectConfig;
      const replayPolicySnapshotHash = createHash("sha256").update(stableJson(replayPolicySnapshot)).digest("hex");

      const projectResult = await client.query<{ id: string }>(
        `insert into projects (name, root_uri, profile, config, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (root_uri) do update
         set name = excluded.name,
             profile = excluded.profile,
             updated_at = now()
         returning id`,
        [
          sourceRun.projectName,
          sourceRun.projectRootUri,
          sourceRun.projectProfile,
          JSON.stringify(sourceRun.projectConfig)
        ]
      );
      const projectId = projectResult.rows[0].id;
      const replayMetadata = {
        ...sourceRun.evaluationMetadata,
        ...input.evaluationMetadataPatch,
        replayOfRunId: input.sourceRunId,
        replayedBy: input.actor,
        replayReason: input.reason,
        checkpointResume: input.preserveCompletedCheckpoints === true,
        skippedStageIds: [...new Set(input.skipStageIds ?? [])]
      };
      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot,
           workflow_definition_version, workflow_definition_hash, construction_rationale, compiled_brief_uri
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, null)
         returning id`,
        [
          projectId,
          sourceRun.workflowId,
          sourceRun.task,
          input.autonomyOverride ?? sourceRun.autonomy,
          sourceRun.policyProfile,
          JSON.stringify(replayPolicySnapshot),
          replayPolicySnapshotHash,
          sourceRun.modelTierOverride,
          sourceRun.providerOverride,
          JSON.stringify(replayMetadata),
          JSON.stringify(workflow),
          sourceRun.workflowDefinitionVersion,
          sourceRun.workflowDefinitionHash || workflowDefinitionHash(workflow),
          JSON.stringify(sourceRun.constructionRationale)
        ]
      );
      const runId = runResult.rows[0].id;
      const compiledBriefUri = `db://workflow_runs/${runId}/compiled-brief`;
      if (sourceRun.compiledBrief) {
        await client.query(
          `insert into artifacts (run_id, kind, uri, content)
           values ($1, 'compiled_brief', $2, $3)`,
          [
            runId,
            compiledBriefUri,
            JSON.stringify({
              text: sourceRun.compiledBrief,
              metadata: {
                ...(sourceRun.compiledBriefMetadata ?? {}),
                replayOfRunId: input.sourceRunId
              }
            })
          ]
        );
        await client.query(
          `update workflow_runs
           set compiled_brief_uri = $2
           where id = $1`,
          [runId, compiledBriefUri]
        );
      }

      const taskIds: Record<string, string> = {};
      let completedTasks = 0;
      let skippedTasks = 0;
      let checkpointChainInvalidated = false;
      const skippedStageIds = new Set(input.skipStageIds ?? []);
      for (const stage of workflow.stages) {
        const sourceTask = sourceTaskByStage.get(stage.id);
        const actionResolvedCheckpoint = sourceTask?.status === "blocked"
          && sourceTask.approvalCount > 0
          && sourceTask.executedApprovalCount === sourceTask.approvalCount;
        const checkpointCandidate = sourceTask?.status === "completed" || actionResolvedCheckpoint;
        const checkpointArtifact = sourceTask?.artifactContent ?? null;
        const checkpointHasBuildEvidence = checkpointArtifact !== null && completedStageProvidesPinnedBuildEvidence({
          workflowTask: sourceRun.task,
          stageId: stage.id,
          agentId: stage.agent,
          summary: typeof checkpointArtifact.summary === "string" ? checkpointArtifact.summary : "",
          artifact: checkpointArtifact
        });
        if (checkpointCandidate && !checkpointHasBuildEvidence) {
          checkpointChainInvalidated = true;
        }
        const preserveCheckpoint = !checkpointChainInvalidated
          && checkpointCandidate
          && checkpointArtifact !== null;
        const skipStage = skippedStageIds.has(stage.id) && !preserveCheckpoint;
        const taskResult = await client.query<{ id: string }>(
          `insert into workflow_tasks (
             run_id, stage_id, agent_id, status, idempotency_key,
             attempts, started_at, finished_at
           )
           values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
           returning id::text`,
          [
            runId,
            stage.id,
            stage.agent,
            preserveCheckpoint || skipStage ? "completed" : "queued",
            `${runId}:${stage.id}:${stage.agent}`,
            preserveCheckpoint ? sourceTask.attempts : 0,
            preserveCheckpoint ? sourceTask.startedAt : skipStage ? new Date().toISOString() : null,
            preserveCheckpoint ? sourceTask.finishedAt : skipStage ? new Date().toISOString() : null
          ]
        );
        const taskId = taskResult.rows[0].id;
        taskIds[stage.id] = taskId;
        if (preserveCheckpoint) {
          completedTasks += 1;
          if (sourceTask.artifactContent) {
            const outputUri = `db://workflow_tasks/${taskId}/output`;
            await client.query(
              `insert into artifacts (run_id, task_id, kind, uri, content)
               values ($1::uuid, $2::uuid, 'stage_output', $3, $4::jsonb)`,
              [
                runId,
                taskId,
                outputUri,
                JSON.stringify({
                  ...sourceTask.artifactContent,
                  checkpointPreservedFromRunId: input.sourceRunId,
                  checkpointPreservedFromTaskId: sourceTask.id
                })
              ]
            );
            await client.query(`update workflow_tasks set output_uri = $2 where id = $1::uuid`, [taskId, outputUri]);
          }
          await client.query(
            `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
             values ($1::uuid, $2, 'stage_checkpoint_preserved', $3, $4, $5::jsonb)`,
            [
              runId,
              stage.agent,
              taskId,
              actionResolvedCheckpoint
                ? `Preserved action-resolved checkpoint for stage ${stage.id} from immutable run ${input.sourceRunId}; every required action has a durable executed receipt.`
                : `Preserved completed checkpoint for stage ${stage.id} from immutable run ${input.sourceRunId}.`,
              JSON.stringify({ sourceRunId: input.sourceRunId, sourceTaskId: sourceTask.id, stageId: stage.id, actionResolvedCheckpoint })
            ]
          );
        } else if (skipStage) {
          skippedTasks += 1;
          const outputUri = `db://workflow_tasks/${taskId}/output`;
          await client.query(
            `insert into artifacts (run_id, task_id, kind, uri, content)
             values ($1::uuid, $2::uuid, 'stage_output', $3, $4::jsonb)`,
            [
              runId,
              taskId,
              outputUri,
              JSON.stringify({
                status: "skipped",
                summary: `Stage ${stage.id} was explicitly skipped by ${input.actor}.`,
                skipped: true,
                skippedFromRunId: input.sourceRunId,
                skipReason: input.reason
              })
            ]
          );
          await client.query(`update workflow_tasks set output_uri = $2 where id = $1::uuid`, [taskId, outputUri]);
          await client.query(
            `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
             values ($1::uuid, $2, 'stage_blocker_ignored', $3, $4, $5::jsonb)`,
            [
              runId,
              stage.agent,
              taskId,
              `Explicitly skipped blocked stage ${stage.id}; downstream execution may continue.`,
              JSON.stringify({ sourceRunId: input.sourceRunId, sourceTaskId: sourceTask?.id ?? null, stageId: stage.id, actor: input.actor, reason: input.reason })
            ]
          );
        }
      }
      await createWorkflowHandoffsForRun(client, runId, workflow);
      const sourceRevision = Object.values(sourceRun.executorSnapshot ?? {})[0]?.revision;
      const replayExecutorSnapshots = sourceRevision ? createExecutorSnapshots({
        project: sourceRun.policySnapshot as ProjectConfig,
        workflow,
        revision: sourceRevision,
        runId,
        taskIds,
        projectRootUri: sourceRun.projectRootUri
      }) : {};
      for (const [stageId, snapshot] of Object.entries(replayExecutorSnapshots)) {
        await client.query(`update workflow_tasks set executor_snapshot = $3 where run_id = $1 and stage_id = $2`, [runId, stageId, JSON.stringify(snapshot)]);
      }
      await client.query(`update workflow_runs set executor_snapshot = $2 where id = $1`, [runId, JSON.stringify(replayExecutorSnapshots)]);
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, 'workflow-orchestrator', 'workflow_replayed', $2, $3, $4)`,
        [
          runId,
          input.sourceRunId,
          input.reason,
          JSON.stringify({
            actor: input.actor,
            sourceRunId: input.sourceRunId,
            preserveCompletedCheckpoints: input.preserveCompletedCheckpoints === true,
            completedTasks,
            skippedTasks,
            queuedTasks: workflow.stages.length - completedTasks - skippedTasks,
            policySnapshotHash: replayPolicySnapshotHash,
            autonomyOverride: input.autonomyOverride ?? null,
            workflowSnapshot: sourceRun.workflowSnapshot ? "source-run" : "current-registry"
          })
        ]
      );

      const queuedTasks = workflow.stages.length - completedTasks - skippedTasks;
      if (queuedTasks === 0) {
        // A checkpoint-preserving replay can be terminal at creation time. It
        // must still traverse the authoritative lifecycle so dashboards never
        // display a completed replay as queued while waiting for reconciliation.
        await transitionWorkflowRun(client, {
          runId,
          to: "leased",
          actor: input.actor,
          reason: "Replay restored every stage from completed checkpoints.",
          idempotencyKey: "checkpoint-replay:leased"
        });
        await transitionWorkflowRun(client, {
          runId,
          to: "running",
          actor: input.actor,
          reason: "Replay restored every stage from completed checkpoints.",
          idempotencyKey: "checkpoint-replay:running"
        });
        await transitionWorkflowRun(client, {
          runId,
          to: "completed",
          actor: input.actor,
          reason: "All replay stages were restored from completed checkpoints.",
          idempotencyKey: "checkpoint-replay:completed"
        });
      }

      await client.query(
        `update workflow_runs
            set replacement_run_id = $2::uuid,
                updated_at = now()
          where id = $1::uuid and replacement_run_id is null`,
        [input.sourceRunId, runId]
      );

      await client.query("commit");
      return {
        projectId,
        runId,
        tasks: workflow.stages.length,
        completedTasks,
        skippedTasks,
        queuedTasks
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function setQueuedWorkflowRunAutonomy(input: {
  runId: string;
  autonomy: string;
  policySnapshot: ProjectConfig;
  policySnapshotHash: string;
  actor: string;
  reason: string;
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const run = await client.query<{ projectConfig: ProjectConfig; policyProfile: string }>(
        `select p.config as "projectConfig", wr.policy_profile as "policyProfile"
         from workflow_runs wr join projects p on p.id = wr.project_id
         where wr.id = $1::uuid for update`,
        [input.runId]
      );
      if (!run.rows[0]) {
        await client.query("rollback");
        return false;
      }
      const resolved = resolveExecutionPolicy(run.rows[0].projectConfig, run.rows[0].policyProfile);
      const rank = (value: string): number => value === "wide-open" ? 6 : Number.parseInt(value, 10);
      if (
        !["0", "1", "2", "3", "4", "5", "wide-open"].includes(input.autonomy)
        || rank(input.autonomy) > rank(String(resolved.project.project.autonomy))
        || String(input.policySnapshot.project.autonomy) !== input.autonomy
        || createHash("sha256").update(stableJson(input.policySnapshot)).digest("hex") !== input.policySnapshotHash
      ) {
        throw new Error("Queued run autonomy update does not match the resolved project policy or snapshot hash.");
      }
      const updated = await client.query(
        `update workflow_runs
         set autonomy = $2, policy_snapshot = $3::jsonb, policy_snapshot_hash = $4
         where id = $1::uuid and status = 'queued'
         returning id`,
        [input.runId, input.autonomy, JSON.stringify(input.policySnapshot), input.policySnapshotHash]
      );
      if (!updated.rowCount) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, 'workflow-orchestrator', 'run_autonomy_changed', $2, $3, $4::jsonb)`,
        [
          input.runId,
          input.autonomy,
          `Run approval level changed to ${input.autonomy} before worker claim.`,
          JSON.stringify({ actor: input.actor, reason: input.reason, policySnapshotHash: input.policySnapshotHash })
        ]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function createWorkflowHandoffsForRun(client: pg.Client, runId: string, workflow: WorkflowDefinition): Promise<void> {
  for (let stageIndex = 0; stageIndex < workflow.stages.length; stageIndex += 1) {
    const destination = workflow.stages[stageIndex];
    const dependencies = destination.depends_on ?? (stageIndex === 0 ? [] : [workflow.stages[stageIndex - 1].id]);
    for (const sourceStageId of dependencies) {
      const source = workflow.stages.find((stage) => stage.id === sourceStageId);
      if (!source) continue;
      const handoff = await client.query<{ id: string }>(
        `insert into workflow_handoffs (run_id, sender_agent_id, receiver_agent_id, source_stage_id, destination_stage_id,
           transferred_artifacts, context_summary, acceptance_criteria, idempotency_key)
         values ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8)
         on conflict (run_id, idempotency_key) do nothing
         returning id::text`,
        [runId, source.agent, destination.agent, source.id, destination.id,
          `Transfer ${source.output} from ${source.id} to ${destination.id}.`,
          JSON.stringify(destination.acceptance_criteria ?? [destination.goal]), `${source.id}:${destination.id}`]
      );
      if (!handoff.rows[0]) continue;
      await client.query(
        `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, metadata)
         values ($1, $2, 'proposed', $3, $4)`,
        [handoff.rows[0].id, runId, source.agent, JSON.stringify({ generatedFromWorkflowDefinition: true })]
      );
    }
  }
}

export interface ClaimedWorkflowTask {
  taskId: string;
  runId: string;
  projectRootUri: string;
  projectConfig: unknown;
  workflowId: string;
  workflowTask: string;
  stageId: string;
  stageGoal: string;
  stagePattern: unknown;
  agentId: string;
  agentName: string;
  agentPrompt: string;
  modelTier: string | null;
  providerOverride: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  fencingToken: string;
  executorSnapshot?: ExecutorSnapshot | null;
  compiledBrief: string;
  priorReceipts: Array<{
    agentId: string;
    actionType: string;
    summary: string;
  }>;
  priorStageArtifacts: Array<{
    stageId: string;
    agentId: string;
    summary: string;
    artifact: Record<string, unknown>;
  }>;
}

export async function claimNextWorkflowTask(input?: { workerId?: string; leaseSeconds?: number; projectRootUri?: string; providerIds?: string[]; defaultProviderId?: string; workerPlatform?: NodeJS.Platform; excludedProjectRootUris?: string[]; perProjectConcurrency?: number }): Promise<ClaimedWorkflowTask | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const workerId = input?.workerId?.trim() || `worker-${process.pid}`;
      const leaseSeconds = Math.max(30, Math.min(3600, input?.leaseSeconds ?? 120));
      const projectRootUri = input?.projectRootUri?.trim() || null;
      // undefined preserves the legacy unrestricted caller contract. An
      // explicitly empty capability set must fail closed so a quarantined
      // worker cannot claim work for a provider it cannot execute.
      const providerIds = input?.providerIds === undefined ? null : [...new Set(input.providerIds)];
      const defaultProviderId = input?.defaultProviderId?.trim() || null;
      const workerPlatform = input?.workerPlatform ?? null;
      const excludedProjectRootUris = input?.excludedProjectRootUris?.length ? [...new Set(input.excludedProjectRootUris)] : null;
      const perProjectConcurrency = Math.max(1, Math.min(16, input?.perProjectConcurrency ?? 2));
      // Claim selection is short and transactional. Serializing only this
      // decision prevents multiple workers from racing past a project's cap;
      // task execution remains fully parallel after the transaction commits.
      await client.query("select pg_advisory_xact_lock(hashtext('agentflow:workflow-task-scheduler'))");
      const result = await client.query<Omit<ClaimedWorkflowTask, "compiledBrief" | "priorReceipts" | "priorStageArtifacts">>(
        `with next_task as (
           select wt.id
           from workflow_tasks wt
           join workflow_runs wr on wr.id = wt.run_id
           join projects p on p.id = wr.project_id
           join workflows wf on wf.id = wr.workflow_id
           join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') with ordinality stage(definition, stage_order)
             on stage.definition->>'id' = wt.stage_id
           where wt.status = 'queued'
             and wr.status in ('queued', 'leased', 'running')
             and wt.available_at <= now()
             and ($3::text is null or p.root_uri = $3)
             and ($5::text[] is null or not (p.root_uri = any($5::text[])))
             and (
               coalesce(jsonb_array_length(p.config->'execution'->'worker_pool'->'allowed_platforms'), 0) = 0
               or $8::text in (
                 select jsonb_array_elements_text(p.config->'execution'->'worker_pool'->'allowed_platforms')
               )
             )
             and (
               select count(*)
               from workflow_tasks project_active
               join workflow_runs project_run on project_run.id = project_active.run_id
               where project_run.project_id = wr.project_id
                 and project_active.status in ('leased', 'running')
             ) < $6::int
             and (
               $4::text[] is null
               or (
                 cardinality($4::text[]) > 0
                 and (
                   coalesce(
                     nullif(nullif(wr.provider_override, 'auto'), 'default'),
                     nullif(nullif(stage.definition->'routing'->>'provider', 'default'), 'auto'),
                     nullif(nullif($7::text, 'default'), 'auto')
                   ) is null
                   or coalesce(
                     nullif(nullif(wr.provider_override, 'auto'), 'default'),
                     nullif(nullif(stage.definition->'routing'->>'provider', 'default'), 'auto'),
                     nullif(nullif($7::text, 'default'), 'auto')
                   ) = any($4::text[])
                 )
               )
             )
             and not exists (
               select 1
               from workflow_tasks active
               join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') active_stage
                 on active_stage->>'id' = active.stage_id
               where active.run_id = wt.run_id
                 and active.status in ('leased', 'running')
                 and (
                   active.worker_id is distinct from $1
                   or stage.definition->>'parallel_group' is null
                   or active_stage->>'parallel_group' is distinct from stage.definition->>'parallel_group'
                 )
             )
             and not exists (
               select 1
               from workflow_tasks prior
               join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') with ordinality prior_stage(definition, stage_order)
                 on prior_stage.definition->>'id' = prior.stage_id
               where prior.run_id = wt.run_id
                 and (
                   case
                     when stage.definition ? 'depends_on'
                       then prior.stage_id = any(array(select jsonb_array_elements_text(stage.definition->'depends_on')))
                     else prior_stage.stage_order < stage.stage_order
                   end
                 )
                 and prior.status <> 'completed'
             )
           order by
             (
               select count(*)
               from workflow_tasks project_active
               join workflow_runs project_run on project_run.id = project_active.run_id
               where project_run.project_id = wr.project_id
                 and project_active.status in ('leased', 'running')
             ) asc,
             wt.available_at asc,
             stage.stage_order asc
           limit 1
           for update of wt skip locked
         )
         update workflow_tasks wt
         set status = 'leased',
             attempts = wt.attempts + 1,
             worker_id = $1,
             lease_expires_at = now() + ($2::int * interval '1 second'),
             started_at = null
         from next_task, workflow_runs wr, workflows wf, agents a, projects p
         where wt.id = next_task.id
           and wr.id = wt.run_id
           and p.id = wr.project_id
           and wf.id = wr.workflow_id
           and a.id = wt.agent_id
         returning
           wt.id as "taskId",
           wt.run_id as "runId",
           p.root_uri as "projectRootUri",
           coalesce(nullif(wr.policy_snapshot, '{}'::jsonb), p.config) as "projectConfig",
           wr.workflow_id as "workflowId",
           wr.task as "workflowTask",
           wt.stage_id as "stageId",
           coalesce((
             select stage->>'goal'
             from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') stage
             where stage->>'id' = wt.stage_id
             limit 1
           ), '') as "stageGoal",
           coalesce((
             select stage->'pattern'
             from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') stage
             where stage->>'id' = wt.stage_id
             limit 1
           ), '{}'::jsonb) as "stagePattern",
           wt.agent_id as "agentId",
           a.display_name as "agentName",
           a.definition->>'prompt' as "agentPrompt",
           coalesce(wr.provider_override, nullif((
             select stage->'routing'->>'provider'
             from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') stage
             where stage->>'id' = wt.stage_id limit 1
           ), 'default')) as "providerOverride",
           wt.worker_id as "workerId",
           wt.lease_expires_at::text as "leaseExpiresAt",
           '0'::text as "fencingToken",
           nullif(wt.executor_snapshot, '{}'::jsonb) as "executorSnapshot",
           coalesce(wr.model_tier_override, (
             select stage->'routing'->>'model_tier'
             from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') stage
             where stage->>'id' = wt.stage_id limit 1
           ), a.definition->>'model_tier') as "modelTier"`
        ,
        [workerId, leaseSeconds, projectRootUri, providerIds, excludedProjectRootUris, perProjectConcurrency, defaultProviderId, workerPlatform]
      );

      if (!result.rows[0]) {
        await client.query("commit");
        return null;
      }

      const leaseEpoch = await acquireWorkflowRunLease(client, {
        runId: result.rows[0].runId,
        workerId,
        leaseSeconds,
        taskId: result.rows[0].taskId
      });
      await client.query(
        `update workflow_tasks set lease_generation = $2::bigint where id = $1::uuid`,
        [result.rows[0].taskId, leaseEpoch]
      );
      result.rows[0].fencingToken = leaseEpoch;

      const acceptedHandoffs = await client.query<{ id: string }>(
        `update workflow_handoffs wh set status = 'accepted', accepted_at = now(), updated_at = now()
         where wh.run_id = $1 and wh.destination_stage_id = $2 and wh.status in ('proposed', 'retrying')
           and exists (select 1 from workflow_tasks source where source.run_id = wh.run_id and source.stage_id = wh.source_stage_id and source.status = 'completed')
         returning wh.id::text`,
        [result.rows[0].runId, result.rows[0].stageId]
      );
      for (const handoff of acceptedHandoffs.rows) {
        await client.query(
          `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, metadata)
           values ($1, $2, 'accepted', $3, $4)`,
          [handoff.id, result.rows[0].runId, result.rows[0].agentId, JSON.stringify({ taskId: result.rows[0].taskId })]
        );
      }

      await client.query("commit");
      const claimed = result.rows[0];
      const context = await loadStageContext(client, claimed.runId);
      return {
        ...claimed,
        ...context
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function startWorkflowTask(input: { taskId: string; runId: string; workerId: string; fencingToken: string }): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
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

function exactGitRevision(projectRootUri: string): string {
  const revision = execFileSync("git", ["-C", projectRootUri, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Remote executor requires an exact 40-character Git revision.");
  return revision;
}

async function assertActiveTaskFence(client: pg.Client, input: { taskId: string; workerId: string; fencingToken: string }): Promise<void> {
  const result = await client.query(
    `select 1
     from workflow_tasks wt
     join workflow_runs wr on wr.id = wt.run_id
     where wt.id=$1 and wt.status='running' and wt.worker_id=$2
       and wt.lease_generation=$3::bigint and wt.lease_expires_at>now()
       and wr.lease_owner=$2 and wr.lease_epoch=$3::bigint and wr.lease_expires_at>now()
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
      const run = await client.query(
        `update workflow_runs
         set lease_expires_at = now() + ($4::int * interval '1 second')
         where id = $1::uuid and lease_owner = $2 and lease_epoch = $3::bigint
           and status in ('leased','running') and lease_expires_at > now()
         returning id`,
        [input.runId, input.workerId, input.fencingToken, leaseSeconds]
      );
      if (run.rowCount !== 1) {
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
      await assertActiveTaskFence(client, input);
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

      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, $2, 'stage_completed', $3, $4, $5)`,
        [
          input.runId,
          input.agentId,
          input.taskId,
          input.summary,
          JSON.stringify(input.artifact)
        ]
      );

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
        await transitionWorkflowRun(client, {
          runId: input.runId,
          to: "completed",
          actor: input.workerId,
          reason: "All workflow tasks completed.",
          idempotencyKey: `run-completed:${input.taskId}:${input.fencingToken}`,
          expectedLeaseEpoch: input.fencingToken,
          expectedLeaseOwner: input.workerId,
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
          [input.runId, input.workerId, input.fencingToken, input.taskId]
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
      await client.query(
        `insert into artifacts (run_id, task_id, kind, uri, content)
         values ($1, $2, 'stage_output', $3, $4)
         on conflict (uri) do update set content = excluded.content`,
        [input.runId, input.taskId, outputUri, JSON.stringify(input.artifact)]
      );
      await client.query(
        `update workflow_tasks set status = 'blocked', output_uri = $2, finished_at = now() where id = $1`,
        [input.taskId, outputUri]
      );
      await client.query(
        `update workflow_tasks
         set status = 'cancelled', finished_at = now()
         where run_id = $1 and id <> $2 and status in ('queued', 'leased', 'running')`,
        [input.runId, input.taskId]
      );
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, $2, 'stage_blocked', $3, $4, $5)`,
        [input.runId, input.agentId, input.taskId, input.summary, JSON.stringify({ reason: input.reason, outputUri })]
      );
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
        expectedLeaseEpoch: input.fencingToken,
        expectedLeaseOwner: input.workerId,
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

      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, $2, 'stage_failed', $3, $4, $5)`,
        [
          input.runId,
          input.agentId,
          input.taskId,
          input.error,
          JSON.stringify({ error: input.error })
        ]
      );

      await client.query(
        `update workflow_tasks
         set status = 'cancelled',
             finished_at = now()
         where run_id = $1
           and id <> $2
           and status in ('queued', 'leased', 'running')`,
        [input.runId, input.taskId]
      );

      await transitionWorkflowRun(client, {
        runId: input.runId,
        to: "failed",
        actor: input.workerId,
        reason: input.error,
        idempotencyKey: `run-failed:${input.taskId}:${input.fencingToken}`,
        expectedLeaseEpoch: input.fencingToken,
        expectedLeaseOwner: input.workerId,
        metadata: { taskId: input.taskId }
      });

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function recordRunAction(input: {
  runId: string;
  taskId?: string | null;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  artifactKind: string;
  artifactContent: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<string> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const artifactContent = input.idempotencyKey
        ? { ...input.artifactContent, idempotencyKey: input.idempotencyKey }
        : input.artifactContent;
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          input.runId,
          input.agentId,
          input.actionType,
          input.target,
          input.summary,
          JSON.stringify(artifactContent)
        ]
      );

      const artifactUri = input.idempotencyKey
        ? `db://workflow_runs/${input.runId}/${input.artifactKind}/${input.idempotencyKey}`
        : `db://workflow_runs/${input.runId}/${input.artifactKind}/${Date.now()}`;
      await client.query(
        `insert into artifacts (run_id, task_id, kind, uri, content)
         values ($1, $2, $3, $4, $5)
         on conflict (uri) do update
         set content = excluded.content`,
        [
          input.runId,
          input.taskId ?? null,
          input.artifactKind,
          artifactUri,
          JSON.stringify(artifactContent)
        ]
      );

      await client.query("commit");
      return artifactUri;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function findRunActionByIdempotencyKey(input: {
  runId: string;
  artifactKind: string;
  idempotencyKey: string;
}): Promise<ArtifactStatus | null> {
  return withClient(async (client) => {
    const artifactUri = `db://workflow_runs/${input.runId}/${input.artifactKind}/${input.idempotencyKey}`;
    const result = await client.query<ArtifactStatus>(
      `select
         id::text,
         run_id::text as "runId",
         task_id::text as "taskId",
         kind,
         uri,
         content,
         created_at::text as "createdAt"
       from artifacts
       where run_id = $1::uuid
         and kind = $2
         and uri = $3
         and content->>'idempotencyKey' = $4
       limit 1`,
      [input.runId, input.artifactKind, artifactUri, input.idempotencyKey]
    );
    return result.rows[0] ?? null;
  });
}

export interface WorkflowRunStatus {
  id: string;
  status: string;
  workflowId: string;
  task: string;
  autonomy: string;
  policyProfile: string;
  policySnapshotHash: string;
  modelTierOverride: string | null;
  providerOverride: string | null;
  evaluationMetadata: Record<string, unknown>;
  replacementRunId?: string | null;
  replacementRunStatus?: string | null;
  replacementRunStartedAt?: string | null;
  workflowDefinitionVersion?: string;
  workflowDefinitionHash?: string;
  constructionRationale?: Record<string, unknown>;
  projectName: string;
  projectRootUri: string;
  startedAt: string;
  finishedAt: string | null;
  blockedReason?: string | null;
  failedReason?: string | null;
  dismissed?: boolean;
  stateVersion?: string;
  leaseEpoch?: string;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
}

export interface WorkflowTaskStatus {
  id: string;
  stageId: string;
  agentId: string;
  status: string;
  skipped?: boolean;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  executorSnapshot?: ExecutorSnapshot | null;
}

export interface WorkflowStageHealthStatus {
  stageId: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  queuedTasks: number;
  runningTasks: number;
  cancelledTasks: number;
}

export interface WorkflowStageRunStatus {
  runId: string;
  runStatus: string;
  task: string;
  stageId: string;
  agentId: string;
  taskStatus: string;
  attempts: number;
  taskStartedAt: string | null;
  taskFinishedAt: string | null;
  runStartedAt: string;
  runFinishedAt: string | null;
}

export interface ActionReceiptStatus {
  id: string;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  createdAt: string;
}

export type WorkflowHandoffStatus = "proposed" | "accepted" | "rejected" | "retrying" | "completed" | "failed";

export interface WorkflowHandoffEventStatus {
  id: string;
  status: WorkflowHandoffStatus;
  actorAgentId: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowHandoffRecord {
  id: string;
  runId: string;
  senderAgentId: string;
  receiverAgentId: string;
  sourceStageId: string;
  destinationStageId: string;
  transferredArtifacts: unknown[];
  contextSummary: string;
  acceptanceCriteria: unknown[];
  status: WorkflowHandoffStatus;
  idempotencyKey: string;
  proposedAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  retryingAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  updatedAt: string;
  receiptIds: string[];
  events: WorkflowHandoffEventStatus[];
}

const handoffTransitions: Record<WorkflowHandoffStatus, readonly WorkflowHandoffStatus[]> = {
  proposed: ["accepted", "rejected"],
  accepted: ["retrying", "completed", "failed"],
  rejected: ["retrying"],
  retrying: ["accepted", "rejected", "completed", "failed"],
  completed: [],
  failed: ["retrying"]
};

export function assertWorkflowHandoffTransition(from: WorkflowHandoffStatus, to: WorkflowHandoffStatus): void {
  if (!handoffTransitions[from]?.includes(to)) {
    throw new Error(`Invalid workflow handoff transition: ${from} -> ${to}`);
  }
}

export async function proposeWorkflowHandoff(input: {
  runId: string;
  senderAgentId: string;
  receiverAgentId: string;
  sourceStageId: string;
  destinationStageId: string;
  transferredArtifacts?: unknown[];
  contextSummary: string;
  acceptanceCriteria: unknown[];
  idempotencyKey: string;
  receiptIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<string> {
  if (!input.contextSummary.trim()) throw new Error("Workflow handoff context summary is required.");
  if (!input.acceptanceCriteria.length) throw new Error("Workflow handoff acceptance criteria are required.");
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string }>(
        `insert into workflow_handoffs (
           run_id, sender_agent_id, receiver_agent_id, source_stage_id, destination_stage_id,
           transferred_artifacts, context_summary, acceptance_criteria, idempotency_key
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (run_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
         returning id::text`,
        [input.runId, input.senderAgentId, input.receiverAgentId, input.sourceStageId, input.destinationStageId,
          JSON.stringify(input.transferredArtifacts ?? []), input.contextSummary, JSON.stringify(input.acceptanceCriteria), input.idempotencyKey]
      );
      const handoffId = result.rows[0].id;
      await client.query(
        `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, metadata)
         select $1, $2, 'proposed', $3, $4
         where not exists (select 1 from workflow_handoff_events where handoff_id = $1 and status = 'proposed')`,
        [handoffId, input.runId, input.senderAgentId, JSON.stringify(input.metadata ?? {})]
      );
      await linkHandoffReceipts(client, handoffId, input.runId, input.receiptIds ?? []);
      await client.query("commit");
      return handoffId;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function transitionWorkflowHandoff(input: {
  handoffId: string;
  status: Exclude<WorkflowHandoffStatus, "proposed">;
  actorAgentId?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  receiptIds?: string[];
}): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const current = await client.query<{ runId: string; status: WorkflowHandoffStatus }>(
        `select run_id::text as "runId", status from workflow_handoffs where id = $1 for update`, [input.handoffId]
      );
      if (!current.rows[0]) {
        await client.query("rollback");
        return false;
      }
      assertWorkflowHandoffTransition(current.rows[0].status, input.status);
      await client.query(
        `update workflow_handoffs set status = $2,
           accepted_at = case when $2 = 'accepted' then now() else accepted_at end,
           rejected_at = case when $2 = 'rejected' then now() else rejected_at end,
           retrying_at = case when $2 = 'retrying' then now() else retrying_at end,
           completed_at = case when $2 = 'completed' then now() else completed_at end,
           failed_at = case when $2 = 'failed' then now() else failed_at end,
           updated_at = now()
         where id = $1`, [input.handoffId, input.status]
      );
      await client.query(
        `insert into workflow_handoff_events (handoff_id, run_id, status, actor_agent_id, note, metadata)
         values ($1, $2, $3, $4, $5, $6)`,
        [input.handoffId, current.rows[0].runId, input.status, input.actorAgentId ?? null, input.note ?? null, JSON.stringify(input.metadata ?? {})]
      );
      await linkHandoffReceipts(client, input.handoffId, current.rows[0].runId, input.receiptIds ?? []);
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function listWorkflowHandoffs(input: { runId: string }): Promise<WorkflowHandoffRecord[]> {
  return withClient(async (client) => {
    const result = await client.query<WorkflowHandoffRecord>(
      `select wh.id::text, wh.run_id::text as "runId", wh.sender_agent_id as "senderAgentId",
         wh.receiver_agent_id as "receiverAgentId", wh.source_stage_id as "sourceStageId",
         wh.destination_stage_id as "destinationStageId", wh.transferred_artifacts as "transferredArtifacts",
         wh.context_summary as "contextSummary", wh.acceptance_criteria as "acceptanceCriteria", wh.status,
         wh.idempotency_key as "idempotencyKey", wh.proposed_at::text as "proposedAt",
         wh.accepted_at::text as "acceptedAt", wh.rejected_at::text as "rejectedAt",
         wh.retrying_at::text as "retryingAt", wh.completed_at::text as "completedAt",
         wh.failed_at::text as "failedAt", wh.updated_at::text as "updatedAt",
         coalesce((select jsonb_agg(whr.receipt_id::text order by whr.created_at) from workflow_handoff_receipts whr where whr.handoff_id = wh.id), '[]') as "receiptIds",
         coalesce((select jsonb_agg(jsonb_build_object('id', whe.id::text, 'status', whe.status, 'actorAgentId', whe.actor_agent_id,
           'note', whe.note, 'metadata', whe.metadata, 'createdAt', whe.created_at::text) order by whe.created_at, whe.id)
           from workflow_handoff_events whe where whe.handoff_id = wh.id), '[]') as events
       from workflow_handoffs wh where wh.run_id = $1 order by wh.proposed_at, wh.id`, [input.runId]
    );
    return result.rows;
  });
}

async function linkHandoffReceipts(client: pg.Client, handoffId: string, runId: string, receiptIds: string[]): Promise<void> {
  for (const receiptId of receiptIds) {
    await client.query(
      `insert into workflow_handoff_receipts (handoff_id, receipt_id)
       select $1, ar.id from action_receipts ar where ar.id = $2 and ar.run_id = $3
       on conflict do nothing`, [handoffId, receiptId, runId]
    );
  }
}

export interface ArtifactStatus {
  id: string;
  runId: string;
  taskId: string | null;
  kind: string;
  uri: string;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface ArtifactLifecycleStatus {
  id: string;
  runId: string;
  taskId: string | null;
  kind: string;
  uri: string;
  contentBytes: number;
  createdAt: string;
  workflowId: string;
  runStatus: string;
  projectName: string;
  projectRootUri: string;
}

export async function listWorkflowRuns(limit: number): Promise<WorkflowRunStatus[]> {
  return withClient(async (client) => {
    const result = await client.query<WorkflowRunStatus>(
      `select
         wr.id::text,
         wr.status,
         wr.workflow_id as "workflowId",
         wr.task,
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         wr.workflow_definition_version as "workflowDefinitionVersion",
         wr.workflow_definition_hash as "workflowDefinitionHash",
         wr.construction_rationale as "constructionRationale",
         wr.state_version::text as "stateVersion",
         wr.lease_epoch::text as "leaseEpoch",
         wr.lease_owner as "leaseOwner",
         wr.lease_expires_at::text as "leaseExpiresAt",
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         case when wr.status = 'blocked' then (
           select coalesce(ar.metadata->>'reason', ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_blocked'
           order by ar.created_at desc
           limit 1
         ) else null end as "blockedReason",
         case when wr.status = 'failed' then (
           select coalesce(nullif(ar.metadata->>'failureReason', ''), nullif(ar.metadata->>'reason', ''), ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_failed'
           order by ar.created_at desc
           limit 1
         ) else null end as "failedReason",
         exists (
           select 1
           from action_receipts dismissed
           where dismissed.run_id = wr.id
             and dismissed.action_type = 'failed_run_dismissed'
             and not exists (
               select 1 from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         ) as dismissed
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       order by wr.started_at desc
       limit $1`,
      [limit]
    );
    return result.rows;
  });
}

export interface ActivityEventStatus {
  id: string;
  occurredAt: string;
  projectName: string;
  projectRootUri: string;
  runId: string | null;
  category: "workflow" | "stage" | "action" | "approval";
  eventType: string;
  severity: "info" | "warning" | "error";
  status: string;
  actor: string | null;
  title: string;
  detail: string;
  source: string;
}

export async function listActivityEvents(input: { limit?: number; projectRootUri?: string; runId?: string }): Promise<ActivityEventStatus[]> {
  return withClient(async (client) => {
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
    const projectRootUri = input.projectRootUri?.trim() || null;
    const runId = input.runId?.trim() || null;
    const result = await client.query<ActivityEventStatus>(
      `with activity as (
         select 'run-start:' || wr.id::text as id, wr.started_at as occurred_at,
                p.name as project_name, p.root_uri as project_root_uri, wr.id as run_id,
                'workflow'::text as category, 'workflow_started'::text as event_type,
                'info'::text as severity, 'started'::text as status,
                null::text as actor, 'Workflow started: ' || wr.workflow_id as title,
                left(wr.task, 500) as detail, 'workflow_runs'::text as source
           from workflow_runs wr join projects p on p.id = wr.project_id
         union all
         select 'run-finish:' || wr.id::text, wr.finished_at, p.name, p.root_uri, wr.id,
                'workflow', 'workflow_' || wr.status,
                case when wr.status = 'failed' then 'error' when wr.status = 'blocked' then 'warning' else 'info' end,
                wr.status, null, 'Workflow ' || wr.status || ': ' || wr.workflow_id,
                left(wr.task, 500), 'workflow_runs'
           from workflow_runs wr join projects p on p.id = wr.project_id where wr.finished_at is not null
         union all
         select 'task-start:' || wt.id::text, wt.started_at, p.name, p.root_uri, wr.id,
                'stage', 'stage_started', 'info', 'started', wt.agent_id,
                'Stage started: ' || wt.stage_id, 'Agent: ' || wt.agent_id, 'workflow_tasks'
           from workflow_tasks wt join workflow_runs wr on wr.id = wt.run_id join projects p on p.id = wr.project_id
          where wt.started_at is not null
         union all
         select 'task-finish:' || wt.id::text, wt.finished_at, p.name, p.root_uri, wr.id,
                'stage', 'stage_' || wt.status,
                case when wt.status = 'failed' then 'error' when wt.status = 'blocked' then 'warning' else 'info' end,
                wt.status, wt.agent_id, 'Stage ' || wt.status || ': ' || wt.stage_id,
                'Agent: ' || wt.agent_id, 'workflow_tasks'
           from workflow_tasks wt join workflow_runs wr on wr.id = wt.run_id join projects p on p.id = wr.project_id
          where wt.finished_at is not null
         union all
         select 'receipt:' || ar.id::text, ar.created_at, p.name, p.root_uri, wr.id,
                'action', ar.action_type,
                case when ar.action_type ~ '(failed|blocked|rejected|denied)' then
                  case when ar.action_type ~ '(failed|denied)' then 'error' else 'warning' end
                  else 'info' end,
                coalesce(ar.metadata->>'status', ar.action_type), ar.agent_id,
                left(replace(ar.action_type, '_', ' '), 160), left(ar.summary, 500), 'action_receipts'
           from action_receipts ar join workflow_runs wr on wr.id = ar.run_id join projects p on p.id = wr.project_id
         union all
         select 'approval:' || aa.id::text, coalesce(aa.executed_at, aa.decided_at, aa.created_at), p.name, p.root_uri, wr.id,
                'approval', 'approval_' || aa.status,
                case when aa.status in ('rejected', 'failed') then 'warning' else 'info' end,
                aa.status, coalesce(aa.executed_by, aa.decided_by), 'Approval ' || aa.status || ': ' || aa.action_type,
                left(aa.rationale, 500), 'action_approvals'
           from action_approvals aa join workflow_runs wr on wr.id = aa.run_id join projects p on p.id = wr.project_id
       )
       select id, occurred_at::text as "occurredAt", project_name as "projectName",
              project_root_uri as "projectRootUri", run_id::text as "runId", category,
              event_type as "eventType", severity, status, actor, title, detail, source
         from activity
        where occurred_at is not null
          and ($2::text is null or project_root_uri = $2)
          and ($3::uuid is null or run_id = $3::uuid)
        order by occurred_at desc
        limit $1`,
      [limit, projectRootUri, runId]
    );
    return result.rows;
  });
}

export async function listWorkflowRunsForProject(input: {
  projectRootUri: string;
  limit: number;
}): Promise<WorkflowRunStatus[]> {
  return withClient(async (client) => {
    const result = await client.query<WorkflowRunStatus>(
      `select
         wr.id::text,
         wr.status,
         wr.workflow_id as "workflowId",
         wr.task,
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         wr.workflow_definition_version as "workflowDefinitionVersion",
         wr.workflow_definition_hash as "workflowDefinitionHash",
         wr.construction_rationale as "constructionRationale",
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         case when wr.status = 'blocked' then (
           select coalesce(ar.metadata->>'reason', ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_blocked'
           order by ar.created_at desc
           limit 1
         ) else null end as "blockedReason",
         case when wr.status = 'failed' then (
           select coalesce(nullif(ar.metadata->>'failureReason', ''), nullif(ar.metadata->>'reason', ''), ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_failed'
           order by ar.created_at desc
           limit 1
         ) else null end as "failedReason",
         exists (
           select 1
           from action_receipts dismissed
           where dismissed.run_id = wr.id
             and dismissed.action_type = 'failed_run_dismissed'
             and not exists (
               select 1 from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         ) as dismissed
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       where p.root_uri = $1
       order by wr.started_at desc
       limit $2`,
      [input.projectRootUri, input.limit]
    );
    return result.rows;
  });
}

export async function listWorkflowStageHealthForRuns(input: {
  runIds: string[];
}): Promise<WorkflowStageHealthStatus[]> {
  if (!input.runIds.length) return [];
  return withClient(async (client) => {
    const result = await client.query<WorkflowStageHealthStatus>(
      `select
         wt.stage_id as "stageId",
         count(*)::int as "totalTasks",
         count(*) filter (where wt.status = 'completed')::int as "completedTasks",
         count(*) filter (where wt.status = 'failed')::int as "failedTasks",
         count(*) filter (where wt.status = 'queued')::int as "queuedTasks",
         count(*) filter (where wt.status in ('leased','running'))::int as "runningTasks",
         count(*) filter (where wt.status = 'cancelled')::int as "cancelledTasks"
       from workflow_tasks wt
       where wt.run_id = any($1::uuid[])
       group by wt.stage_id
       order by wt.stage_id asc`,
      [input.runIds]
    );
    return result.rows;
  });
}

export async function listWorkflowStageRunsForRuns(input: {
  runIds: string[];
  stageId: string;
}): Promise<WorkflowStageRunStatus[]> {
  if (!input.runIds.length) return [];
  return withClient(async (client) => {
    const result = await client.query<WorkflowStageRunStatus>(
      `select
         wr.id::text as "runId",
         wr.status as "runStatus",
         wr.task,
         wt.stage_id as "stageId",
         wt.agent_id as "agentId",
         wt.status as "taskStatus",
         wt.attempts,
         wt.started_at::text as "taskStartedAt",
         wt.finished_at::text as "taskFinishedAt",
         wr.started_at::text as "runStartedAt",
         wr.finished_at::text as "runFinishedAt"
       from workflow_tasks wt
       join workflow_runs wr on wr.id = wt.run_id
       where wt.run_id = any($1::uuid[])
         and wt.stage_id = $2
       order by wr.started_at desc, wt.available_at asc`,
      [input.runIds, input.stageId]
    );
    return result.rows;
  });
}

export async function getWorkflowRunDetails(runId: string): Promise<{
  run: WorkflowRunStatus | null;
  tasks: WorkflowTaskStatus[];
  receipts: ActionReceiptStatus[];
}> {
  return withClient(async (client) => {
    const runResult = await client.query<WorkflowRunStatus>(
      `select
         wr.id::text,
         wr.status,
         wr.workflow_id as "workflowId",
         wr.task,
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         replacement.id as "replacementRunId",
         replacement.status as "replacementRunStatus",
         replacement.started_at as "replacementRunStartedAt",
         wr.workflow_definition_version as "workflowDefinitionVersion",
         wr.workflow_definition_hash as "workflowDefinitionHash",
         wr.construction_rationale as "constructionRationale",
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         case when wr.status = 'blocked' then (
           select coalesce(ar.metadata->>'reason', ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_blocked'
           order by ar.created_at desc
           limit 1
         ) else null end as "blockedReason",
         case when wr.status = 'failed' then (
           select coalesce(nullif(ar.metadata->>'failureReason', ''), nullif(ar.metadata->>'reason', ''), ar.summary)
           from action_receipts ar
           where ar.run_id = wr.id and ar.action_type = 'stage_failed'
           order by ar.created_at desc
           limit 1
         ) else null end as "failedReason"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       left join lateral (
         with recursive descendants as (
           select next_run.id, next_run.status, next_run.started_at, 1 as depth, array[wr.id, next_run.id] as path
           from workflow_runs next_run
           where next_run.evaluation_metadata->>'replayOfRunId' = wr.id::text
              or next_run.evaluation_metadata->>'sourceRunId' = wr.id::text
           union all
           select child.id, child.status, child.started_at, parent.depth + 1, parent.path || child.id
           from workflow_runs child
           join descendants parent on child.evaluation_metadata->>'replayOfRunId' = parent.id::text
             or child.evaluation_metadata->>'sourceRunId' = parent.id::text
           where parent.depth < 20 and not child.id = any(parent.path)
         )
         select id::text, status, started_at::text
         from descendants
         order by depth desc, started_at desc
         limit 1
       ) replacement on true
       where wr.id = $1`,
      [runId]
    );

    const taskResult = await client.query<WorkflowTaskStatus>(
      `select
         wt.id::text,
         wt.stage_id as "stageId",
         wt.agent_id as "agentId",
         wt.status,
         exists (
           select 1 from action_receipts skipped_receipt
           where skipped_receipt.run_id = wt.run_id
             and skipped_receipt.target = wt.id::text
             and skipped_receipt.action_type = 'stage_blocker_ignored'
         ) as skipped,
         wt.attempts,
         nullif(wt.executor_snapshot, '{}'::jsonb) as "executorSnapshot",
         wt.started_at::text as "startedAt",
         wt.finished_at::text as "finishedAt"
       from workflow_tasks wt
       join workflow_runs wr on wr.id = wt.run_id
       left join workflows wf on wf.id = wr.workflow_id
       join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') with ordinality stage(definition, stage_order)
         on stage.definition->>'id' = wt.stage_id
       where wt.run_id = $1
       order by stage.stage_order asc`,
      [runId]
    );

    const receiptResult = await client.query<ActionReceiptStatus>(
      `select
         id::text,
         agent_id as "agentId",
         action_type as "actionType",
         target,
         summary,
         created_at::text as "createdAt"
       from action_receipts
       where run_id = $1
       order by created_at asc`,
      [runId]
    );

    return {
      run: runResult.rows[0] ?? null,
      tasks: taskResult.rows,
      receipts: receiptResult.rows
    };
  });
}

export async function listArtifacts(input: {
  runId: string;
  kind?: string;
}): Promise<ArtifactStatus[]> {
  return withClient(async (client) => {
    const result = await client.query<ArtifactStatus>(
      `select
         id::text,
         run_id::text as "runId",
         task_id::text as "taskId",
         kind,
         uri,
         content,
         created_at::text as "createdAt"
       from artifacts
       where run_id = $1
         and ($2::text is null or kind = $2)
       order by created_at asc`,
      [input.runId, input.kind ?? null]
    );
    return result.rows;
  });
}

export async function listArtifactLifecycle(input: {
  projectRootUri?: string;
  kind?: string;
  limit?: number;
} = {}): Promise<ArtifactLifecycleStatus[]> {
  return withClient(async (client) => {
    const result = await client.query<ArtifactLifecycleStatus>(
      `select
         a.id::text,
         a.run_id::text as "runId",
         a.task_id::text as "taskId",
         a.kind,
         a.uri,
         octet_length(a.content::text)::int as "contentBytes",
         a.created_at::text as "createdAt",
         wr.workflow_id as "workflowId",
         wr.status as "runStatus",
         p.name as "projectName",
         p.root_uri as "projectRootUri"
       from artifacts a
       join workflow_runs wr on wr.id = a.run_id
       join projects p on p.id = wr.project_id
       where ($1::text is null or p.root_uri = $1)
         and ($2::text is null or a.kind = $2)
       order by a.created_at desc
       limit $3`,
      [input.projectRootUri ?? null, input.kind ?? null, input.limit ?? 500]
    );
    return result.rows;
  });
}

export async function getArtifactByUri(uri: string): Promise<ArtifactStatus | null> {
  return withClient(async (client) => {
    const result = await client.query<ArtifactStatus>(
      `select
         id::text,
         run_id::text as "runId",
         task_id::text as "taskId",
         kind,
         uri,
         content,
         created_at::text as "createdAt"
       from artifacts
       where uri = $1`,
      [uri]
    );
    return result.rows[0] ?? null;
  });
}

export async function getArtifactById(id: string): Promise<ArtifactStatus | null> {
  return withClient(async (client) => {
    const result = await client.query<ArtifactStatus>(
      `select
         id::text,
         run_id::text as "runId",
         task_id::text as "taskId",
         kind,
         uri,
         content,
         created_at::text as "createdAt"
       from artifacts
       where id = $1::uuid`,
      [id]
    );
    return result.rows[0] ?? null;
  });
}

async function loadStageContext(client: pg.Client, runId: string): Promise<Pick<ClaimedWorkflowTask, "compiledBrief" | "priorReceipts" | "priorStageArtifacts">> {
  const briefResult = await client.query<{ text: string }>(
    `select content->>'text' as text
     from artifacts
     where run_id = $1 and kind = 'compiled_brief'
     order by created_at desc
     limit 1`,
    [runId]
  );

  const receiptsResult = await client.query<{
    agentId: string;
    actionType: string;
    summary: string;
  }>(
    `select
       agent_id as "agentId",
       action_type as "actionType",
       summary
     from action_receipts
     where run_id = $1
     order by created_at asc`,
    [runId]
  );

  const stageArtifactsResult = await client.query<{
    stageId: string;
    agentId: string;
    summary: string;
    artifact: Record<string, unknown>;
  }>(
    `select wt.stage_id as "stageId", wt.agent_id as "agentId",
       coalesce(a.content->>'summary', '') as summary, a.content as artifact
     from workflow_tasks wt
     join artifacts a on a.task_id = wt.id and a.kind = 'stage_output'
     where wt.run_id = $1 and wt.status = 'completed'
     order by wt.finished_at asc`,
    [runId]
  );

  return {
    compiledBrief: briefResult.rows[0]?.text ?? "",
    priorReceipts: receiptsResult.rows,
    priorStageArtifacts: stageArtifactsResult.rows
  };
}

export async function upsertMemoryItem(input: {
  projectRootUri: string;
  sourceUri: string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withClient(async (client) => {
    const projectResult = await client.query<{ id: string }>(
      `select id from projects where root_uri = $1`,
      [input.projectRootUri]
    );
    if (!projectResult.rows[0]) {
      return;
    }
    const projectId = projectResult.rows[0].id;
    const contentHash = `memory-${Date.now()}`;
    await client.query(
      `insert into memory_items (project_id, source_uri, content_hash, summary, metadata, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (project_id, source_uri, content_hash) do update
       set summary = excluded.summary,
           metadata = excluded.metadata,
           updated_at = now()`,
      [
        projectId,
        input.sourceUri,
        contentHash,
        input.summary,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  });
}

export async function getLatestMemory(input: {
  projectRootUri: string;
  limit?: number;
}): Promise<Array<{ sourceUri: string; summary: string; metadata: Record<string, unknown>; updatedAt: string }>> {
  return withClient(async (client) => {
    const result = await client.query<{ sourceUri: string; summary: string; metadata: Record<string, unknown>; updatedAt: string }>(
      `select
         mi.source_uri as "sourceUri",
         mi.summary,
         mi.metadata,
         mi.updated_at::text as "updatedAt"
       from memory_items mi
       join projects p on p.id = mi.project_id
       where p.root_uri = $1
       order by mi.updated_at desc
       limit $2`,
      [input.projectRootUri, input.limit ?? 10]
    );
    return result.rows;
  });
}

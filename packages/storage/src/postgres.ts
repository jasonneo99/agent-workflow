import { acquireWorkflowRunLease, coordinatorWorkerFencePredicate } from "./workflow-task-authority.js";
export {
  checkpointWorkflowTaskContinuation, holdWorkflowTaskForApprovals, workflowRunLeaseTransitionKey,
  requeueClaimedWorkflowTask,
  requeueRunningWorkflowTasks, requeueExpiredWorkflowTaskLeases, startWorkflowTask,
  assertWorkflowTaskLease, renewWorkflowTaskLease
} from "./workflow-task-authority.js";
export { cancelWorkflowRun, completeWorkflowTask, blockWorkflowTask, failWorkflowTask } from "./workflow-task-outcomes.js";
import { queueCoordinatorSchemaSql } from "./queue-coordinator-schema.js";
import { automaticRecoveryAdmissionFenceSql, automaticRecoveryWrapperReason, automaticRepeatForbidden, noAutomaticRepeatReason } from "./no-automatic-repeat.js";
import {assertGenericRunRecoveryAllowed} from './managed-run-recovery.js';
import { runPipelineSchemaSql, installationRequiresRunPipeline } from './run-pipeline.js';
import { pipelineContract, preparedWorkflow, type RunPipelineContract } from '../../run-environments/src/pipeline.js';

import type pg from "pg";
import type { ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import { createExecutorSnapshots, type ExecutorSnapshot } from "../../executor-adapters/src/index.js";
import { resolveExecutionPolicy } from "../../policy-engine/src/index.js";
import { completedStageProvidesPinnedBuildEvidence } from "../../model-providers/src/quality.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withClient } from "./client.js";
import { commandEvidencePacket } from "./command-evidence.js";
import { loadReplayEvidencePacket } from "./replay-evidence.js";
import { validateRecoveryCheckpoint } from "./checkpoint-provenance.js";
import { appendPlanContextInfluence } from "./context-influence.js";
import { acceptanceDigest, acceptanceGate, acceptancePreflight, enrollAcceptanceContract, storedAcceptanceDecision } from "./acceptance.js";
import type { StructuredAcceptanceContract } from "../../model-providers/src/types.js";
import { deliveryMetrics, type DeliveryMetricRun, type DeliveryMetricReceipt, type DeliveryAudit } from "./delivery-metrics.js";
import { transitionWorkflowRun } from "./run-transitions.js";
import { findRecentDuplicateRun, findReplayConflict } from "./run-deduplication.js";
import { isWorkflowRunState, type WorkflowRunState } from "./run-state-machine.js";
import { guardedAutonomySchemaSql } from "./guarded-autonomy-schema.js";
import { projectIdentitySchemaSql, registerProjectIdentityScope, projectIdentitySchemaAvailable } from "./project-identity.js";
import { projectRegistrationRoot } from "./project-registration-root.js";
import { stableJson, workflowDefinitionHash } from "./registry.js";
import { actionApprovalEventTriggerSql, runtimeEventFunctionSql, workflowTaskEventTriggerSql } from "./runtime-events.js";
import { inheritedRunSetSql, queueRunSetRepresentativeSql, workflowRunSetMigrationSql } from "./run-sets.js";
import { queuePresentationSql, relatedQueueCountsSql, relatedRunIdsSql } from "./queue-lineage.js";
import type { WorkflowQueueItem, WorkflowRunStatus } from "./workflow-run-types.js";
import {classifyFailureOwnership} from './failure-ownership.js';
import { buildRunPresentation } from "./run-presentation.js";
import { enqueueRunNotification, runNotificationOutboxSchemaSql, engineEventConsumerSchemaSql } from "./run-notifications.js";
import { notificationSubscriberSchemaSql } from "./notification-subscribers.js";
import { suspendResumeRuntimeSchemaSql } from "./suspend-resume-runtime.js";
export { PostgresInputQueue, PostgresSliceStore, enqueueBoundExecutorResult, registerBoundExecutorThread } from "./suspend-resume-runtime.js";
export { claimRunNotifications, settleRunNotification, acknowledgeRunNotification } from "./run-notifications.js";
export { databaseUrl, withClient } from "./client.js";
export { createWorkflowEventSubscriber, type WorkflowEventSubscriber } from "./runtime-events.js";
export type { WorkflowQueueItem, WorkflowRunStatus } from "./workflow-run-types.js";
export { seedRegistry, workflowDefinitionHash } from "./registry.js";
export { deleteProjectFiles, getProjectIndexState, upsertProject, upsertProjectFiles, upsertProjectIndexState, type ProjectIndexState } from "./project-index.js";
export { acquireWorkIntent, claimSideEffect, finalizeSideEffect, listWorkIntents, recordSideEffectOnce, releaseWorkIntent, renewWorkIntent, withProjectExecutionLock } from "./reliability.js";
export { appendProvenanceClaim, assertStageAuthority, issueStageAuthorityGrant, listCurrentBreakers, persistGuardedTransaction, queuePromotionCandidate, recordCanaryOutcome, revokeProvenanceSource, transitionPromotionCandidate, tripBreaker } from "./guarded-autonomy.js";
export { listWorkflowReuseEvidence } from "./reuse.js"; export { transitionWorkflowRun, type WorkflowRunTransitionInput } from "./run-transitions.js"; export { supersedeWorkflowRun } from "./run-supersession.js";
export {
  countActionApprovals,
  claimActionApprovalExecution,
  completeApprovalRequestRun, decideActionApproval, dismissSupersededActionApprovals,
  getActionApproval, listActionApprovals, markActionApprovalExecution,
  recoverInterruptedActionApprovalExecutions,
  requestActionApproval, type ActionApprovalStatus
} from "./action-approvals.js";
/**
 * Applies additive schema migrations. Safety guarantees:
 *
 * - Idempotent: every DDL statement uses IF NOT EXISTS, so running the
 *   migration twice (or after a partial failure) is safe.
 * - Concurrency-safe: Postgres DDL takes an ACCESS EXCLUSIVE lock, so
 *   concurrent migrateStorage() calls serialize; the loser sees the objects
 *   already exist and skips.
 * - Backward-compatible: only ADD COLUMN (nullable or with DEFAULT) and
 *   CREATE TABLE/INDEX. No column renames, drops, or type changes, so old
 *   code continues to work against a migrated database.
 * - Upgrade path: fresh databases get the full schema from infra/init.sql;
 *   existing databases pick up deltas via `agentflow migrate-storage`.
 */
export async function migrateStorage(): Promise<void> {
  await withClient(async (client) => {
    await client.query(projectIdentitySchemaSql);
    await client.query(runtimeEventFunctionSql);
    await client.query(workflowRunSetMigrationSql);
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
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS requester text,
      ADD COLUMN IF NOT EXISTS requester_channel text NOT NULL DEFAULT 'dashboard'
    `);
    await client.query(automaticRecoveryAdmissionFenceSql);
    await client.query(runPipelineSchemaSql);
    await client.query(`
      CREATE TABLE IF NOT EXISTS run_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        channel text NOT NULL DEFAULT 'dashboard',
        kind text NOT NULL,
        title text NOT NULL,
        body text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz,
        CONSTRAINT run_notifications_status_check CHECK (status IN ('pending','delivered','failed')),
        CONSTRAINT run_notifications_kind_check CHECK (kind IN ('approval_needed','blocked','failed','message'))
      )
    `);
    await client.query(runNotificationOutboxSchemaSql);
    await client.query(notificationSubscriberSchemaSql);
    await client.query(engineEventConsumerSchemaSql);
    await client.query(suspendResumeRuntimeSchemaSql);
    await client.query(`
      CREATE INDEX IF NOT EXISTS run_notifications_pending_idx
      ON run_notifications(status, created_at) WHERE status = 'pending'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS run_notifications_run_idx
      ON run_notifications(run_id)
    `);
    await client.query(workflowTaskEventTriggerSql);
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
    await client.query(guardedAutonomySchemaSql);
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
    await client.query(actionApprovalEventTriggerSql);
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
      ALTER TABLE action_approvals
      ADD COLUMN IF NOT EXISTS expires_at timestamptz
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS action_approvals_expires_idx
      ON action_approvals(expires_at) WHERE status = 'pending'
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
      ALTER TABLE action_receipts
      ADD COLUMN IF NOT EXISTS prev_hash text,
      ADD COLUMN IF NOT EXISTS receipt_hash text,
      ADD COLUMN IF NOT EXISTS metadata_serialization_version integer
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS action_receipts_run_chain_idx
      ON action_receipts(run_id, created_at ASC)
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
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx ON workflow_runs(project_id, status, started_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status_idx ON workflow_runs(workflow_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_idx ON workflow_tasks(run_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS action_receipts_run_created_idx ON action_receipts(run_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS artifacts_task_kind_idx ON artifacts(task_id, kind)`);
    // Queue presentation reads coordinator lineage even before the coordinator runs.
    await client.query(queueCoordinatorSchemaSql);
  });
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

export async function listWorkflowQueue(limit = 50, options?: { projectRootUri?: string; latestRelated?: boolean }): Promise<WorkflowQueueItem[]> {
  return withClient(async (client) => {
    const identityFamilies = options?.latestRelated ? await projectIdentitySchemaAvailable(client) : false;
    const projectRootUri = options?.projectRootUri?.trim() || null;
    const result = await client.query<WorkflowQueueItem>(
      `${options?.latestRelated ? queuePresentationSql(identityFamilies, "$2") : ""} select
         wr.id::text as "runId",
         wr.run_set_id::text as "runSetId",
         ${options?.latestRelated ? relatedQueueCountsSql : 'null::int as "relatedRunCount", null::int as "relatedOpenRunCount"'},
         (select jsonb_build_object(
            'notificationId',notice.id::text,
            'state',case when notice.acknowledged_at is not null then 'acknowledged'
              when notice.transport_accepted_at is not null or (notice.status='delivered' and notice.delivered_at is not null) then 'transport_accepted'
              when notice.status='delivery_uncertain' then 'delivery_uncertain'
              when notice.status='failed' then 'delivery_failed' else 'queued' end,
            'createdAt',notice.created_at::text,
            'transportAcceptedAt',notice.transport_accepted_at::text,
            'acknowledgedAt',notice.acknowledged_at::text)
          from run_notifications notice
          where notice.run_id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"})
            and notice.event_key like 'queue-partner-code-fix:%'
          order by notice.created_at desc,notice.id desc limit 1) as "codeFixCallback",
         (select count(*)::int from workflow_runs history where history.run_set_id = wr.run_set_id) as "runSetSize",
         wr.workflow_id as "workflowId",
         wr.status as "runStatus",
         wr.task,
         wr.construction_rationale->'presentation'->>'title' as "displayTitle",
         wr.construction_rationale->'presentation'->>'description' as "displayDescription",
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         ${identityFamilies ? "coalesce((select identity_id::text from project_identity_locations where project_id=p.id),p.id::text)" : "p.id::text"} as "projectIdentityId",
         ${identityFamilies ? "coalesce((select generation from project_identity_locations where project_id=p.id),0)" : "0"}::int as "projectIdentityGeneration",
         (select value->>'revision' from jsonb_each(coalesce(wr.executor_snapshot,'{}'::jsonb)) order by key limit 1) as "sourceRevision",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt",
         greatest(
           wr.updated_at,
           coalesce((select max(activity_run.updated_at) from workflow_runs activity_run where activity_run.id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"})),wr.updated_at),
           coalesce((select max(receipt.created_at) from action_receipts receipt where receipt.run_id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"})),wr.updated_at),
           coalesce((select max(approval.updated_at) from action_approvals approval where approval.run_id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"})),wr.updated_at),
           coalesce((select max(notice.created_at) from run_notifications notice where notice.run_id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"}) and notice.event_key like 'queue-partner-code-fix:%'),wr.updated_at),
           -- Scheduling eligibility (including an infinite approval/preparation hold) is not activity.
           coalesce((select max(greatest(
             case when isfinite(task_activity.started_at) then task_activity.started_at end,
             case when isfinite(task_activity.finished_at) then task_activity.finished_at end))
             from workflow_tasks task_activity where task_activity.run_id=any(${options?.latestRelated ? "qf.members" : "array[wr.id]"})),wr.updated_at)
         )::text as "latestActivityAt",
         (select jsonb_build_object('taskId',held.id::text,'stageId',held.stage_id,
            'since',checkpoint.content#>>'{approvalWait,since}',
            'approvals',(select jsonb_agg(jsonb_build_object('id',approval.id::text,'status',approval.status,
              'actionType',approval.action_type,'target',approval.target,'rationale',approval.rationale,'payload',approval.payload) order by approval.created_at)
              from action_approvals approval where approval.run_id=wr.id and approval.task_id=held.id
                and (checkpoint.content#>'{approvalWait,approvalIds}') ? approval.id::text))
          from workflow_tasks held join artifacts checkpoint on checkpoint.run_id=held.run_id and checkpoint.task_id=held.id
            and checkpoint.kind='stage_continuation' and checkpoint.uri='db://workflow_tasks/'||held.id::text||'/continuation'
          where held.run_id=wr.id and held.status='queued' and held.available_at='infinity'::timestamptz
            and checkpoint.content#>>'{approvalWait,state}'='waiting'
          order by held.id limit 1) as "approvalWait",
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
         (min(wt.available_at) filter (where wt.status = 'queued' and isfinite(wt.available_at)))::text as "oldestQueuedAt",
         (min(coalesce(wt.started_at, wt.available_at)) filter (where wt.status in ('leased', 'running')))::text as "oldestRunningAt"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       join workflow_tasks wt on wt.run_id = wr.id
       ${options?.latestRelated ? "join queue_families qf on qf.latest_id=wr.id and qf.open_count>0" : ""}
       where ($2::text is null or ${options?.latestRelated ? "exists (select 1 from workflow_runs family_member join projects family_project on family_project.id=family_member.project_id where family_member.id=any(qf.members) and family_project.root_uri=$2)" : "p.root_uri = $2"})
         -- Evaluation failures are comparison evidence, not actionable workflow
         -- failures. They remain visible on the Evaluations surface.
         and not (wr.status in ('failed', 'blocked') and wr.evaluation_metadata ? 'suiteId')
         and not exists (
           select 1
           from action_receipts dismissed
           where dismissed.run_id = wr.id
             and dismissed.action_type in ('failed_run_dismissed','failed_run_superseded')
             and not exists (
               select 1
               from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         )
         and (${options?.latestRelated ? "true or " : ""}wr.status in ('queued', 'leased', 'running', 'failed', 'blocked')
          or exists (
            select 1 from workflow_tasks active
            where active.run_id = wr.id
              and active.status in ('queued', 'leased', 'running', 'failed', 'blocked')
          ))
         and ${options?.latestRelated ? "true" : queueRunSetRepresentativeSql}
       group by wr.id, p.id ${options?.latestRelated ? ", qf.related_count, qf.open_count, qf.version_set_id, qf.attempts, qf.members" : ""}
       order by
         "latestActivityAt" desc,
         wr.id desc
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
    const familyRunIds=[...new Set(result.rows.flatMap(row=>[row.runId,...(row.familyAttempts??[]).map(attempt=>attempt.id)]))];
    const failureEvidence=familyRunIds.length?(await client.query<{runId:string;commandLine:string|null;stderr:string|null;createdAt:string}>(`select distinct on (a.run_id)
      a.run_id::text "runId",a.content->>'commandLine' "commandLine",a.content->>'stderr' stderr,a.created_at::text "createdAt"
      from artifacts a where a.run_id=any($1::uuid[]) and a.kind='command_output'
       and coalesce((a.content->>'exitCode')::int,0)<>0
      order by a.run_id,a.created_at desc,a.id desc`,[familyRunIds])).rows:[];
    const evidenceByRun=new Map(failureEvidence.map(evidence=>[evidence.runId,evidence]));
    return result.rows.map((row) => {
      const recovery = recoveryByOrigin.get(row.runId);
      const failedIds=[row.runId,...(row.familyAttempts??[]).filter(attempt=>attempt.status==='failed').map(attempt=>attempt.id)];
      const evidence=failedIds.map(id=>evidenceByRun.get(id)).filter((item):item is NonNullable<typeof item>=>Boolean(item)).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
      const failureOwnership=(row.failedReason||evidence)?classifyFailureOwnership({runId:evidence?.runId??row.runId,failureReason:row.failedReason,commandLine:evidence?.commandLine,stderr:evidence?.stderr}):null;
      const enriched={...row,failureOwnership};
      return recovery ? {
        ...enriched,
        recoveryRunId: recovery.id,
        recoveryRunStatus: recovery.status,
        recoveryStartedAt: recovery.startedAt,
        recoveryRelation: recovery.relation
      } : enriched;
    });
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
          await appendActionReceipt(client, {
        runId: candidate.runId,
        agentId: "workflow-orchestrator",
        actionType: "stale_run_reconciled",
        target: candidate.runId,
        summary: `Reconciled stale ${candidate.runStatus} run to ${candidate.recommendedStatus} because all child tasks were terminal.`,
        metadata: JSON.stringify({
                actor: input.actor ?? "system",
                previousStatus: candidate.runStatus,
                newStatus: candidate.recommendedStatus,
                totalTasks: candidate.totalTasks,
                completedTasks: candidate.completedTasks,
                cancelledTasks: candidate.cancelledTasks
              })
      });
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
  // A replay reserves recovery work; only independently verified completion can supersede its source.
  return replay?.queuedTasks ?? 0;
}

export async function resumeWorkflowRunFromCheckpoint(input: {
  runId: string;
  actor: string;
  reason: string;
  includeFailed?: boolean;
  revalidatedSubjectHash?: string;
}): Promise<{
  requeuedTasks: number;
  completedTasks: number;
  totalTasks: number;
  replacementRunId?: string;
}> {
  await withClient(client=>assertGenericRunRecoveryAllowed(client,input.runId,'resume'));
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
        preserveCompletedCheckpoints: true,
        revalidatedSubjectHash: input.revalidatedSubjectHash
      });
      // Keep the terminal source visible until equivalent recovery work is independently accepted.
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

      await assertGenericRunRecoveryAllowed(client,input.runId,'resume');

      const resumableStatuses = ["queued", "running"];
      const result = await client.query<{ id: string; agentId: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
             worker_id = null,
             lease_expires_at = null,
             available_at = now()
         where run_id = $1::uuid
           and status = any($2::text[])
         returning id::text, agent_id as "agentId"`,
        [input.runId, resumableStatuses]
      );
      for (const task of result.rows) await appendActionReceipt(client, {
        runId: input.runId, agentId: task.agentId, actionType: "stage_requeued", target: task.id,
        summary: "Stage requeued by checkpoint recovery.", metadata: JSON.stringify({ actor: input.actor })
      });
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
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: "workflow-orchestrator",
        actionType: "checkpoint_resume_requested",
        target: input.runId,
        summary: input.reason,
        metadata: JSON.stringify({
            actor: input.actor,
            reason: input.reason,
            includeFailed: input.includeFailed === true,
            requeuedTasks: result.rowCount ?? 0,
            completedTasks: counts.rows[0]?.completed ?? 0,
            totalTasks: counts.rows[0]?.total ?? 0
          })
      });
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
      const runResult = await client.query<{ id: string; status: string }>(
        `select wr.id::text, wr.status
         from workflow_runs wr
         where wr.id = $1 and wr.status in ('failed', 'blocked', 'cancelled')
         for update`,
        [input.runId]
      );
      if (!runResult.rows[0]) {
        await client.query("rollback");
        return false;
      }
      const priorStatus = runResult.rows[0].status;
      await assertGenericRunRecoveryAllowed(client,input.runId,'dismiss');
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: "workflow-orchestrator",
        actionType: "failed_run_dismissed",
        target: input.runId,
        summary: input.reason,
        metadata: JSON.stringify({ actor: input.actor, reason: input.reason, bulk: false, priorStatus })
      });
      // Move to cancelled so every view consistently hides the dismissed run.
      // The receipt above preserves the audit trail and the prior status.
      await client.query(
        `update workflow_runs set status = 'cancelled', updated_at = now() where id = $1::uuid`,
        [input.runId]
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
    await client.query("begin");
    try {
      await assertGenericRunRecoveryAllowed(client,input.runId,'reinstate');
      const dismissed = await client.query<{ metadata: { priorStatus?: string } }>(
        `select ar.metadata
         from action_receipts ar
         where ar.run_id = $1::uuid
           and ar.action_type in ('failed_run_dismissed','failed_run_superseded')
         order by ar.created_at desc
         limit 1
         for update`,
        [input.runId]
      );
      if (!dismissed.rows[0]) {
        await client.query("rollback");
        return false;
      }
      const priorStatus = dismissed.rows[0].metadata?.priorStatus;
      const restoreTo = priorStatus === "failed" || priorStatus === "blocked" ? priorStatus : "blocked";
      const result = await client.query<{ id: string }>(
        `select wr.id::text
         from workflow_runs wr
         where wr.id = $1::uuid
           and wr.status in ('failed', 'blocked', 'cancelled')
         for update`,
        [input.runId]
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return false;
      }
      await appendActionReceipt(client, { runId: input.runId, agentId: "workflow-orchestrator",
        actionType: "failed_run_reinstated", target: input.runId, summary: input.reason,
        metadata: JSON.stringify({ actor: input.actor, reason: input.reason, restoredStatus: restoreTo }) });
      await client.query(
        `update workflow_runs set status = $2, updated_at = now() where id = $1::uuid`,
        [input.runId, restoreTo]
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
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
      for (const runId of runIds) {
        await assertGenericRunRecoveryAllowed(client,runId,'dismiss');
        await appendActionReceipt(client, { runId, agentId: "workflow-orchestrator",
          actionType: "failed_run_dismissed", target: runId, summary: input.reason,
          metadata: JSON.stringify({ actor: input.actor, reason: input.reason, bulk: true, projectRootUri: input.projectRootUri ?? null }) });
      }
      await client.query(
        `update workflow_runs set status = 'cancelled', updated_at = now() where id = any($1::uuid[])`,
        [runIds]
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
  identityId?: string;
  identityRootUri?: string;
  locationKind?: string;
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
    if (!await projectIdentitySchemaAvailable(client)) return result.rows;
    const bindings = await client.query<{id:string;identityId:string;identityRootUri:string;locationKind:string}>(
      `select l.project_id::text as id,l.identity_id::text as "identityId",p.root_uri as "identityRootUri",l.kind as "locationKind"
       from project_identity_locations l join projects p on p.id=l.identity_id where l.project_id=any($1::uuid[])`,[result.rows.map(r => r.id)]);
    const byId = new Map(bindings.rows.map(r => [r.id,r]));
    return result.rows.map(r => ({...r,...byId.get(r.id)}));
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
  prepareOnly?: boolean;
  acceptanceRequirements?: Pick<StructuredAcceptanceContract, "subjectHash" | "sourcePaths" | "deliverables">;
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
  requester?: string;
  requesterChannel?: string;
  /** Queue Partner-only transactional enrollment. The run, measurement-only
   * exposure and fenced coordinator attachment commit or roll back together. */
  queuePartnerEnrollment?: import('./queue-coordinator.js').QueuePartnerChildEnrollment;
}
export async function createWorkflowRun(input: CreateRunInput): Promise<{ projectId: string; runId: string; tasks: number; deduplicated?: boolean }> {
  const wrapperReason = automaticRecoveryWrapperReason(input);
  if (wrapperReason) throw new Error(wrapperReason);
  const registrationLocation=await projectRegistrationRoot(input.projectRootUri);
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const installationRequired = await installationRequiresRunPipeline(client);
      const required = installationRequired || (input.policySnapshot as ProjectConfig)?.execution?.pipeline?.required === true;
      if (required) {
        const {loadWorkflows}=await import('../../agent-registry/src/loaders.js');
        const {findAgentWorkflowRoot}=await import('../../runtime-root/src/index.js');
        const repair=(await loadWorkflows(findAgentWorkflowRoot(import.meta.url))).find(workflow=>workflow.id==='repair-blocked-item');
        if(!repair)throw Error('The required prepared repair workflow is missing from this runtime');
        const workflow=preparedWorkflow(input.workflow,true,repair);
        input={...input,workflow,workflowHash:workflowDefinitionHash(workflow)};
      }
      const executionPipeline=pipelineContract(input.policySnapshot as ProjectConfig,input.workflow,installationRequired,input.prepareOnly===true);
      const hints=input.acceptanceRequirements?.sourcePaths??input.evaluationMetadata?.recoveryWritePaths??(input.evaluationMetadata?.taskGrant as {sourceWritePaths?:unknown}|undefined)?.sourceWritePaths;
      if(Array.isArray(hints)&&hints.length<=256&&hints.every(value=>typeof value==='string'&&value.length>0&&value.length<=512&&!value.startsWith('/')&&!/[\\*?\[\]{}\x00-\x1f]/u.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..')))executionPipeline.sourcePaths=[...new Set(hints)] as string[];
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
      await registerProjectIdentityScope(client, projectId, registrationLocation.commonRoot);
      const workflowVersion = String(input.workflowVersion ?? "1");
      const workflowHash = input.workflowHash ?? workflowDefinitionHash(input.workflow);
      if (input.evaluationMetadata?.acceptanceContract) throw new Error("Use acceptanceRequirements for atomic runtime enrollment.");
      const evaluationMetadataJson = JSON.stringify({ ...(input.evaluationMetadata ?? {}), executionPipeline,
        ...(executionPipeline.required&&executionPipeline.sourceChanges?{partnerRepairPipeline:{version:1,requiresVerifierSlot:true}}:{}),
        ...(input.acceptanceRequirements ? { acceptanceRequirements: input.acceptanceRequirements } : {}) });
      const presentation = buildRunPresentation({ task: input.task, workflowId: input.workflow.id, projectName: input.projectName });
      const constructionRationale = input.constructionRationale && typeof input.constructionRationale === "object" && !Array.isArray(input.constructionRationale)
        ? input.constructionRationale as Record<string, unknown>
        : {};
      const constructionRationaleJson = JSON.stringify({ ...constructionRationale, presentation });
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
        if(input.queuePartnerEnrollment){const {enrollQueuePartnerChildOnClient}=await import('./queue-coordinator.js');await enrollQueuePartnerChildOnClient(client,duplicate.id,input.queuePartnerEnrollment);}
        await client.query("commit");
        return { projectId, runId: duplicate.id, tasks: duplicate.tasks, deduplicated: true };
      }
      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot,
           workflow_definition_version, workflow_definition_hash, construction_rationale, compiled_brief_uri, run_set_id,
           requester, requester_channel
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ${inheritedRunSetSql}, $16, $17)
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
          null,
          input.requester ?? null,
          input.requesterChannel ?? "dashboard"
        ]
      );
      const runId = runResult.rows[0].id;
      const compiledBriefUri = `db://workflow_runs/${runId}/compiled-brief`;
      await appendActionReceipt(client, { runId, agentId: "workflow-orchestrator",
        actionType: "workflow_created", target: runId, summary: "Workflow created and queued.", metadata: "{}" });

      if (input.compiledBrief) {
        await appendPlanContextInfluence(client, { runId, text: input.compiledBrief, influence: input.compiledBriefMetadata?.contextInfluence, artifactUri: compiledBriefUri });
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
          `insert into workflow_tasks (run_id, stage_id, agent_id, status, idempotency_key,available_at)
           values ($1, $2, $3, 'queued', $4,case when $5::boolean then 'infinity'::timestamptz else now() end)
           returning id::text`,
          [
            runId,
            stage.id,
            stage.agent,
            `${runId}:${stage.id}:${stage.agent}`,
            input.prepareOnly===true
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

      if (input.acceptanceRequirements) {
        const contract: StructuredAcceptanceContract = { ...input.acceptanceRequirements, version: 1,
          contractId: `acceptance:${runId}`, projectId, originRunId: runId, taskHash: acceptanceDigest(input.task) };
        await enrollAcceptanceContract(client, runId, contract);
        const uri = `db://workflow_runs/${runId}/acceptance_contract/enrollment`;
        await client.query(`insert into artifacts(run_id,kind,uri,content) values ($1,'acceptance_contract',$2,$3::jsonb)`,
          [runId, uri, JSON.stringify({ contract })]);
        await appendActionReceipt(client, {
        runId: runId,
        agentId: "workflow-orchestrator",
        actionType: "acceptance_enrolled",
        target: uri,
        summary: "Acceptance requirements enrolled atomically before workers can claim the run.",
        metadata: JSON.stringify({ contractId: contract.contractId, artifactUri: uri })
      });
      }

      if(input.queuePartnerEnrollment){const {enrollQueuePartnerChildOnClient}=await import('./queue-coordinator.js');await enrollQueuePartnerChildOnClient(client,runId,input.queuePartnerEnrollment);}

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
  acceptanceRequirements?: Pick<StructuredAcceptanceContract, "subjectHash" | "sourcePaths" | "deliverables">;
  revalidatedSubjectHash?: string;
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
        startedAt: string;
        status: string;
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
        requester: string | null;
        requesterChannel: string | null;
      }>(
        `select
           p.id::text as "projectId",
           p.name as "projectName",
           p.root_uri as "projectRootUri",
           wr.started_at::text as "startedAt",
           wr.status,
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
           wr.requester as "requester",
           wr.requester_channel as "requesterChannel",
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
      // Check before replacement reuse, conflict reconciliation, writes or cancellation.
      await assertGenericRunRecoveryAllowed(client,input.sourceRunId,'replay');
      if (automaticRepeatForbidden(sourceRun)) throw new Error(noAutomaticRepeatReason);
      if (sourceRun.replacementRunId) {
        if (input.revalidatedSubjectHash) throw new Error("Source revalidation cannot reuse an existing replacement.");
        if (input.acceptanceRequirements) throw new Error("Explicit acceptance enrollment cannot reuse an existing replacement; inspect its requirements and replay that execution if needed.");
        const existing = await client.query<{
          tasks: number;
          completedTasks: number;
          skippedTasks: number;
          queuedTasks: number;
        }>(
          `select count(*)::int as tasks,
                  count(*) filter (where status = 'completed')::int as "completedTasks",
                  0::int as "skippedTasks",
                  count(*) filter (where status = 'queued')::int as "queuedTasks"
             from workflow_tasks
            where run_id = $1::uuid`,
          [sourceRun.replacementRunId]
        );
        const counts = existing.rows[0] ?? { tasks: 0, completedTasks: 0, skippedTasks: 0, queuedTasks: 0 };
        await client.query("commit");
        return {
          projectId: sourceRun.projectId,
          runId: sourceRun.replacementRunId,
          tasks: counts.tasks,
          completedTasks: counts.completedTasks,
          skippedTasks: counts.skippedTasks,
          queuedTasks: counts.queuedTasks
        };
      }
      const logicalProjectId = String((sourceRun.projectConfig as { project?: { id?: unknown } }).project?.id ?? sourceRun.projectRootUri).trim();
      const replayConflict = await findReplayConflict(client, {
        sourceRunId: input.sourceRunId,
        sourceStartedAt: sourceRun.startedAt,
        logicalProjectId,
        workflowId: sourceRun.workflowId,
        task: sourceRun.task
      });
      if (replayConflict) {
        if (input.revalidatedSubjectHash) throw new Error("Source revalidation conflicts with an existing logical work owner.");
        if (input.acceptanceRequirements) throw new Error("Explicit acceptance enrollment conflicts with an existing logical work owner.");
        await client.query(
          `update workflow_runs
              set replacement_run_id = $2::uuid,
                  updated_at = now()
            where id = $1::uuid and replacement_run_id is null`,
          [input.sourceRunId, replayConflict.id]
        );
        await appendActionReceipt(client, {
        runId: input.sourceRunId,
        agentId: "workflow-orchestrator",
        actionType: "workflow_replay_suppressed",
        target: replayConflict.id,
        summary: `Replay suppressed because equivalent ${replayConflict.status} run ${replayConflict.id} already owns the logical project work.`,
        metadata: JSON.stringify({ actor: input.actor, logicalProjectId, workflowId: sourceRun.workflowId, conflictingRunId: replayConflict.id, conflictingRunStatus: replayConflict.status })
      });
        await client.query("commit");
        return {
          projectId: sourceRun.projectId,
          runId: replayConflict.id,
          tasks: replayConflict.tasks,
          completedTasks: replayConflict.completedTasks,
          skippedTasks: 0,
          queuedTasks: Math.max(0, replayConflict.tasks - replayConflict.completedTasks)
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
      if (Object.prototype.hasOwnProperty.call(input.evaluationMetadataPatch ?? {}, "acceptanceContract")) {
        throw new Error("Replay acceptance requirements are runtime-owned and cannot be patched.");
      }
      const sourceAcceptance = sourceRun.evaluationMetadata.acceptanceContract as StructuredAcceptanceContract | undefined;
      if (sourceAcceptance && input.acceptanceRequirements) {
        throw new Error("Replay source already has frozen acceptance requirements; replacement is forbidden.");
      }
      const replayAcceptance = sourceAcceptance ?? input.acceptanceRequirements;
      const structuredRecovery = Boolean(sourceAcceptance && input.preserveCompletedCheckpoints
        && ["failed", "blocked", "cancelled"].includes(sourceRun.status));
      if (structuredRecovery) {
        if (input.skipStageIds?.length) throw new Error("Structured recovery cannot skip stages.");
        const chain = await verifyRunReceiptChain(input.sourceRunId);
        if (!chain.valid) throw new Error(`Recovery source receipt chain is invalid: ${chain.reason}`);
        let unfinished = false;
        for (const stage of workflow.stages) {
          const task = sourceTaskByStage.get(stage.id);
          if (task?.status !== "completed") { unfinished = true; continue; }
          if (unfinished) throw new Error("Structured recovery requires a contiguous completed prefix; refusing to discard checkpoints.");
          await validateRecoveryCheckpoint(client, { runId: input.sourceRunId, taskId: task.id,
            stageId: stage.id, artifact: task.artifactContent }, verifyRunReceiptChain);
        }
        if (!unfinished) throw new Error("Structured recovery requires an unfinished stage for fresh acceptance validation.");
      }
      if (input.revalidatedSubjectHash !== undefined && (!sourceAcceptance?.sourcePaths?.length
        || !/^[a-f0-9]{64}$/u.test(input.revalidatedSubjectHash))) {
        throw new Error("Source revalidation requires a frozen source scope and a SHA-256 subject hash.");
      }
      if (sourceAcceptance && (sourceAcceptance.projectId !== projectId
        || sourceAcceptance.originRunId !== input.sourceRunId
        || sourceAcceptance.taskHash !== acceptanceDigest(sourceRun.task))) {
        throw new Error("Replay source acceptance identity requires explicit revalidation.");
      }
      const replayMetadata: Record<string, unknown> = {
        ...sourceRun.evaluationMetadata,
        ...input.evaluationMetadataPatch,
        replayOfRunId: input.sourceRunId,
        replayedBy: input.actor,
        replayReason: input.reason,
        checkpointResume: input.preserveCompletedCheckpoints === true,
        skippedStageIds: [...new Set(input.skipStageIds ?? [])]
      };
      // Re-enroll unchanged requirements atomically for the new execution. Source
      // receipts remain immutable history, never acceptance for the replacement.
      delete replayMetadata.acceptanceContract;
      delete replayMetadata.recoveryEvidence;
      if (structuredRecovery) replayMetadata.recoveryEvidence = {
        sourceRunId: input.sourceRunId, mode: "historical-checkpoints-fresh-acceptance",
        cleanValidationRequired: true, inheritedReceiptsAccepted: false
      };
      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot,
           workflow_definition_version, workflow_definition_hash, construction_rationale, compiled_brief_uri, run_set_id,
           requester, requester_channel
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, null, ${inheritedRunSetSql}, $15, $16)
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
          JSON.stringify(sourceRun.constructionRationale),
          sourceRun.requester ?? null,
          sourceRun.requesterChannel ?? "dashboard"
        ]
      );
      const runId = runResult.rows[0].id;
      if (replayAcceptance) {
        await enrollAcceptanceContract(client, runId, {
          ...replayAcceptance,
          subjectHash: input.revalidatedSubjectHash ?? replayAcceptance.subjectHash,
          version: 1,
          projectId,
          taskHash: acceptanceDigest(sourceRun.task),
          contractId: `replay:${runId}`,
          originRunId: runId,
          deliverables: sourceAcceptance ? sourceAcceptance.deliverables.map((item) => ({
            ...item, status: "pending", receipts: {}, gaps: []
          })) : replayAcceptance.deliverables
        });
        await appendActionReceipt(client, {
        runId: runId,
        agentId: "workflow-orchestrator",
        actionType: "acceptance_replay_enrolled",
        target: input.sourceRunId,
        summary: "Acceptance requirements enrolled atomically for replay; fresh run-owned evidence required.",
        metadata: JSON.stringify({ sourceRunId: input.sourceRunId, requirementsDigest: acceptanceDigest(replayAcceptance), legacyEnrollment: !sourceAcceptance, checkpointReuse: structuredRecovery,
          inheritedReceiptsAccepted: false, cleanValidationRequired: structuredRecovery,
          previousSubjectHash: replayAcceptance.subjectHash, subjectHash: input.revalidatedSubjectHash ?? replayAcceptance.subjectHash,
          sourceRevalidated: input.revalidatedSubjectHash !== undefined })
      });
      }
      const compiledBriefUri = `db://workflow_runs/${runId}/compiled-brief`;
      if (sourceRun.compiledBrief) {
        await appendPlanContextInfluence(client, { runId, text: sourceRun.compiledBrief, influence: sourceRun.compiledBriefMetadata?.contextInfluence, artifactUri: compiledBriefUri, replaySourceRunId: input.sourceRunId });
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
      let checkpointChainInvalidated = Boolean(replayAcceptance) && !structuredRecovery;
      const skippedStageIds = new Set(input.skipStageIds ?? []);
      for (const stage of workflow.stages) {
        const sourceTask = sourceTaskByStage.get(stage.id);
        // Executing an approved prerequisite does not consume its result or
        // complete the stage. Blocked stages must run again before promotion.
        const checkpointCandidate = sourceTask?.status === "completed";
        const checkpointArtifact = sourceTask?.artifactContent ?? null;
        const checkpointGate = acceptanceGate(stage.id);
        const checkpointAcceptance = checkpointArtifact && checkpointGate
          ? await storedAcceptanceDecision(client, input.sourceRunId, checkpointGate, checkpointArtifact) : null;
        const checkpointHasBuildEvidence = checkpointArtifact !== null && !checkpointAcceptance?.reason && (checkpointAcceptance?.mode === "structured" || completedStageProvidesPinnedBuildEvidence({
          workflowTask: sourceRun.task,
          stageId: stage.id,
          agentId: stage.agent,
          summary: typeof checkpointArtifact.summary === "string" ? checkpointArtifact.summary : "",
          artifact: checkpointArtifact
        }));
        if (!structuredRecovery && checkpointCandidate && !checkpointHasBuildEvidence) {
          checkpointChainInvalidated = true;
        }
        const preserveCheckpoint = !checkpointChainInvalidated
          && sourceTask !== undefined
          && (structuredRecovery ? sourceTask?.status === "completed" : checkpointCandidate)
          && checkpointArtifact !== null;
        const skipStage = !replayAcceptance && skippedStageIds.has(stage.id) && !preserveCheckpoint;
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
                  checkpointPreservedFromTaskId: sourceTask.id,
                  ...(structuredRecovery ? { checkpointEvidence: {
                    mode: "historical-only", sourceArtifactHash: acceptanceDigest(sourceTask.artifactContent),
                    sourceSubjectHash: sourceAcceptance!.subjectHash, freshAcceptanceRequired: true
                  } } : {})
                })
              ]
            );
            await client.query(`update workflow_tasks set output_uri = $2 where id = $1::uuid`, [taskId, outputUri]);
          }
          await appendActionReceipt(client, {
        runId: runId,
        agentId: stage.agent,
        actionType: "stage_checkpoint_preserved",
        target: taskId,
        summary: `Preserved completed checkpoint for stage ${stage.id} from immutable run ${input.sourceRunId}.`,
        metadata: JSON.stringify({ sourceRunId: input.sourceRunId, sourceTaskId: sourceTask.id, stageId: stage.id, actionResolvedCheckpoint: false })
      });
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
          await appendActionReceipt(client, {
        runId: runId,
        agentId: stage.agent,
        actionType: "stage_blocker_ignored",
        target: taskId,
        summary: `Explicitly skipped blocked stage ${stage.id}; downstream execution may continue.`,
        metadata: JSON.stringify({ sourceRunId: input.sourceRunId, sourceTaskId: sourceTask?.id ?? null, stageId: stage.id, actor: input.actor, reason: input.reason })
      });
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
      await appendActionReceipt(client, {
        runId: runId,
        agentId: "workflow-orchestrator",
        actionType: "workflow_replayed",
        target: input.sourceRunId,
        summary: input.reason,
        metadata: JSON.stringify({
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
      });

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

      await enqueueRunNotification(client, {
        runId,
        kind: "recovered",
        eventKey: `replay:${input.sourceRunId}:${runId}`,
        title: "Run resumed from checkpoint",
        body: `Resumed from run ${input.sourceRunId}. ${input.reason}`
      });
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
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: "workflow-orchestrator",
        actionType: "run_autonomy_changed",
        target: input.autonomy,
        summary: `Run approval level changed to ${input.autonomy} before worker claim.`,
        metadata: JSON.stringify({ actor: input.actor, reason: input.reason, policySnapshotHash: input.policySnapshotHash })
      });
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
  executedPolicyAdditions?: import('./approval-waits.js').ExecutedPolicyAddition[];
  projectId?: string;
  executionPipeline?: RunPipelineContract;
  executionIntent?: {owner:string;fencingToken:string};
  executionWritePaths?: string[];
  checkpointAfter?: boolean;
  runtimeOperation?: 'integrate-source';
  acceptanceContract?: StructuredAcceptanceContract;
  remainingStageIds?: string[];
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

export async function claimNextWorkflowTask(input?: { workerId?: string; leaseSeconds?: number; projectRootUri?: string; runId?: string; providerIds?: string[]; defaultProviderId?: string; workerPlatform?: NodeJS.Platform; excludedProjectRootUris?: string[]; perProjectConcurrency?: number }): Promise<ClaimedWorkflowTask | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select set_config('agentflow.execution_pipeline','1',true)");
      const workerId = input?.workerId?.trim() || `worker-${process.pid}`;
      const leaseSeconds = Math.max(30, Math.min(3600, input?.leaseSeconds ?? 120));
      const projectRootUri = input?.projectRootUri?.trim() || null;
      // A supplied empty/invalid ID must never widen a targeted claim.
      const runId = input?.runId === undefined ? null : input.runId.trim();
      if (runId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(runId)) {
        throw new Error("Exact worker runId must be a UUID");
      }
      // undefined preserves the legacy unrestricted caller contract. An
      // explicitly empty capability set must fail closed so a quarantined
      // worker cannot claim work for a provider it cannot execute.
      const providerIds = input?.providerIds === undefined ? null : [...new Set(input.providerIds)];
      const defaultProviderId = input?.defaultProviderId?.trim() || null;
      const workerPlatform = input?.workerPlatform ?? null;
      const excludedProjectRootUris = input?.excludedProjectRootUris?.length ? [...new Set(input.excludedProjectRootUris)] : null;
      const perProjectConcurrency = Math.max(1, Math.min(16, input?.perProjectConcurrency ?? 2));
      const coordinatorFence = await coordinatorWorkerFencePredicate(client, "$1");
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
             and coalesce(wr.evaluation_metadata#>>'{executionPipeline,preparedOnly}','false')<>'true'
             and (not coalesce((select required from run_pipeline_settings where id=1),false)
               or wr.evaluation_metadata#>>'{executionPipeline,required}'='true')
             and wr.status in ('queued', 'leased', 'running')
             and wt.available_at <= now()
             and ($3::text is null or p.root_uri = $3)
             and ($9::uuid is null or wr.id = $9::uuid)
             and (not (coalesce(wr.evaluation_metadata, '{}'::jsonb) ? 'queueCoordinatorClaimId') or $9::uuid=wr.id)
             and ${coordinatorFence}
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
             lease_generation = wt.lease_generation + 1,
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
           p.id::text as "projectId",
           wr.evaluation_metadata->'executionPipeline' as "executionPipeline",
           wr.evaluation_metadata->'workIntent' as "executionIntent",
           wr.evaluation_metadata#>'{taskGrant,sourceWritePaths}' as "executionWritePaths",
           coalesce((select (stage->>'checkpoint_after')::boolean from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot,'{}'::jsonb),wf.definition)->'stages') stage where stage->>'id'=wt.stage_id limit 1),false) as "checkpointAfter",
           (select stage->>'runtime_operation' from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot,'{}'::jsonb),wf.definition)->'stages') stage where stage->>'id'=wt.stage_id limit 1) as "runtimeOperation",
           p.root_uri as "projectRootUri",
           coalesce(nullif(wr.policy_snapshot, '{}'::jsonb), p.config) as "projectConfig",
           coalesce((select jsonb_agg(addition) from (
             select change.content->>'field' as field,change.content->>'proposedRule' as rule
             from action_approvals approval join artifacts change on change.run_id=approval.run_id and change.task_id=approval.task_id
               and change.kind='project_policy_change' and change.content->>'approvalId'=approval.id::text
               and change.content->>'proposedRule'=approval.payload->>'proposedRule'
               and change.content->>'changeKind'=approval.payload->>'changeKind'
             where approval.run_id=wr.id and approval.action_type='project_policy_change'
               and approval.status='executed' and approval.executed_at is not null
               and ((change.content->>'field'='allowed_commands' and approval.payload->>'changeKind'='allowed_command')
                 or (change.content->>'field'='allowed_write_paths' and approval.payload->>'changeKind'='allowed_write_path'))
               and exists(select 1 from action_receipts receipt where receipt.run_id=wr.id and receipt.action_type='project_policy_change'
                 and receipt.metadata=change.content and receipt.receipt_hash is not null)
             order by approval.created_at limit 51
           ) addition),'[]'::jsonb) as "executedPolicyAdditions",
           wr.workflow_id as "workflowId",
           wr.task as "workflowTask",
           wt.stage_id as "stageId",
           array(select other.stage_id from workflow_tasks other
             where other.run_id=wt.run_id and other.id<>wt.id
               and other.status not in ('completed','cancelled') order by other.stage_id) as "remainingStageIds",
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
           wt.lease_generation::text as "fencingToken",
           nullif(wt.executor_snapshot, '{}'::jsonb) as "executorSnapshot",
           coalesce(wr.model_tier_override, (
             select stage->'routing'->>'model_tier'
             from jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') stage
             where stage->>'id' = wt.stage_id limit 1
           ), a.definition->>'model_tier') as "modelTier"`
        ,
        [workerId, leaseSeconds, projectRootUri, providerIds, excludedProjectRootUris, perProjectConcurrency, defaultProviderId, workerPlatform].concat([runId])
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
      await appendActionReceipt(client, {
        runId: result.rows[0].runId, agentId: result.rows[0].agentId,
        actionType: "stage_leased", target: result.rows[0].taskId,
        summary: "Stage leased to a worker.",
        metadata: JSON.stringify({ nextStatus: "leased", leaseEpoch, fencingToken: result.rows[0].fencingToken })
      });

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

function exactGitRevision(projectRootUri: string): string {
  const revision = execFileSync("git", ["-C", projectRootUri, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Remote executor requires an exact 40-character Git revision.");
  return revision;
}

export interface RequesterNotification {
  runId: string;
  kind: "approval_needed" | "blocked" | "failed" | "message";
  title: string;
  body?: string;
  channel?: string;
}

/**
 * Chat-mode: record an outbound notification for the run's requester.
 * Never throws: notification intent must not break the run lifecycle.
 * Delivery happens out-of-band (dashboard, Codex callback, AGENTFLOW_NOTIFY_COMMAND).
 */
export async function notifyRequester(input: RequesterNotification): Promise<string | null> {
  try {
    return await withClient(async (client) => {
      const run = await client.query<{ requester: string | null; requester_channel: string | null }>(
        `select requester, requester_channel from workflow_runs where id = $1`,
        [input.runId]
      );
      const channel = input.channel ?? run.rows[0]?.requester_channel ?? "dashboard";
      const dedupe = await client.query<{ id: string }>(
        `select id from run_notifications
         where run_id = $1 and kind = $2 and title = $3 and status = 'pending'
         limit 1`,
        [input.runId, input.kind, input.title]
      );
      if (dedupe.rows[0]) return dedupe.rows[0].id;
      const inserted = await client.query<{ id: string }>(
        `insert into run_notifications (run_id, channel, kind, title, body)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [input.runId, channel, input.kind, input.title, input.body ?? ""]
      );
      await client.query(`select pg_notify('agentflow_runtime_events', $1)`, [
        JSON.stringify({ type: "run_notification", notificationId: inserted.rows[0].id, runId: input.runId })
      ]);
      return inserted.rows[0].id;
    });
  } catch {
    return null;
  }
}

export async function listPendingRunNotifications(limit = 50): Promise<Array<{
  id: string; runId: string; channel: string; kind: string;
  title: string; body: string; createdAt: string; requester: string | null;
}>> {
  return withClient(async (client) => {
    const r = await client.query(
      `select n.id::text as "id", n.run_id::text as "runId", n.channel as "channel",
              n.kind as "kind", n.title as "title", n.body as "body",
              n.created_at::text as "createdAt", wr.requester as "requester"
       from run_notifications n
       join workflow_runs wr on wr.id = n.run_id
       where n.status = 'pending'
       order by n.created_at asc
       limit $1`,
      [limit]
    );
    return r.rows;
  });
}

export async function markRunNotificationDelivered(notificationId: string, ok: boolean): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `update run_notifications
       set status = $2,
           delivered_at = case when $2 = 'delivered' then now() else null end
       where id = $1 and status in ('pending', 'failed')`,
      [notificationId, ok ? "delivered" : "failed"]
    );
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
      await appendActionReceipt(client, {
        runId: input.runId,
        agentId: input.agentId,
        actionType: input.actionType,
        target: input.target,
        summary: input.summary,
        metadata: JSON.stringify(artifactContent),
      });

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

export async function verifyRunReceiptChain(runId: string): Promise<{ valid: boolean; checked: number; brokenAt?: number; reason?: string }> {
  return withClient(client => verifyRunReceiptChainOnClient(client, runId));
}

/** Same verifier on the caller's transaction; no separate visibility window. */
export async function verifyRunReceiptChainOnClient(client: pg.Client, runId: string): Promise<{ valid: boolean; checked: number; brokenAt?: number; reason?: string }> {
  const { verifyReceiptChain } = await import("../../workflow-engine/src/receipt-chain.js");
    const result = await client.query(
      `select agent_id, action_type, target, summary, metadata::text as metadata, created_at, prev_hash, receipt_hash, metadata_serialization_version
       from action_receipts where run_id = $1 order by created_at asc`,
      [runId]
    );
    if (result.rows.some((row) => row.receipt_hash && row.prev_hash == null)) {
      return { valid: false, checked: 0, reason: "hashed receipt is missing prev_hash" };
    }
    const receipts = result.rows.map((row) => ({
      runId,
      agentId: row.agent_id as string,
      actionType: row.action_type as string,
      target: row.target as string,
      summary: row.summary as string,
      metadata: row.metadata as string,
      metadataSerializationVersion: (row.metadata_serialization_version as number | null) ?? undefined,
      createdAt: (row.created_at as Date).toISOString(),
      prevHash: (row.prev_hash as string | null) ?? "GENESIS",
      receiptHash: (row.receipt_hash as string | null) ?? "",
    }));
    // Coverage is a gate: neither legacy prefixes nor intervening unhashed rows
    // may be hidden behind a valid suffix. Existing history remains immutable.
    const unchained = receipts.filter((r) => !r.receiptHash).length;
    if (!receipts.length || unchained) return { valid: false, checked: 0,
      reason: !receipts.length ? "no receipts to verify" : `${unchained} unchained receipts; full coverage unavailable` };
    // Hash links, not timestamp ordering, are authoritative. Reject forks,
    // disconnected segments and cycles, including tied legacy timestamps.
    const successors = new Map<string, typeof receipts>();
    for (const receipt of receipts) {
      const rows = successors.get(receipt.prevHash) ?? [];
      rows.push(receipt);
      successors.set(receipt.prevHash, rows);
    }
    const ordered: typeof receipts = [];
    let tip = "GENESIS";
    const seen = new Set<string>();
    while (successors.has(tip)) {
      const next = successors.get(tip)!;
      if (next.length !== 1 || seen.has(next[0].receiptHash)) return { valid: false, checked: 0, reason: "receipt chain fork or cycle" };
      ordered.push(next[0]);
      seen.add(next[0].receiptHash);
      tip = next[0].receiptHash;
    }
    if (ordered.length !== receipts.length) return { valid: false, checked: 0, reason: "disconnected receipt chain" };
    return verifyReceiptChain(ordered);
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

export async function listWorkflowRuns(limit: number, options?: { runSetId?: string; relatedRunId?: string }): Promise<WorkflowRunStatus[]> {
  return withClient(async (client) => {
    const identityFamilies = options?.relatedRunId ? await projectIdentitySchemaAvailable(client) : false;
    const result = await client.query<WorkflowRunStatus>(
      `select
         wr.id::text,
         wr.status,
         wr.workflow_id as "workflowId",
         wr.task,
         wr.construction_rationale->'presentation'->>'title' as "displayTitle",
         wr.construction_rationale->'presentation'->>'description' as "displayDescription",
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         wr.run_set_id::text as "runSetId",
         (select count(*)::int from workflow_runs history where history.run_set_id = wr.run_set_id) as "runSetSize",
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
             and dismissed.action_type in ('failed_run_dismissed','failed_run_superseded')
             and not exists (
               select 1 from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         ) as dismissed,
         exists (select 1 from action_receipts superseded where superseded.run_id = wr.id and superseded.action_type = 'failed_run_superseded') as superseded
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       where ($2::uuid is null or wr.run_set_id = $2::uuid)
         and ($3::uuid is null or wr.id in (${relatedRunIdsSql("$3::uuid", identityFamilies)}))
       order by wr.started_at desc
       limit $1`,
      [limit, options?.runSetId ?? null, options?.relatedRunId ?? null]
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
         wr.construction_rationale->'presentation'->>'title' as "displayTitle",
         wr.construction_rationale->'presentation'->>'description' as "displayDescription",
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         wr.run_set_id::text as "runSetId",
         (select count(*)::int from workflow_runs history where history.run_set_id = wr.run_set_id) as "runSetSize",
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
             and dismissed.action_type in ('failed_run_dismissed', 'failed_run_superseded')
             and not exists (
               select 1 from action_receipts reinstated
               where reinstated.run_id = wr.id
                 and reinstated.action_type = 'failed_run_reinstated'
                 and reinstated.created_at > dismissed.created_at
             )
         ) as dismissed,
         exists (select 1 from action_receipts superseded where superseded.run_id = wr.id and superseded.action_type = 'failed_run_superseded') as superseded
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
         wr.construction_rationale->'presentation'->>'title' as "displayTitle",
         wr.construction_rationale->'presentation'->>'description' as "displayDescription",
         wr.autonomy,
         wr.policy_profile as "policyProfile",
         wr.policy_snapshot_hash as "policySnapshotHash",
         wr.model_tier_override as "modelTierOverride",
         wr.provider_override as "providerOverride",
         wr.evaluation_metadata as "evaluationMetadata",
         wr.run_set_id::text as "runSetId",
         (select count(*)::int from workflow_runs history where history.run_set_id = wr.run_set_id) as "runSetSize",
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

/** Supervisor uses the same storage-backed evaluator as completion and replay. */
export async function getWorkflowAcceptanceDecision(runId: string, artifact: Record<string, unknown>, gate: import("../../model-providers/src/types.js").AcceptanceGate = "supervision") {
  return withClient((client) => storedAcceptanceDecision(client, runId, gate, artifact));
}

export async function reportWorkflowDeliveryMetrics(runId: string) {
  const metrics = await withClient(async (client) => {
    const runs = await client.query<DeliveryMetricRun>(
      `select id::text,started_at::text as "startedAt",status from workflow_runs
       where id=$1 or run_set_id=(select run_set_id from workflow_runs where id=$1) order by started_at`, [runId]);
    const ids = runs.rows.map((run) => run.id);
    const receipts = await client.query<DeliveryMetricReceipt>(
      `select id::text,run_id::text as "runId",action_type as "actionType",target,created_at::text as "createdAt",metadata
       from action_receipts where run_id=any($1::uuid[]) order by created_at`, [ids]);
    const audits = await client.query<DeliveryAudit>(
      `select run_id::text as "runId",uri,created_at::text as "createdAt",(content->>'accepted')::boolean as accepted
       from artifacts where run_id=any($1::uuid[]) and kind='terminal_acceptance'`, [ids]);
    const approvalRows = await client.query<{ id: string; status: string }>(
      `select id::text,status from action_approvals where run_id=any($1::uuid[]) order by created_at`, [ids]);
    const base = deliveryMetrics(runs.rows, receipts.rows, audits.rows);
    const { approvals: _unknownApprovals, ...unknownReasons } = base.unknownReasons;
    return { ...base, unknownReasons, approvals: { count: approvalRows.rows.length, rows: approvalRows.rows } };
  });
  const uri = await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "delivery_metrics",
    target: "run-set", summary: metrics.verifiedDelivery ? "Receipt-backed verified delivery metrics." : "Delivery remains unverified; unknown measurements retained.",
    artifactKind: "delivery_metrics", artifactContent: metrics });
  return { ...metrics, uri };
}

export async function enrollWorkflowAcceptanceContract(runId: string, contract: StructuredAcceptanceContract): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await enrollAcceptanceContract(client, runId, contract);
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; }
  });
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "acceptance_contract_enrolled",
    target: contract.contractId, summary: "Runtime acceptance requirements frozen before execution.",
    artifactKind: "acceptance_contract", artifactContent: { contract }, idempotencyKey: `acceptance-contract:${contract.contractId}` });
}

export async function preflightWorkflowAcceptance(runId: string, artifact: Record<string, unknown>) {
  const result = await withClient(async (client) => {
    await client.query("begin isolation level repeatable read read only");
    try {
      const preflight = await acceptancePreflight(client, runId, artifact);
      await client.query("commit");
      return preflight;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
  await recordRunAction({ runId, agentId: "workflow-orchestrator", actionType: "acceptance_preflight",
    target: "all-downstream-gates", summary: result.accepted ? "All structured acceptance gates passed." : "Acceptance preflight found unresolved or legacy gates.",
    artifactKind: "acceptance_preflight", artifactContent: result });
  return result;
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

export async function loadStageContext(client: pg.Client, runId: string): Promise<Pick<ClaimedWorkflowTask, "compiledBrief" | "priorReceipts" | "priorStageArtifacts" | "acceptanceContract">> {
  const contractResult = await client.query<{ contract: StructuredAcceptanceContract | null | undefined; metadata?: Record<string,any> }>(
    `select evaluation_metadata->'acceptanceContract' as contract, evaluation_metadata as metadata from workflow_runs where id=$1`, [runId]);
  if(contractResult.rows[0]?.metadata?.existingAssignmentReconciliationUri){
    const {reconciledExecutionContract}=await import('./existing-assignment-reconciliation.js');
    contractResult.rows[0].contract=await reconciledExecutionContract(client,runId,contractResult.rows[0].metadata!);
  }
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

  // Preserved checkpoints may reference commands from an immutable ancestor.
  // Resolve only references in completed stage outputs, within this project.
  const uris = stageArtifactsResult.rows.flatMap((row) => {
    const actions = row.artifact.actionResults;
    return Array.isArray(actions) ? actions.flatMap((action) =>
      action && typeof action.artifactUri === "string" ? [action.artifactUri] : []) : [];
  });
  const evidence = await client.query<{ uri: string; content: Record<string, unknown>; runId: string; taskId: string; stageId: string; createdAt: string }>(
    `select a.uri, a.content, a.run_id::text as "runId", a.task_id::text as "taskId", wt.stage_id as "stageId", a.created_at::text as "createdAt" from artifacts a
     join workflow_tasks wt on wt.id=a.task_id and wt.run_id=a.run_id
     join workflow_runs source on source.id = a.run_id
     join workflow_runs current_run on current_run.id = $1
     where a.kind = 'command_output' and source.project_id = current_run.project_id
       and (a.run_id = $1 or a.uri = any($2::text[]))
     order by a.created_at desc limit 12`, [runId, uris]);
  const replayEvidence = await loadReplayEvidencePacket(client, runId);
  // Provider input is a projection, never a rewrite of prior stage outputs.
  // Supply exact newer governed executions when a later stage reran the same
  // command. The authoritative acceptance resolver still rejects stale refs,
  // newer failures, source drift, changed requirements and cross-run evidence.
  const { refreshAcceptanceEvidence } = await import('../../workflow-engine/src/acceptance-evidence-refresh.js');
  const referenceUris = [...new Set(stageArtifactsResult.rows.flatMap(row => {
    const contract = row.artifact.acceptanceContract as StructuredAcceptanceContract | undefined;
    return contract?.deliverables?.flatMap(d => Object.values(d.receipts ?? {}).flatMap(refs => refs?.map(r => r.artifactUri) ?? [])) ?? [];
  }))];
  let priorStageArtifacts = stageArtifactsResult.rows;
  if(referenceUris.length && referenceUris.length <= 128){
    const observations = await client.query(`select a.id::text artifact_id,a.uri,a.run_id::text run_id,a.task_id::text task_id,
      t.stage_id,r.project_id::text project_id,a.content,a.created_at,
      exists(select 1 from action_receipts ar where ar.run_id=a.run_id and ar.action_type='local_command'
        and ar.target=a.content->>'commandLine' and ar.metadata=a.content and ar.metadata_serialization_version=2) governed
      from artifacts a join workflow_tasks t on t.id=a.task_id and t.run_id=a.run_id join workflow_runs r on r.id=a.run_id
      where a.run_id=$1 and a.kind='command_output' and (a.uri=any($2::text[]) or a.id in (
        select distinct on(content->>'commandLine') id from artifacts where run_id=$1 and kind='command_output'
        order by content->>'commandLine',created_at desc,id desc)) order by a.created_at,a.id limit 129`,[runId,referenceUris]);
    if(observations.rows.length<=128){
      const commands=observations.rows.map(o=>({artifactId:o.artifact_id,projectId:o.project_id,commandLine:String(o.content.commandLine??''),
        reference:{artifactUri:o.uri,runId:o.run_id,taskId:o.task_id,stageId:o.stage_id,kind:'command_output' as const,
          contentHash:acceptanceDigest(o.content),observedAt:new Date(o.created_at).toISOString(),subjectHash:String(o.content.subjectHash??'')},
        sourcePaths:o.content.sourcePaths,sourceBefore:o.content.sourceBefore,sourceAfter:o.content.sourceAfter,
        passed:o.governed===true&&o.content.exitCode===0&&o.content.timedOut===false}));
      priorStageArtifacts=stageArtifactsResult.rows.map(row=>{
        const contract=row.artifact.acceptanceContract as StructuredAcceptanceContract|undefined;
        if(!contract)return row;
        return {...row,artifact:{...row.artifact,acceptanceContract:refreshAcceptanceEvidence(contract,commands).contract}};
      });
    }
  }
  return {
    compiledBrief: briefResult.rows[0]?.text ?? "",
    ...(contractResult.rows[0]?.contract ? { acceptanceContract: contractResult.rows[0].contract } : {}),
    priorReceipts: [...receiptsResult.rows, ...(evidence.rows.length ? [{
      agentId: "workflow-orchestrator", actionType: "command_evidence_packet",
      summary: commandEvidencePacket(evidence.rows.reverse())
    }] : []), ...(replayEvidence ? [{ agentId: "workflow-orchestrator",
      actionType: "replay_evidence_packet", summary: replayEvidence }] : [])],
    priorStageArtifacts
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
         and not exists (
           select 1 from action_receipts rejection
           where rejection.action_type = 'workflow_acceptance_rejected'
             and rejection.run_id::text = mi.metadata->>'repairRunId'
         )
       order by mi.updated_at desc
       limit $2`,
      [input.projectRootUri, input.limit ?? 10]
    );
    return result.rows;
  });
}

export async function consolidateProjectAlias(input: {
  sourceRootUri: string;
  targetRootUri: string;
}): Promise<{ sourceProjectId: string; targetProjectId: string; movedRuns: number; movedFiles: number; movedMemoryItems: number; movedBaselines: number }> {
  if (!input.sourceRootUri.trim() || !input.targetRootUri.trim() || input.sourceRootUri === input.targetRootUri) {
    throw new Error("Project alias consolidation requires distinct source and target roots.");
  }
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const projects = await client.query<{ id: string; rootUri: string }>(
        `select id::text, root_uri as "rootUri" from projects where root_uri = any($1::text[]) for update`,
        [[input.sourceRootUri, input.targetRootUri]]
      );
      const source = projects.rows.find((row) => row.rootUri === input.sourceRootUri);
      const target = projects.rows.find((row) => row.rootUri === input.targetRootUri);
      if (!source || !target) throw new Error("Both source and target project registrations must exist.");

      // Capture pre-consolidation counts for integrity verification.
      // The consolidation is destructive (source project is deleted), so we
      // verify that every row is accounted for after the move.
      const preCounts = await client.query<{ table: string; count: string }>(
        `select 'project_files' as table, count(*) from project_files where project_id = $1::uuid
         union all select 'memory_items', count(*) from memory_items where project_id = $1::uuid
         union all select 'workflow_runs', count(*) from workflow_runs where project_id = $1::uuid
         union all select 'performance_baselines', count(*) from performance_baselines where project_id = $1::uuid`,
        [source.id]
      );
      const preTargetCounts = await client.query<{ table: string; count: string }>(
        `select 'project_files' as table, count(*) from project_files where project_id = $1::uuid
         union all select 'memory_items', count(*) from memory_items where project_id = $1::uuid
         union all select 'workflow_runs', count(*) from workflow_runs where project_id = $1::uuid
         union all select 'performance_baselines', count(*) from performance_baselines where project_id = $1::uuid`,
        [target.id]
      );

      const collisionCounts = await client.query<{ table: string; count: string }>(
        `select 'project_files' as table, count(*)
           from project_files source
           join project_files target on target.project_id = $2::uuid
            and target.source_uri = source.source_uri
          where source.project_id = $1::uuid
         union all
         select 'memory_items', count(*)
           from memory_items source
           join memory_items target on target.project_id = $2::uuid
            and target.source_uri = source.source_uri
            and target.content_hash = source.content_hash
          where source.project_id = $1::uuid`,
        [source.id, target.id]
      );

      // project_files is unique by (project_id, source_uri). Preserve the newer
      // indexed evidence when aliases contain the same path with different
      // content, then remove only the source-side collision before re-parenting.
      await client.query(
        `update project_files target set
           content_hash = source.content_hash,
           token_estimate = source.token_estimate,
           summary = source.summary,
           metadata = source.metadata,
           updated_at = source.updated_at
          from project_files source
         where source.project_id = $1::uuid and target.project_id = $2::uuid
           and source.source_uri = target.source_uri
           and source.updated_at > target.updated_at`,
        [source.id, target.id]
      );
      await client.query(
        `delete from project_files source
          using project_files target
         where source.project_id = $1::uuid and target.project_id = $2::uuid
           and source.source_uri = target.source_uri`,
        [source.id, target.id]
      );
      const files = await client.query(`update project_files set project_id = $2::uuid where project_id = $1::uuid`, [source.id, target.id]);

      await client.query(
        `insert into project_index_state (project_id, head_commit, indexed_files, deleted_files, metadata, updated_at)
         select $2::uuid, head_commit, indexed_files, deleted_files, metadata, updated_at
           from project_index_state where project_id = $1::uuid
         on conflict (project_id) do update set
           indexed_files = greatest(project_index_state.indexed_files, excluded.indexed_files),
           deleted_files = greatest(project_index_state.deleted_files, excluded.deleted_files),
           updated_at = greatest(project_index_state.updated_at, excluded.updated_at)`,
        [source.id, target.id]
      );
      await client.query(`delete from project_index_state where project_id = $1::uuid`, [source.id]);

      await client.query(
        `delete from memory_items source
          using memory_items target
         where source.project_id = $1::uuid and target.project_id = $2::uuid
           and source.source_uri = target.source_uri and source.content_hash = target.content_hash`,
        [source.id, target.id]
      );
      const memory = await client.query(`update memory_items set project_id = $2::uuid where project_id = $1::uuid`, [source.id, target.id]);
      const runs = await client.query(`update workflow_runs set project_id = $2::uuid where project_id = $1::uuid`, [source.id, target.id]);
      const baselines = await client.query(`update performance_baselines set project_id = $2::uuid where project_id = $1::uuid`, [source.id, target.id]);
      // Post-move integrity verification: every source row must be accounted
      // for in the target (moved) or explicitly deduped. If counts don't add
      // up, roll back rather than silently lose data.
      const postCounts = await client.query<{ table: string; count: string }>(
        `select 'project_files' as table, count(*) from project_files where project_id = $1::uuid
         union all select 'memory_items', count(*) from memory_items where project_id = $1::uuid
         union all select 'workflow_runs', count(*) from workflow_runs where project_id = $1::uuid
         union all select 'performance_baselines', count(*) from performance_baselines where project_id = $1::uuid`,
        [target.id]
      );
      const preMap = new Map(preCounts.rows.map((r) => [r.table, Number(r.count)]));
      const preTargetMap = new Map(preTargetCounts.rows.map((r) => [r.table, Number(r.count)]));
      const postMap = new Map(postCounts.rows.map((r) => [r.table, Number(r.count)]));
      const collisionMap = new Map(collisionCounts.rows.map((r) => [r.table, Number(r.count)]));
      for (const table of ["project_files", "memory_items", "workflow_runs", "performance_baselines"]) {
        const expected = (preMap.get(table) ?? 0) + (preTargetMap.get(table) ?? 0) - (collisionMap.get(table) ?? 0);
        const actual = postMap.get(table) ?? 0;
        if (actual !== expected) {
          throw new Error(`Consolidation integrity check failed for ${table}: expected exactly ${expected}, found ${actual}`);
        }
      }
      // Audit receipt binding the consolidation to its pre/post counts.
      // This is the backup-integrity record: if the consolidation needs to be
      // audited or reversed, the counts prove what moved.
      const receiptRun = await client.query<{ id: string }>(
        `select run.id::text from workflow_runs run where run.project_id = $1::uuid
           and not exists (
             select 1 from action_receipts legacy
              where legacy.run_id = run.id and legacy.receipt_hash is null
           )
         order by coalesce(started_at, updated_at) desc, id desc limit 1 for update`,
        [target.id]
      );
      if (!receiptRun.rows[0]) throw new Error("Canonical target must have a workflow run with complete receipt-chain coverage.");
      await appendActionReceipt(client, {
        runId: receiptRun.rows[0].id,
        agentId: "workflow-orchestrator",
        actionType: "project_consolidated",
        target: source.id,
        summary: `Consolidated project ${input.sourceRootUri} into ${input.targetRootUri}`,
        metadata: JSON.stringify({
            sourceRootUri: input.sourceRootUri,
            targetRootUri: input.targetRootUri,
            sourceProjectId: source.id,
            targetProjectId: target.id,
            preSourceCounts: Object.fromEntries(preMap),
            preTargetCounts: Object.fromEntries(preTargetMap),
            collisionCounts: Object.fromEntries(collisionMap),
            postTargetCounts: Object.fromEntries(postMap),
          })
      });
      await client.query(`delete from projects where id = $1::uuid`, [source.id]);
      await client.query("commit");
      return {
        sourceProjectId: source.id,
        targetProjectId: target.id,
        movedRuns: runs.rowCount ?? 0,
        movedFiles: preMap.get("project_files") ?? files.rowCount ?? 0,
        movedMemoryItems: memory.rowCount ?? 0,
        movedBaselines: baselines.rowCount ?? 0
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
import { appendActionReceipt } from "./receipt-writer.js";

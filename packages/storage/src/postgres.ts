import pg from "pg";
import type { AgentCard, WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import type { RegistryRecord } from "../../agent-registry/src/loaders.js";
import type { IndexedProjectFile } from "../../project-indexer/src/index.js";

const { Client } = pg;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:15432/agentflow";
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
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
      ADD COLUMN IF NOT EXISTS workflow_snapshot jsonb NOT NULL DEFAULT '{}'
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
        decided_at timestamptz,
        decision_note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(run_id, task_id, action_type, idempotency_key)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS action_approvals_status_created_idx
      ON action_approvals(status, created_at)
    `);
  });
}

export async function resetStorage(input: { includeRegistry?: boolean } = {}): Promise<{
  artifacts: number;
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
      const artifacts = await deleteFrom(client, "artifacts");
      const actionReceipts = await deleteFrom(client, "action_receipts");
      const workflowTasks = await deleteFrom(client, "workflow_tasks");
      const workflowRuns = await deleteFrom(client, "workflow_runs");
      const projectFiles = await deleteFrom(client, "project_files");
      const memoryItems = await deleteFrom(client, "memory_items");
      const projects = await deleteFrom(client, "projects");
      const result = {
        artifacts,
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

export async function upsertProject(input: {
  name: string;
  rootUri: string;
  profile: string;
  config: unknown;
}): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into projects (name, root_uri, profile, config, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (root_uri) do update
       set name = excluded.name,
           profile = excluded.profile,
           config = excluded.config,
           updated_at = now()
       returning id`,
      [
        input.name,
        input.rootUri,
        input.profile,
        JSON.stringify(input.config)
      ]
    );
    return result.rows[0].id;
  });
}

export async function upsertProjectFiles(input: {
  projectId: string;
  files: IndexedProjectFile[];
}): Promise<number> {
  return withClient(async (client) => {
    for (const file of input.files) {
      await client.query(
        `insert into project_files (project_id, source_uri, content_hash, token_estimate, summary, metadata, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (project_id, source_uri) do update
         set content_hash = excluded.content_hash,
             token_estimate = excluded.token_estimate,
             summary = excluded.summary,
             metadata = excluded.metadata,
             updated_at = now()`,
        [
          input.projectId,
          file.sourceUri,
          file.contentHash,
          file.tokenEstimate,
          file.summary,
          JSON.stringify(file.metadata)
        ]
      );
    }
    return input.files.length;
  });
}

export interface ProjectFileSummary {
  sourceUri: string;
  contentHash: string;
  tokenEstimate: number;
  summary: string;
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
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
}

export async function listWorkflowQueue(limit = 50): Promise<WorkflowQueueItem[]> {
  return withClient(async (client) => {
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
         count(wt.*)::int as "totalTasks",
         count(*) filter (where wt.status = 'queued')::int as "queuedTasks",
         count(*) filter (where wt.status = 'running')::int as "runningTasks",
         count(*) filter (where wt.status = 'completed')::int as "completedTasks",
         count(*) filter (where wt.status = 'failed')::int as "failedTasks",
         count(*) filter (where wt.status = 'cancelled')::int as "cancelledTasks",
         (array_agg(wt.stage_id order by wt.available_at asc) filter (where wt.status = 'queued'))[1] as "nextStageId",
         (array_agg(wt.agent_id order by wt.available_at asc) filter (where wt.status = 'queued'))[1] as "nextAgentId",
         (array_agg(wt.stage_id order by wt.started_at asc nulls last) filter (where wt.status = 'running'))[1] as "runningStageId",
         (array_agg(wt.agent_id order by wt.started_at asc nulls last) filter (where wt.status = 'running'))[1] as "runningAgentId",
         (min(wt.available_at) filter (where wt.status = 'queued'))::text as "oldestQueuedAt",
         (min(wt.started_at) filter (where wt.status = 'running'))::text as "oldestRunningAt"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       join workflow_tasks wt on wt.run_id = wr.id
       where wr.status in ('queued', 'running', 'failed')
          or exists (
            select 1 from workflow_tasks active
            where active.run_id = wr.id
              and active.status in ('queued', 'running', 'failed')
          )
       group by wr.id, p.id
       order by
         case wr.status when 'running' then 0 when 'queued' then 1 when 'failed' then 2 else 3 end,
         coalesce(min(wt.started_at) filter (where wt.status = 'running'), min(wt.available_at) filter (where wt.status = 'queued'), wr.started_at) asc
       limit $1`,
      [limit]
    );
    return result.rows;
  });
}

export async function cancelWorkflowRun(runId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string }>(
        `update workflow_runs
         set status = 'cancelled',
             finished_at = now()
         where id = $1
           and status in ('queued', 'running')
         returning id::text`,
        [runId]
      );
      if (!result.rows[0]) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update workflow_tasks
         set status = 'cancelled',
             finished_at = now()
         where run_id = $1::uuid
           and status in ('queued', 'running')`,
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
             available_at = now()
         where run_id = $1::uuid
           and status = 'running'
         returning id::text`,
        [runId]
      );
      if (result.rowCount && result.rowCount > 0) {
        await client.query(
          `update workflow_runs
           set status = 'queued',
               finished_at = null
           where id = $1
             and status = 'running'`,
          [runId]
        );
      }
      await client.query("commit");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function retryFailedWorkflowRun(runId: string): Promise<number> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<{ id: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
             available_at = now()
         where run_id = $1
           and status = 'failed'
         returning id::text`,
        [runId]
      );
      if (result.rowCount && result.rowCount > 0) {
        await client.query(
          `update workflow_runs
           set status = 'queued',
               finished_at = null
           where id = $1
             and status = 'failed'`,
          [runId]
        );
      }
      await client.query("commit");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
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
}> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const run = await client.query<{ id: string }>(
        `select id::text
         from workflow_runs
         where id = $1::uuid
           and status in ('queued', 'running', 'failed')
         for update`,
        [input.runId]
      );
      if (!run.rows[0]) {
        await client.query("rollback");
        return { requeuedTasks: 0, completedTasks: 0, totalTasks: 0 };
      }

      const resumableStatuses = input.includeFailed
        ? ["queued", "running", "failed"]
        : ["queued", "running"];
      const result = await client.query<{ id: string }>(
        `update workflow_tasks
         set status = 'queued',
             started_at = null,
             finished_at = null,
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
      if ((result.rowCount ?? 0) > 0) {
        await client.query(
          `update workflow_runs
           set status = 'queued',
               finished_at = null
           where id = $1::uuid`,
          [input.runId]
        );
      }
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1::uuid, 'workflow-orchestrator', 'checkpoint_resume_requested', $1::text, $2, $3)`,
        [
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
        `update workflow_runs wr
         set status = 'dismissed',
             finished_at = coalesce(finished_at, now())
         where wr.id = $1
           and (
             wr.status = 'failed'
             or exists (
               select 1 from workflow_tasks wt
               where wt.run_id = wr.id and wt.status = 'failed'
             )
           )
         returning wr.id::text`,
        [input.runId]
      );
      if (!runResult.rows[0]) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        `update workflow_tasks
         set status = 'dismissed',
             finished_at = coalesce(finished_at, now())
         where run_id = $1 and status in ('queued', 'running', 'failed')`,
        [input.runId]
      );
      await client.query(
        `insert into action_receipts (run_id, agent_id, action_type, target, summary, metadata)
         values ($1, 'workflow-orchestrator', 'failed_run_dismissed', $1::text, $2, $3)`,
        [input.runId, input.reason, JSON.stringify({ actor: input.actor, reason: input.reason, bulk: false })]
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
         where (
           wr.status = 'failed'
           or exists (
             select 1 from workflow_tasks wt
             where wt.run_id = wr.id and wt.status = 'failed'
           )
         )
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
        `update workflow_tasks
         set status = 'dismissed',
             finished_at = coalesce(finished_at, now())
         where run_id = any($1::uuid[]) and status in ('queued', 'running', 'failed')`,
        [runIds]
      );
      await client.query(
        `update workflow_runs
         set status = 'dismissed',
             finished_at = coalesce(finished_at, now())
         where id = any($1::uuid[])`,
        [runIds]
      );
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
           count(*) filter (where status = 'running') as running_runs
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
  compiledBrief?: string;
  compiledBriefMetadata?: Record<string, unknown>;
}

export async function createWorkflowRun(input: CreateRunInput): Promise<{ projectId: string; runId: string; tasks: number }> {
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

      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot, compiled_brief_uri
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          JSON.stringify(input.evaluationMetadata ?? {}),
          JSON.stringify(input.workflow),
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
            JSON.stringify({
              text: input.compiledBrief,
              metadata: input.compiledBriefMetadata ?? {}
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

      for (const stage of input.workflow.stages) {
        await client.query(
          `insert into workflow_tasks (run_id, stage_id, agent_id, status, idempotency_key)
           values ($1, $2, $3, 'queued', $4)`,
          [
            runId,
            stage.id,
            stage.agent,
            `${runId}:${stage.id}:${stage.agent}`
          ]
        );
      }

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
}): Promise<{ projectId: string; runId: string; tasks: number } | null> {
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
        workflowDefinition: WorkflowDefinition | null;
        task: string;
        autonomy: string;
        policyProfile: string;
        policySnapshot: Record<string, unknown>;
        policySnapshotHash: string;
        modelTierOverride: string | null;
        providerOverride: string | null;
        evaluationMetadata: Record<string, unknown>;
        compiledBrief: string | null;
        compiledBriefMetadata: Record<string, unknown> | null;
      }>(
        `select
           p.id::text as "projectId",
           p.name as "projectName",
           p.root_uri as "projectRootUri",
           p.profile as "projectProfile",
           p.config as "projectConfig",
           wr.workflow_id as "workflowId",
           nullif(wr.workflow_snapshot, '{}'::jsonb) as "workflowSnapshot",
           wf.definition as "workflowDefinition",
           wr.task,
           wr.autonomy,
           wr.policy_profile as "policyProfile",
           wr.policy_snapshot as "policySnapshot",
           wr.policy_snapshot_hash as "policySnapshotHash",
           wr.model_tier_override as "modelTierOverride",
           wr.provider_override as "providerOverride",
           wr.evaluation_metadata as "evaluationMetadata",
           artifact.content->>'text' as "compiledBrief",
           artifact.content->'metadata' as "compiledBriefMetadata"
         from workflow_runs wr
         join projects p on p.id = wr.project_id
         left join workflows wf on wf.id = wr.workflow_id
         left join artifacts artifact on artifact.uri = wr.compiled_brief_uri
         where wr.id = $1`,
        [input.sourceRunId]
      );
      const sourceRun = source.rows[0];
      if (!sourceRun) {
        await client.query("rollback");
        return null;
      }
      const workflow = sourceRun.workflowSnapshot ?? sourceRun.workflowDefinition;
      if (!workflow) {
        throw new Error(`Source run workflow is unavailable: ${input.sourceRunId}`);
      }

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
          sourceRun.projectName,
          sourceRun.projectRootUri,
          sourceRun.projectProfile,
          JSON.stringify(sourceRun.projectConfig)
        ]
      );
      const projectId = projectResult.rows[0].id;
      const replayMetadata = {
        ...sourceRun.evaluationMetadata,
        replayOfRunId: input.sourceRunId,
        replayedBy: input.actor,
        replayReason: input.reason
      };
      const runResult = await client.query<{ id: string }>(
        `insert into workflow_runs (
           project_id, workflow_id, status, task, autonomy,
           policy_profile, policy_snapshot, policy_snapshot_hash,
           model_tier_override, provider_override, evaluation_metadata, workflow_snapshot, compiled_brief_uri
         )
         values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, null)
         returning id`,
        [
          projectId,
          sourceRun.workflowId,
          sourceRun.task,
          sourceRun.autonomy,
          sourceRun.policyProfile,
          JSON.stringify(sourceRun.policySnapshot),
          sourceRun.policySnapshotHash,
          sourceRun.modelTierOverride,
          sourceRun.providerOverride,
          JSON.stringify(replayMetadata),
          JSON.stringify(workflow)
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

      for (const stage of workflow.stages) {
        await client.query(
          `insert into workflow_tasks (run_id, stage_id, agent_id, status, idempotency_key)
           values ($1, $2, $3, 'queued', $4)`,
          [
            runId,
            stage.id,
            stage.agent,
            `${runId}:${stage.id}:${stage.agent}`
          ]
        );
      }
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
            policySnapshotHash: sourceRun.policySnapshotHash,
            workflowSnapshot: sourceRun.workflowSnapshot ? "source-run" : "current-registry"
          })
        ]
      );

      await client.query("commit");
      return {
        projectId,
        runId,
        tasks: workflow.stages.length
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
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
  agentId: string;
  agentName: string;
  agentPrompt: string;
  modelTier: string | null;
  providerOverride: string | null;
  compiledBrief: string;
  priorReceipts: Array<{
    agentId: string;
    actionType: string;
    summary: string;
  }>;
}

export async function claimNextWorkflowTask(): Promise<ClaimedWorkflowTask | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<Omit<ClaimedWorkflowTask, "compiledBrief" | "priorReceipts">>(
        `with next_task as (
           select wt.id
           from workflow_tasks wt
           join workflow_runs wr on wr.id = wt.run_id
           join workflows wf on wf.id = wr.workflow_id
           join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') with ordinality stage(definition, stage_order)
             on stage.definition->>'id' = wt.stage_id
           where wt.status = 'queued'
             and wr.status in ('queued', 'running')
             and wt.available_at <= now()
             and not exists (
               select 1
               from workflow_tasks prior
               join lateral jsonb_array_elements(coalesce(nullif(wr.workflow_snapshot, '{}'::jsonb), wf.definition)->'stages') with ordinality prior_stage(definition, stage_order)
                 on prior_stage.definition->>'id' = prior.stage_id
               where prior.run_id = wt.run_id
                 and prior_stage.stage_order < stage.stage_order
                 and prior.status <> 'completed'
             )
           order by wt.available_at asc, stage.stage_order asc
           limit 1
           for update of wt skip locked
         )
         update workflow_tasks wt
         set status = 'running',
             attempts = wt.attempts + 1,
             started_at = now()
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
           wt.agent_id as "agentId",
           a.display_name as "agentName",
           a.definition->>'prompt' as "agentPrompt",
           wr.provider_override as "providerOverride",
           coalesce(wr.model_tier_override, a.definition->>'model_tier') as "modelTier"`
      );

      if (!result.rows[0]) {
        await client.query("commit");
        return null;
      }

      await client.query(
        `update workflow_runs
         set status = 'running'
         where id = $1 and status = 'queued'`,
        [result.rows[0].runId]
      );

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

export async function completeWorkflowTask(input: {
  taskId: string;
  runId: string;
  agentId: string;
  summary: string;
  artifact: Record<string, unknown>;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
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

      await client.query(
        `update workflow_runs wr
         set status = 'completed',
             finished_at = now()
         where wr.id = $1
           and not exists (
             select 1
             from workflow_tasks wt
             where wt.run_id = wr.id
               and wt.status <> 'completed'
           )`,
        [input.runId]
      );

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
}): Promise<void> {
  await withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query(
        `update workflow_tasks
         set status = 'failed',
             finished_at = now()
         where id = $1`,
        [input.taskId]
      );

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
        `update workflow_runs
         set status = 'failed',
             finished_at = now()
         where id = $1`,
        [input.runId]
      );

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
  projectName: string;
  projectRootUri: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowTaskStatus {
  id: string;
  stageId: string;
  agentId: string;
  status: string;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ActionReceiptStatus {
  id: string;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  createdAt: string;
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
  decidedAt: string | null;
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
  aa.decided_at::text as "decidedAt",
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
  taskId: string;
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
        `insert into action_approvals (
           run_id, task_id, stage_id, agent_id, action_type, target,
           rationale, policy_decision, payload, idempotency_key
         )
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (run_id, task_id, action_type, idempotency_key) do update
         set updated_at = now()
         returning id::text, status`,
        [
          input.runId,
          input.taskId,
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
          input.taskId,
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
         case aa.status when 'pending' then 0 when 'approved' then 1 when 'failed' then 2 when 'executed' then 3 when 'rejected' then 4 else 5 end,
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

export async function decideActionApproval(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  actor: string;
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
             updated_at = now()
         from workflow_runs wr, projects p
         where aa.id = $1::uuid
           and aa.status = 'pending'
           and wr.id = aa.run_id
           and p.id = wr.project_id
         returning ${actionApprovalSelect}`,
        [input.approvalId, input.decision, input.actor, input.note ?? null]
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
  status: "executed" | "failed";
  actor: string;
  summary: string;
  artifactUri?: string;
  error?: string;
}): Promise<ActionApprovalStatus | null> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query<ActionApprovalStatus>(
        `update action_approvals aa
         set status = $2,
             decided_by = coalesce(aa.decided_by, $3),
             decided_at = coalesce(aa.decided_at, now()),
             decision_note = concat_ws(E'\n', nullif(aa.decision_note, ''), $4::text),
             updated_at = now()
         from workflow_runs wr, projects p
         where aa.id = $1::uuid
           and aa.status in ('approved', 'failed')
           and wr.id = aa.run_id
           and p.id = wr.project_id
         returning ${actionApprovalSelect}`,
        [input.approvalId, input.status, input.actor, input.summary]
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
          `action_approval_${input.status}`,
          approval.target,
          input.summary,
          JSON.stringify({
            approvalId: approval.id,
            status: input.status,
            actor: input.actor,
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
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       order by wr.started_at desc
       limit $1`,
      [limit]
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
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt"
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
         p.name as "projectName",
         p.root_uri as "projectRootUri",
         wr.started_at::text as "startedAt",
         wr.finished_at::text as "finishedAt"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       where wr.id = $1`,
      [runId]
    );

    const taskResult = await client.query<WorkflowTaskStatus>(
      `select
         id::text,
         stage_id as "stageId",
         agent_id as "agentId",
         status,
         attempts,
         started_at::text as "startedAt",
         finished_at::text as "finishedAt"
       from workflow_tasks
       where run_id = $1
       order by available_at asc, stage_id asc`,
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

async function loadStageContext(client: pg.Client, runId: string): Promise<Pick<ClaimedWorkflowTask, "compiledBrief" | "priorReceipts">> {
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

  return {
    compiledBrief: briefResult.rows[0]?.text ?? "",
    priorReceipts: receiptsResult.rows
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

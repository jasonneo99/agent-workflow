import type pg from "pg";
import { semanticSimilarity } from "../../reuse-engine/src/index.js";

export interface RunDeduplicationContract {
  projectId: string;
  workflowId: string;
  task: string;
  autonomy: string;
  policyProfile: string;
  policySnapshotHash: string;
  modelTierOverride: string | null;
  providerOverride: string | null;
  workflowVersion: string;
  workflowHash: string;
  evaluationMetadataJson: string;
  constructionRationaleJson: string;
  compiledBriefJson: string | null;
}

export interface ReplayConflictCandidate {
  id: string;
  task: string;
  status: string;
  startedAt: string;
  tasks: number;
  completedTasks: number;
}

const REPLAY_GENERIC_TERMS = new Set([
  "agent", "approved", "assistant", "bounded", "build", "complete", "continue",
  "control", "desktop", "docs", "feature", "governed", "implement",
  "implementation", "local", "project", "repair", "request", "run", "tests",
  "verify", "workflow"
]);

function distinctiveTaskTerms(task: string): Set<string> {
  return new Set((task.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/gu) ?? [])
    .filter((term) => !REPLAY_GENERIC_TERMS.has(term)));
}

export function replayTasksEquivalent(left: string, right: string): boolean {
  const leftTerms = distinctiveTaskTerms(left);
  const rightTerms = distinctiveTaskTerms(right);
  const shared = [...leftTerms].filter((term) => rightTerms.has(term));
  return shared.length >= 2 && semanticSimilarity(left, right) >= 0.35;
}

export async function findReplayConflict(client: pg.Client, input: {
  sourceRunId: string;
  sourceStartedAt: string;
  logicalProjectId: string;
  workflowId: string;
  task: string;
}): Promise<ReplayConflictCandidate | null> {
  const lockKey = `workflow-replay:${input.logicalProjectId}:${input.workflowId}`;
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
  const candidates = await client.query<ReplayConflictCandidate>(
    `select wr.id::text,
            wr.task,
            wr.status,
            wr.started_at::text as "startedAt",
            count(wt.id)::int as tasks,
            count(wt.id) filter (where wt.status = 'completed')::int as "completedTasks"
       from workflow_runs wr
       join projects p on p.id = wr.project_id
       left join workflow_tasks wt on wt.run_id = wr.id
      where wr.id <> $1::uuid
        and wr.workflow_id = $2
        and coalesce(p.config->'project'->>'id', p.root_uri) = $3
        and wr.started_at > $4::timestamptz
        and wr.status in ('queued', 'leased', 'running', 'completed')
        and not exists (
          select 1 from action_receipts dismissed
           where dismissed.run_id = wr.id
             and dismissed.action_type in ('failed_run_dismissed', 'failed_run_superseded')
        )
      group by wr.id, wr.task, wr.status, wr.started_at
      order by case when wr.status = 'completed' then 0 else 1 end,
               wr.started_at desc
      limit 50`,
    [input.sourceRunId, input.workflowId, input.logicalProjectId, input.sourceStartedAt]
  );
  return candidates.rows.find((candidate) => replayTasksEquivalent(input.task, candidate.task)) ?? null;
}

export async function findRecentDuplicateRun(client: pg.Client, input: RunDeduplicationContract): Promise<{ id: string; tasks: number } | null> {
  const normalizedTask = input.task.trim();
  const duplicateKey = JSON.stringify({ ...input, task: normalizedTask });
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [duplicateKey]);
  const result = await client.query<{ id: string; tasks: number }>(
    `select wr.id::text, count(wt.id)::int as tasks
     from workflow_runs wr
     left join workflow_tasks wt on wt.run_id = wr.id
     where wr.project_id = $1
       and wr.workflow_id = $2
       and wr.task = $3
       and wr.autonomy = $4
       and wr.policy_profile = $5
       and wr.policy_snapshot_hash = $6
       and wr.model_tier_override is not distinct from $7
       and wr.provider_override is not distinct from $8
       and wr.workflow_definition_version::text = $9
       and wr.workflow_definition_hash = $10
       and wr.evaluation_metadata = $11::jsonb
       and wr.construction_rationale = $12::jsonb
       and (($13::text is null and not exists (
         select 1 from artifacts a where a.run_id = wr.id and a.kind = 'compiled_brief'
       )) or exists (
         select 1 from artifacts a where a.run_id = wr.id and a.kind = 'compiled_brief' and a.content = $13::jsonb
       ))
       and (
         wr.status in ('queued', 'leased', 'running', 'blocked', 'failed')
         or (wr.status = 'completed' and wr.started_at >= now() - interval '15 minutes')
       )
     group by wr.id, wr.started_at
     order by wr.started_at desc
     limit 1`,
    [input.projectId, input.workflowId, normalizedTask, input.autonomy, input.policyProfile,
      input.policySnapshotHash, input.modelTierOverride, input.providerOverride,
      input.workflowVersion, input.workflowHash, input.evaluationMetadataJson,
      input.constructionRationaleJson, input.compiledBriefJson]
  );
  return result.rows[0] ?? null;
}

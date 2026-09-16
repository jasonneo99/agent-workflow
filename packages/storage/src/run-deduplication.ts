import type pg from "pg";

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
       and (wr.status in ('queued', 'leased', 'running') or (wr.status = 'completed' and wr.started_at >= now() - interval '15 minutes'))
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

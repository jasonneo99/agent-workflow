import type { ReuseCandidate, ReuseMemoryCandidate } from "../../reuse-engine/src/index.js";
import { withClient } from "./client.js";

export async function listWorkflowReuseEvidence(input: {
  projectRootUri: string;
  workflowId?: string;
  limit?: number;
}): Promise<{ runs: ReuseCandidate[]; memory: ReuseMemoryCandidate[] }> {
  return withClient(async (client) => {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const [runsResult, memoryResult] = await Promise.all([
      client.query<{
        runId: string;
        task: string;
        workflowId: string;
        workflowHash: string;
        policySnapshotHash: string;
        selectedSources: Array<{ sourceUri?: unknown; contentHash?: unknown }>;
        completedStages: string[];
        totalStages: number;
        startedAt: string;
        finishedAt: string;
        compiledBrief: string;
        measuredTokens: number | null;
        measuredCostUsd: number | null;
        summary: string | null;
      }>(
        `select wr.id::text as "runId",
                wr.task,
                wr.workflow_id as "workflowId",
                wr.workflow_definition_hash as "workflowHash",
                wr.policy_snapshot_hash as "policySnapshotHash",
                coalesce(brief.content->'metadata'->'runInputSnapshot'->'selectedSources', '[]'::jsonb) as "selectedSources",
                coalesce(array_agg(wt.stage_id order by wt.available_at) filter (where wt.status = 'completed'), '{}') as "completedStages",
                count(wt.id)::int as "totalStages",
                wr.started_at::text as "startedAt",
                wr.finished_at::text as "finishedAt",
                coalesce(brief.content->>'text', '') as "compiledBrief",
                route_usage."measuredTokens",
                route_usage."measuredCostUsd",
                latest_stage.content->>'summary' as summary
           from workflow_runs wr
           join projects p on p.id = wr.project_id
           left join workflow_tasks wt on wt.run_id = wr.id
           left join artifacts brief on brief.uri = wr.compiled_brief_uri
           left join lateral (
             select content from artifacts
              where run_id = wr.id and kind = 'stage_output'
              order by created_at desc limit 1
           ) latest_stage on true
           left join lateral (
             select
               sum((content->'usage'->>'totalTokens')::double precision)
                 filter (where jsonb_typeof(content->'usage'->'totalTokens') = 'number') as "measuredTokens",
               sum((content->'usage'->>'costUsd')::double precision)
                 filter (where jsonb_typeof(content->'usage'->'costUsd') = 'number') as "measuredCostUsd"
             from artifacts
             where run_id = wr.id and kind = 'model_route'
           ) route_usage on true
          where p.root_uri = $1
            and wr.status = 'completed'
            and ($2::text is null or wr.workflow_id = $2)
          group by wr.id, brief.content, latest_stage.content, route_usage."measuredTokens", route_usage."measuredCostUsd"
          order by wr.finished_at desc
          limit $3`,
        [input.projectRootUri, input.workflowId ?? null, limit]
      ),
      client.query<{ sourceUri: string; summary: string; kind: string; updatedAt: string }>(
        `select mi.source_uri as "sourceUri", mi.summary,
                coalesce(mi.metadata->>'kind', 'untyped') as kind,
                mi.updated_at::text as "updatedAt"
           from memory_items mi
           join projects p on p.id = mi.project_id
          where p.root_uri = $1
          order by mi.updated_at desc
          limit $2`,
        [input.projectRootUri, limit]
      )
    ]);

    return {
      runs: runsResult.rows.map((row) => ({
        runId: row.runId,
        task: row.task,
        workflowId: row.workflowId,
        workflowHash: row.workflowHash,
        policySnapshotHash: row.policySnapshotHash,
        selectedSources: Array.isArray(row.selectedSources)
          ? row.selectedSources.map((source) => ({
            sourceUri: typeof source.sourceUri === "string" ? source.sourceUri : "",
            contentHash: typeof source.contentHash === "string" ? source.contentHash : null
          })).filter((source) => source.sourceUri)
          : [],
        completedStages: row.completedStages ?? [],
        totalStages: row.totalStages,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        compiledBriefTokens: row.measuredTokens ?? Math.ceil(row.compiledBrief.length / 4),
        modelLatencyMs: Math.max(0, Date.parse(row.finishedAt) - Date.parse(row.startedAt)),
        estimatedCostUsd: row.measuredCostUsd ?? undefined,
        summary: row.summary ?? undefined
      })),
      memory: memoryResult.rows
    };
  });
}

import type pg from "pg";
import { acceptanceDigest } from "./acceptance.js";

type ReplayEvidenceRow = {
  id: string; uri: string; kind: string; runId: string; taskId: string | null;
  depth: number; createdAt: string; content: Record<string, unknown>;
};

/** Load diagnostic observations only from bounded, same-project replay ancestry.
 * Never manufacture current-run acceptance references or completed checkpoints.
 * Raw metadata values are compared as text, so malformed UUIDs cannot crash a
 * worker. The visited set also handles corrupt/cyclic lineage safely.
 */
export async function loadReplayEvidencePacket(client: pg.Client, runId: string): Promise<string | undefined> {
  const result = await client.query<ReplayEvidenceRow>(`
    with recursive lineage as (
      select id, project_id, evaluation_metadata, 0 as depth, array[id] as visited
      from workflow_runs where id = $1::uuid
      union all
      select parent.id, parent.project_id, parent.evaluation_metadata,
        child.depth + 1, child.visited || parent.id
      from lineage child join workflow_runs parent
        on parent.id::text = child.evaluation_metadata->>'replayOfRunId'
        and parent.project_id = child.project_id
      where child.depth < 8 and not parent.id = any(child.visited)
    ), candidates as (
      select a.id::text, a.uri, a.kind, a.run_id::text as "runId",
        a.task_id::text as "taskId", l.depth, a.created_at::text as "createdAt", a.content,
        case when a.kind = 'command_output' and a.content->>'exitCode' <> '0'
          then 0 when a.kind = 'direct_repair_validation' then 1 else 2 end as priority,
        row_number() over (partition by a.run_id, a.kind,
          case when a.content->>'exitCode' <> '0' then 0 else 1 end
          order by a.created_at desc, a.id desc) as rank
      from lineage l join artifacts a on a.run_id = l.id
      where l.depth > 0 and a.kind in ('command_output','direct_repair_validation')
        and (a.kind = 'direct_repair_validation' or exists (
          select 1 from workflow_tasks wt where wt.id = a.task_id and wt.run_id = a.run_id
        ))
    )
    select * from candidates where rank <= 2
    order by priority asc, case when priority = 0 then -depth else depth end,
      "createdAt" desc, id desc limit 24
  `, [runId]);
  return result.rows.length ? replayEvidencePacket(result.rows) : undefined;
}

export function replayEvidencePacket(rows: ReplayEvidenceRow[]): string {
  const observations: Record<string, unknown>[] = [];
  let chars = 0;
  for (const row of rows.slice(0, 24)) {
    const content = row.content;
    const observation = {
      artifactId: row.id, artifactUri: row.uri, sourceRunId: row.runId,
      sourceTaskId: row.taskId, kind: row.kind, ancestorDepth: row.depth,
      observedAt: row.createdAt, contentHash: acceptanceDigest(content),
      diagnosticOnly: true,
      ...(row.kind === "command_output" ? {
        command: String(content.commandLine ?? "").slice(0, 500),
        exitCode: content.exitCode ?? null, timedOut: content.timedOut ?? null,
        stdoutHead: String(content.stdout ?? "").slice(0, 400),
        stdoutTail: String(content.stdout ?? "").slice(-1800),
        stderrTail: String(content.stderr ?? "").slice(-600),
      } : { reportExcerpt: JSON.stringify(content).slice(0, 2400) }),
    };
    const size = JSON.stringify(observation).length;
    if (chars + size > 24000) break;
    observations.push(observation);
    chars += size;
  }
  return JSON.stringify({ purpose: "historical replay evidence; diagnostic only, not current-run acceptance",
    boundedSelection: true, omittedSelectedArtifacts: rows.length - observations.length, observations });
}

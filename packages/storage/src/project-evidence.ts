import type pg from "pg";
import { buildProjectEvidenceGraph, type EvidenceRecords, type ProjectEvidenceGraph } from "../../project-evidence/src/index.js";
import { withClient } from "./client.js";

/** A bounded repeatable-read projection, never a second graph/history store. */
export async function readProjectEvidenceGraph(projectRootUri: string): Promise<ProjectEvidenceGraph> {
  return withClient(async client => {
    await client.query("begin isolation level repeatable read read only");
    try {
      const graph=await projectEvidenceGraphInSnapshot(client,projectRootUri);
      await client.query("commit");
      return graph;
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

/** Caller owns the repeatable-read transaction when composing projections. */
export async function projectEvidenceGraphInSnapshot(client:pg.Client,projectRootUri:string):Promise<ProjectEvidenceGraph>{
      const project = await client.query<{ id: string }>("select id::text from projects where root_uri=$1", [projectRootUri]);
      const projectId = project.rows[0]?.id;
      if (!projectId) {
        return buildProjectEvidenceGraph(projectRootUri, { files: [], runs: [], artifacts: [], tasks: [] });
      }
      const files = await client.query<EvidenceRecords["files"][number]>(`select source_uri as "sourceUri",content_hash as "contentHash",updated_at::text as "updatedAt",metadata from project_files where project_id=$1 and length(source_uri)>0 and left(source_uri,1)<>'/' and source_uri !~ '^[a-zA-Z]+:' and position(chr(92) in source_uri)=0 and source_uri !~ '[[:cntrl:]]' and source_uri !~ '(^|/)([.][.]|[.]git|node_modules|[.]env([.][^/]*)?)(/|$)' and (source_uri not like '.agent-workflow/%' or source_uri in ('.agent-workflow/decisions.md','.agent-workflow/context.md','.agent-workflow/commands.md')) order by source_uri limit 201`, [projectId]);
      const runs = await client.query<EvidenceRecords["runs"][number]>(`select id::text,task,status,updated_at::text as "updatedAt" from workflow_runs where project_id=$1 order by updated_at desc,id limit 51`, [projectId]);
      const runIds = runs.rows.slice(0, 50).map(run => run.id);
      const artifacts = await client.query<EvidenceRecords["artifacts"][number]>(`select id::text,run_id::text as "runId",kind,created_at::text as "createdAt" from artifacts where run_id=any($1::uuid[]) order by created_at desc,id limit 201`, [runIds]);
      const tasks = await client.query<EvidenceRecords["tasks"][number]>(`select id::text,run_id::text as "runId",agent_id as "agentId",status,finished_at::text as "finishedAt" from workflow_tasks where run_id=any($1::uuid[]) order by id limit 501`, [runIds]);
      return buildProjectEvidenceGraph(projectRootUri, { files: files.rows.slice(0, 200), runs: runs.rows.slice(0, 50), artifacts: artifacts.rows.slice(0, 200), tasks: tasks.rows.slice(0, 500) }, { truncated: files.rows.length > 200 || runs.rows.length > 50 || artifacts.rows.length > 200 || tasks.rows.length > 500 });
}

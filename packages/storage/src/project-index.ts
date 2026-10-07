import type { IndexedProjectFile } from "../../project-indexer/src/index.js";
import { withClient } from "./client.js";

export interface ProjectFileSearchHit { path: string; contentHash: string; indexedAt: string }

/** Discovery hints only: callers must read current files before trusting content. */
export async function searchProjectFileIndex(projectRoot: string, query: string): Promise<ProjectFileSearchHit[]> {
  const terms = query.toLowerCase().split(/[^a-z0-9._-]+/u).filter((term) => term.length >= 2).slice(0, 6);
  if (!terms.length) return [];
  return withClient(async (client) => {
    const result = await client.query<ProjectFileSearchHit>(
      `select pf.source_uri as path, pf.content_hash as "contentHash", pf.updated_at::text as "indexedAt"
       from project_files pf join projects p on p.id=pf.project_id
       where p.root_uri=$1
         and pf.source_uri not like '.agent-workflow/%'
         and pf.source_uri !~ '(^|/)[.]env($|[.])|[.](pem|key|p12|mobileprovision)$'
         and not exists (select 1 from unnest($2::text[]) term where position(term in lower(pf.source_uri))=0)
       order by (lower(pf.source_uri)=lower($3)) desc,
                (lower(regexp_replace(pf.source_uri, '^.*/', ''))=lower($3)) desc,
                length(pf.source_uri), pf.source_uri
       limit 41`, [projectRoot, terms, query.trim()]
    );
    return result.rows;
  });
}

export async function upsertProject(input: { name: string; rootUri: string; profile: string; config: unknown }): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into projects (name, root_uri, profile, config, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (root_uri) do update
       set name = excluded.name, profile = excluded.profile, config = excluded.config, updated_at = now()
       returning id`,
      [input.name, input.rootUri, input.profile, JSON.stringify(input.config)]
    );
    return result.rows[0].id;
  });
}

export async function upsertProjectFiles(input: { projectId: string; files: IndexedProjectFile[] }): Promise<number> {
  return withClient(async (client) => {
    for (const file of input.files) {
      await client.query(
        `insert into project_files (project_id, source_uri, content_hash, token_estimate, summary, metadata, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (project_id, source_uri) do update
         set content_hash = excluded.content_hash, token_estimate = excluded.token_estimate,
             summary = excluded.summary, metadata = excluded.metadata, updated_at = now()`,
        [input.projectId, file.sourceUri, file.contentHash, file.tokenEstimate, file.summary, JSON.stringify(file.metadata)]
      );
    }
    return input.files.length;
  });
}

export async function deleteProjectFiles(input: { projectId: string; sourceUris: string[] }): Promise<number> {
  if (!input.sourceUris.length) return 0;
  return withClient(async (client) => {
    const result = await client.query(`delete from project_files where project_id = $1 and source_uri = any($2::text[])`, [input.projectId, input.sourceUris]);
    return result.rowCount ?? 0;
  });
}

export interface ProjectIndexState { projectId: string; headCommit: string | null; indexedFiles: number; deletedFiles: number; metadata: Record<string, unknown>; updatedAt: string }

export async function getProjectIndexState(input: { projectId: string }): Promise<ProjectIndexState | null> {
  return withClient(async (client) => {
    const result = await client.query<ProjectIndexState>(
      `select project_id::text as "projectId", head_commit as "headCommit", indexed_files as "indexedFiles",
              deleted_files as "deletedFiles", metadata, updated_at::text as "updatedAt"
       from project_index_state where project_id = $1`, [input.projectId]);
    return result.rows[0] ?? null;
  });
}

export async function upsertProjectIndexState(input: { projectId: string; headCommit?: string; indexedFiles: number; deletedFiles: number; metadata?: Record<string, unknown> }): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `insert into project_index_state (project_id, head_commit, indexed_files, deleted_files, metadata, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (project_id) do update
       set head_commit = excluded.head_commit, indexed_files = excluded.indexed_files,
           deleted_files = excluded.deleted_files, metadata = excluded.metadata, updated_at = now()`,
      [input.projectId, input.headCommit ?? null, input.indexedFiles, input.deletedFiles, JSON.stringify(input.metadata ?? {})]
    );
  });
}

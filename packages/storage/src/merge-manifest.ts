import pg from "pg";

const { Client } = pg;

export type StorageMergeManifestStatus = "ready" | "attention" | "blocked";

export type StorageMergeTableName =
  | "projects"
  | "project_files"
  | "project_index_state"
  | "workflow_runs"
  | "workflow_tasks"
  | "action_receipts"
  | "action_approvals"
  | "artifacts"
  | "memory_items";

export interface StorageMergeManifestInput {
  sourceEnv?: NodeJS.ProcessEnv;
  targetEnv?: NodeJS.ProcessEnv;
  targetHost?: string;
  sourceDatabaseUrl?: string;
  targetDatabaseUrl?: string;
}

export interface StorageMergeRow {
  key: string;
  fingerprint: string;
  projectRoot?: string | null;
  projectId?: string | null;
}

export interface StorageMergeManifestRows {
  projects: StorageMergeRow[];
  project_files: StorageMergeRow[];
  project_index_state: StorageMergeRow[];
  workflow_runs: StorageMergeRow[];
  workflow_tasks: StorageMergeRow[];
  action_receipts: StorageMergeRow[];
  action_approvals: StorageMergeRow[];
  artifacts: StorageMergeRow[];
  memory_items: StorageMergeRow[];
}

export interface StorageMergeProjectMapping {
  rootUri: string;
  sourceProjectId: string;
  targetProjectId: string | null;
  action: "map-existing" | "insert-project";
  sourceName?: string | null;
  targetName?: string | null;
}

export interface StorageMergeTablePlan {
  table: StorageMergeTableName;
  sourceRows: number;
  targetRows: number;
  insertRows: number;
  existingRows: number;
  conflictRows: number;
  projectIdRewriteRows: number;
  sampleInsertKeys: string[];
  sampleConflictKeys: string[];
  notes: string[];
}

export interface StorageMergeManifest {
  kind: "agentflow_storage_merge_manifest";
  generatedAt: string;
  status: StorageMergeManifestStatus;
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  projectMappings: StorageMergeProjectMapping[];
  tablePlans: StorageMergeTablePlan[];
  warnings: string[];
  recommendations: string[];
}

interface ProjectRow extends StorageMergeRow {
  name?: string | null;
}

export async function buildStorageMergeManifest(input: StorageMergeManifestInput): Promise<StorageMergeManifest> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const targetEnv = input.targetEnv ?? {};
  const targetHost = input.targetHost ?? sourceEnv.AGENTFLOW_SHARED_STORAGE_HOST ?? targetEnv.AGENTFLOW_SHARED_STORAGE_HOST;
  const sourceDatabaseUrl = input.sourceDatabaseUrl ?? sourceEnv.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:15432/agentflow";
  const targetDatabaseUrl = input.targetDatabaseUrl ?? targetEnv.DATABASE_URL ?? endpointUrlWhenHostMatches(sourceDatabaseUrl, targetHost) ?? (
    targetHost ? `postgres://agentflow:agentflow@${targetHost}:15432/agentflow` : "postgres://agentflow:agentflow@localhost:15432/agentflow"
  );
  const warnings = sameDatabaseWarning(sourceDatabaseUrl, targetDatabaseUrl);
  if (warnings.length) {
    return {
      kind: "agentflow_storage_merge_manifest",
      generatedAt: new Date().toISOString(),
      status: "blocked",
      sourceDatabaseUrl: redactUrl(sourceDatabaseUrl),
      targetDatabaseUrl: redactUrl(targetDatabaseUrl),
      projectMappings: [],
      tablePlans: emptyTablePlans(),
      warnings,
      recommendations: [
        "Choose distinct source and target Postgres databases before generating a merge manifest."
      ]
    };
  }

  const sourceClient = new Client({ connectionString: sourceDatabaseUrl });
  const targetClient = new Client({ connectionString: targetDatabaseUrl });
  try {
    await Promise.all([sourceClient.connect(), targetClient.connect()]);
    const [sourceRows, targetRows] = await Promise.all([
      loadMergeRows(sourceClient),
      loadMergeRows(targetClient)
    ]);
    return buildStorageMergeManifestFromRows({
      generatedAt: new Date().toISOString(),
      sourceDatabaseUrl,
      targetDatabaseUrl,
      sourceRows,
      targetRows,
      warnings
    });
  } catch (error) {
    return {
      kind: "agentflow_storage_merge_manifest",
      generatedAt: new Date().toISOString(),
      status: "blocked",
      sourceDatabaseUrl: redactUrl(sourceDatabaseUrl),
      targetDatabaseUrl: redactUrl(targetDatabaseUrl),
      projectMappings: [],
      tablePlans: emptyTablePlans(),
      warnings: [`database merge manifest inspection failed: ${error instanceof Error ? error.message : String(error)}`],
      recommendations: [
        "Run storage-verify first and confirm both source and target Postgres databases are reachable."
      ]
    };
  } finally {
    await Promise.allSettled([sourceClient.end(), targetClient.end()]);
  }
}

export function buildStorageMergeManifestFromRows(input: {
  generatedAt?: string;
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  sourceRows: StorageMergeManifestRows;
  targetRows: StorageMergeManifestRows;
  warnings?: string[];
}): StorageMergeManifest {
  const sourceProjects = input.sourceRows.projects as ProjectRow[];
  const targetProjects = input.targetRows.projects as ProjectRow[];
  const targetProjectsByRoot = new Map(targetProjects.map((project) => [project.projectRoot ?? project.key, project]));
  const projectMappings = sourceProjects
    .map((project) => {
      const rootUri = project.projectRoot ?? project.key;
      const targetProject = targetProjectsByRoot.get(rootUri);
      return {
        rootUri,
        sourceProjectId: project.projectId ?? project.key,
        targetProjectId: targetProject?.projectId ?? null,
        action: targetProject ? "map-existing" as const : "insert-project" as const,
        sourceName: project.name ?? null,
        targetName: targetProject?.name ?? null
      };
    })
    .sort((a, b) => a.rootUri.localeCompare(b.rootUri));
  const targetProjectIdsByRoot = new Map(projectMappings
    .filter((mapping) => mapping.targetProjectId)
    .map((mapping) => [mapping.rootUri, mapping.targetProjectId as string]));
  const tablePlans = tableNames.map((table) => buildTablePlan(
    table,
    input.sourceRows[table],
    input.targetRows[table],
    targetProjectIdsByRoot
  ));
  const conflicts = tablePlans.reduce((sum, plan) => sum + plan.conflictRows, 0);
  const insertRows = tablePlans.reduce((sum, plan) => sum + plan.insertRows, 0);
  const warnings = [
    ...(input.warnings ?? []),
    ...(conflicts ? [`${conflicts} row-level conflict(s) need review before a write-capable merge.`] : [])
  ];
  return {
    kind: "agentflow_storage_merge_manifest",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: warnings.length ? "attention" : insertRows > 0 ? "ready" : "attention",
    sourceDatabaseUrl: redactUrl(input.sourceDatabaseUrl),
    targetDatabaseUrl: redactUrl(input.targetDatabaseUrl),
    projectMappings,
    tablePlans,
    warnings,
    recommendations: [
      "Dry-run only. This manifest does not insert, update, delete, overwrite, or mutate source or target storage.",
      "Map projects by root_uri and preserve existing target project ids for overlapping projects.",
      "Import source-only rows by dependency order: projects, project index state/files/memory, workflow runs, tasks, receipts, approvals, artifacts.",
      "Review conflict rows before enabling a write-capable importer.",
      "Back up both source and target databases immediately before executing any future merge."
    ]
  };
}

export function formatStorageMergeManifest(manifest: StorageMergeManifest): string {
  return [
    `Shared storage merge manifest (${manifest.generatedAt})`,
    `Status: ${manifest.status}`,
    "",
    "Source:",
    `- Database: ${manifest.sourceDatabaseUrl}`,
    "",
    "Target:",
    `- Database: ${manifest.targetDatabaseUrl}`,
    "",
    "Project mapping:",
    ...manifest.projectMappings.map((mapping) => `- ${mapping.action}: ${mapping.rootUri} (source=${mapping.sourceProjectId}, target=${mapping.targetProjectId ?? "new"})`),
    ...(manifest.projectMappings.length ? [] : ["- none"]),
    "",
    "Table plans:",
    ...manifest.tablePlans.flatMap((plan) => [
      `- ${plan.table}: source=${plan.sourceRows}, target=${plan.targetRows}, insert=${plan.insertRows}, existing=${plan.existingRows}, conflicts=${plan.conflictRows}, project-id rewrites=${plan.projectIdRewriteRows}`,
      ...(plan.sampleInsertKeys.length ? [`  sample inserts: ${plan.sampleInsertKeys.join("; ")}`] : []),
      ...(plan.sampleConflictKeys.length ? [`  sample conflicts: ${plan.sampleConflictKeys.join("; ")}`] : [])
    ]),
    "",
    "Warnings:",
    ...(manifest.warnings.length ? manifest.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Recommendations:",
    ...manifest.recommendations.map((item) => `- ${item}`)
  ].join("\n");
}

async function loadMergeRows(client: pg.Client): Promise<StorageMergeManifestRows> {
  const entries: Array<readonly [StorageMergeTableName, StorageMergeRow[]]> = [];
  for (const table of tableNames) {
    entries.push([table, await loadTableRows(client, table)]);
  }
  return Object.fromEntries(entries) as unknown as StorageMergeManifestRows;
}

async function loadTableRows(client: pg.Client, table: StorageMergeTableName): Promise<StorageMergeRow[]> {
  const exists = await tableExists(client, table);
  if (!exists) return [];
  const query = tableQueries[table];
  const result = await client.query(query);
  return result.rows.map((row) => ({
    key: String(row.key),
    fingerprint: String(row.fingerprint),
    projectRoot: row.project_root ?? null,
    projectId: row.project_id ? String(row.project_id) : null,
    ...(row.name ? { name: String(row.name) } : {})
  }));
}

async function tableExists(client: pg.Client, table: StorageMergeTableName): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [`public.${table}`]);
  return result.rows[0]?.exists === true;
}

function buildTablePlan(
  table: StorageMergeTableName,
  sourceRows: StorageMergeRow[],
  targetRows: StorageMergeRow[],
  targetProjectIdsByRoot: Map<string, string>
): StorageMergeTablePlan {
  const targetByKey = new Map(targetRows.map((row) => [row.key, row]));
  const insertRows = sourceRows.filter((row) => !targetByKey.has(row.key)).length;
  const existingRows = sourceRows.length - insertRows;
  const conflictingRows = sourceRows.filter((row) => {
    const target = targetByKey.get(row.key);
    return target && target.fingerprint !== row.fingerprint;
  });
  const projectIdRewriteRows = sourceRows.filter((row) => {
    if (table === "projects") return false;
    if (!row.projectRoot || !row.projectId) return false;
    const targetProjectId = targetProjectIdsByRoot.get(row.projectRoot);
    return Boolean(targetProjectId && targetProjectId !== row.projectId);
  }).length;
  const conflictRows = conflictingRows.length;
  const sampleInsertKeys = sourceRows
    .filter((row) => !targetByKey.has(row.key))
    .map((row) => printableKey(row.key))
    .slice(0, 10);
  const sampleConflictKeys = conflictingRows
    .map((row) => printableKey(row.key))
    .slice(0, 10);
  const notes = [
    ...(insertRows ? [`${insertRows} source-only row(s) are candidates for a future importer.`] : ["No source-only rows found for this table."]),
    ...(projectIdRewriteRows ? [`${projectIdRewriteRows} row(s) reference an overlapping project and would need target project_id rewriting.`] : []),
    ...(conflictRows ? [`${conflictRows} existing target row(s) have different fingerprints and need review.`] : [])
  ];
  return {
    table,
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    insertRows,
    existingRows,
    conflictRows,
    projectIdRewriteRows,
    sampleInsertKeys,
    sampleConflictKeys,
    notes
  };
}

function emptyTablePlans(): StorageMergeTablePlan[] {
  return tableNames.map((table) => ({
    table,
    sourceRows: 0,
    targetRows: 0,
    insertRows: 0,
    existingRows: 0,
    conflictRows: 0,
    projectIdRewriteRows: 0,
    sampleInsertKeys: [],
    sampleConflictKeys: [],
    notes: ["No rows inspected."]
  }));
}

function printableKey(key: string): string {
  return key.replaceAll("\u001f", " :: ");
}

function endpointUrlWhenHostMatches(value: string, host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(value).hostname === host ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameDatabaseWarning(sourceDatabaseUrl: string, targetDatabaseUrl: string): string[] {
  return canonicalUrl(sourceDatabaseUrl) === canonicalUrl(targetDatabaseUrl)
    ? ["source and target database URLs point to the same endpoint"]
    : [];
}

function canonicalUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "user";
    if (parsed.password) parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://user:redacted@");
  }
}

const tableNames: StorageMergeTableName[] = [
  "projects",
  "project_files",
  "project_index_state",
  "workflow_runs",
  "workflow_tasks",
  "action_receipts",
  "action_approvals",
  "artifacts",
  "memory_items"
];

const tableQueries: Record<StorageMergeTableName, string> = {
  projects: `
    select root_uri as key,
      md5(root_uri || ':' || name || ':' || profile || ':' || config::text) as fingerprint,
      root_uri as project_root,
      id::text as project_id,
      name
    from projects
  `,
  project_files: `
    select p.root_uri || chr(31) || pf.source_uri as key,
      md5(pf.source_uri || ':' || pf.content_hash || ':' || pf.token_estimate::text || ':' || coalesce(pf.summary, '') || ':' || pf.metadata::text) as fingerprint,
      p.root_uri as project_root,
      pf.project_id::text as project_id
    from project_files pf
    join projects p on p.id = pf.project_id
  `,
  project_index_state: `
    select p.root_uri as key,
      md5(coalesce(pis.head_commit, '') || ':' || pis.indexed_files::text || ':' || pis.deleted_files::text || ':' || pis.metadata::text) as fingerprint,
      p.root_uri as project_root,
      pis.project_id::text as project_id
    from project_index_state pis
    join projects p on p.id = pis.project_id
  `,
  workflow_runs: `
    select wr.id::text as key,
      md5(wr.id::text || ':' || coalesce(p.root_uri, '') || ':' || wr.workflow_id || ':' || wr.status || ':' || wr.task || ':' || wr.autonomy || ':' || wr.policy_profile || ':' || wr.policy_snapshot_hash) as fingerprint,
      p.root_uri as project_root,
      wr.project_id::text as project_id
    from workflow_runs wr
    left join projects p on p.id = wr.project_id
  `,
  workflow_tasks: `
    select wt.id::text as key,
      md5(wt.id::text || ':' || wt.run_id::text || ':' || wt.stage_id || ':' || wt.agent_id || ':' || wt.status || ':' || wt.attempts::text || ':' || wt.idempotency_key) as fingerprint,
      p.root_uri as project_root,
      wr.project_id::text as project_id
    from workflow_tasks wt
    left join workflow_runs wr on wr.id = wt.run_id
    left join projects p on p.id = wr.project_id
  `,
  action_receipts: `
    select ar.id::text as key,
      md5(ar.id::text || ':' || ar.run_id::text || ':' || ar.agent_id || ':' || ar.action_type || ':' || ar.target || ':' || ar.summary || ':' || ar.metadata::text) as fingerprint,
      p.root_uri as project_root,
      wr.project_id::text as project_id
    from action_receipts ar
    left join workflow_runs wr on wr.id = ar.run_id
    left join projects p on p.id = wr.project_id
  `,
  action_approvals: `
    select aa.id::text as key,
      md5(aa.id::text || ':' || aa.run_id::text || ':' || coalesce(aa.task_id::text, '') || ':' || aa.stage_id || ':' || aa.agent_id || ':' || aa.action_type || ':' || aa.target || ':' || aa.status || ':' || aa.idempotency_key) as fingerprint,
      p.root_uri as project_root,
      wr.project_id::text as project_id
    from action_approvals aa
    left join workflow_runs wr on wr.id = aa.run_id
    left join projects p on p.id = wr.project_id
  `,
  artifacts: `
    select a.uri as key,
      md5(a.uri || ':' || coalesce(a.run_id::text, '') || ':' || coalesce(a.task_id::text, '') || ':' || a.kind || ':' || a.content::text) as fingerprint,
      p.root_uri as project_root,
      wr.project_id::text as project_id
    from artifacts a
    left join workflow_runs wr on wr.id = a.run_id
    left join projects p on p.id = wr.project_id
  `,
  memory_items: `
    select p.root_uri || chr(31) || mi.source_uri || chr(31) || mi.content_hash as key,
      md5(mi.source_uri || ':' || mi.content_hash || ':' || mi.summary || ':' || mi.metadata::text) as fingerprint,
      p.root_uri as project_root,
      mi.project_id::text as project_id
    from memory_items mi
    join projects p on p.id = mi.project_id
  `
};

import pg from "pg";
import { createHash } from "node:crypto";

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

export interface StorageProjectConflictReport {
  kind: "agentflow_storage_project_conflict_report";
  generatedAt: string;
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  conflicts: StorageProjectConflict[];
  recommendations: string[];
}

export interface StorageProjectConflict {
  rootUri: string;
  recommendation: "prefer-target" | "prefer-source" | "manual-review";
  reason: string;
  differingFields: string[];
  source: StorageProjectConflictSide;
  target: StorageProjectConflictSide;
  decisionRecord: {
    action: "preserve-target-project" | "promote-source-project" | "manual-project-review";
    rootUri: string;
    sourceProjectId: string;
    targetProjectId: string;
    note: string;
  };
}

export interface StorageProjectConflictSide {
  projectId: string;
  name: string | null;
  profile: string | null;
  configHash: string;
  configPreview: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  linkedRows: Record<string, number>;
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
  sampleSourceKeys: string[];
  sampleExistingKeys: string[];
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
  legacyDefinitionReferences: StorageMergeLegacyDefinitionReference[];
  warnings: string[];
  recommendations: string[];
}

interface ProjectRow extends StorageMergeRow {
  name?: string | null;
}

export interface StorageMergeDefinitionRow {
  definitionType: "agent" | "workflow";
  definitionId: string;
  sourcePath?: string | null;
  fingerprint: string;
}

export interface StorageMergeDefinitionReferenceRow {
  definitionType: "agent" | "workflow";
  definitionId: string;
  referenceCount: number;
  sampleRunIds: string[];
  sampleStageIds: string[];
  snapshotAvailable: boolean;
}

export interface StorageMergeLegacyDefinitionReference {
  definitionType: "agent" | "workflow";
  definitionId: string;
  referenceCount: number;
  sampleRunIds: string[];
  sampleStageIds: string[];
  sourceRegistry: "present" | "missing";
  targetRegistry: "present" | "missing";
  targetDiffers: boolean;
  snapshotAvailable: boolean;
  action:
    | "already-current"
    | "insert-missing-registry"
    | "preserve-target-current"
    | "readability-warning";
  notes: string[];
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
      legacyDefinitionReferences: [],
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
    const [sourceDefinitions, targetDefinitions, sourceDefinitionReferences] = await Promise.all([
      loadRegistryDefinitionRows(sourceClient),
      loadRegistryDefinitionRows(targetClient),
      loadDefinitionReferenceRows(sourceClient)
    ]);
    return buildStorageMergeManifestFromRows({
      generatedAt: new Date().toISOString(),
      sourceDatabaseUrl,
      targetDatabaseUrl,
      sourceRows,
      targetRows,
      sourceDefinitions,
      targetDefinitions,
      sourceDefinitionReferences,
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
      legacyDefinitionReferences: [],
      warnings: [`database merge manifest inspection failed: ${error instanceof Error ? error.message : String(error)}`],
      recommendations: [
        "Run storage-verify first and confirm both source and target Postgres databases are reachable."
      ]
    };
  } finally {
    await Promise.allSettled([sourceClient.end(), targetClient.end()]);
  }
}

export async function buildStorageProjectConflictReport(input: StorageMergeManifestInput): Promise<StorageProjectConflictReport> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const targetEnv = input.targetEnv ?? {};
  const targetHost = input.targetHost ?? sourceEnv.AGENTFLOW_SHARED_STORAGE_HOST ?? targetEnv.AGENTFLOW_SHARED_STORAGE_HOST;
  const sourceDatabaseUrl = input.sourceDatabaseUrl ?? sourceEnv.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:15432/agentflow";
  const targetDatabaseUrl = input.targetDatabaseUrl ?? targetEnv.DATABASE_URL ?? endpointUrlWhenHostMatches(sourceDatabaseUrl, targetHost) ?? (
    targetHost ? `postgres://agentflow:agentflow@${targetHost}:15432/agentflow` : "postgres://agentflow:agentflow@localhost:15432/agentflow"
  );
  const sourceClient = new Client({ connectionString: sourceDatabaseUrl });
  const targetClient = new Client({ connectionString: targetDatabaseUrl });
  try {
    await Promise.all([sourceClient.connect(), targetClient.connect()]);
    const [sourceProjects, targetProjects] = await Promise.all([
      loadProjectConflictRows(sourceClient),
      loadProjectConflictRows(targetClient)
    ]);
    const targetByRoot = new Map(targetProjects.map((project) => [project.rootUri, project]));
    const conflicts = sourceProjects
      .map((source) => {
        const target = targetByRoot.get(source.rootUri);
        if (!target) return null;
        const differingFields = projectDifferingFields(source, target);
        if (!differingFields.length) return null;
        return buildProjectConflict(source, target, differingFields);
      })
      .filter((conflict): conflict is StorageProjectConflict => Boolean(conflict))
      .sort((a, b) => a.rootUri.localeCompare(b.rootUri));
    return {
      kind: "agentflow_storage_project_conflict_report",
      generatedAt: new Date().toISOString(),
      sourceDatabaseUrl: redactUrl(sourceDatabaseUrl),
      targetDatabaseUrl: redactUrl(targetDatabaseUrl),
      conflicts,
      recommendations: [
        "Read-only preview. This command does not update source or target storage.",
        "Prefer the target project when shared storage already has linked workflow history or newer metadata.",
        "Prefer the source project only after confirming its config is the intended canonical state.",
        "Record an operator decision before treating shared storage as the primary state plane."
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
  sourceDefinitions?: StorageMergeDefinitionRow[];
  targetDefinitions?: StorageMergeDefinitionRow[];
  sourceDefinitionReferences?: StorageMergeDefinitionReferenceRow[];
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
  const legacyDefinitionReferences = buildLegacyDefinitionReferences(
    input.sourceDefinitionReferences ?? [],
    input.sourceDefinitions ?? [],
    input.targetDefinitions ?? []
  );
  const conflicts = tablePlans.reduce((sum, plan) => sum + plan.conflictRows, 0);
  const insertRows = tablePlans.reduce((sum, plan) => sum + plan.insertRows, 0);
  const readabilityWarnings = legacyDefinitionReferences.filter((item) => item.action === "readability-warning").length;
  const preservedConflicts = legacyDefinitionReferences.filter((item) => item.action === "preserve-target-current").length;
  const warnings = [
    ...(input.warnings ?? []),
    ...(conflicts ? [`${conflicts} row-level conflict(s) need review before a write-capable merge.`] : []),
    ...(readabilityWarnings ? [`${readabilityWarnings} historical definition reference(s) do not resolve in source or target registry.`] : []),
    ...(preservedConflicts ? [`${preservedConflicts} historical definition reference(s) have source definitions that differ from the target registry; target definitions will be preserved.`] : [])
  ];
  return {
    kind: "agentflow_storage_merge_manifest",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: warnings.length ? "attention" : insertRows > 0 ? "ready" : "attention",
    sourceDatabaseUrl: redactUrl(input.sourceDatabaseUrl),
    targetDatabaseUrl: redactUrl(input.targetDatabaseUrl),
    projectMappings,
    tablePlans,
    legacyDefinitionReferences,
    warnings,
    recommendations: [
      "Dry-run only. This manifest does not insert, update, delete, overwrite, or mutate source or target storage.",
      "Map projects by root_uri and preserve existing target project ids for overlapping projects.",
      "Import source-only rows by dependency order: projects, project index state/files/memory, workflow runs, tasks, receipts, approvals, artifacts.",
      "Insert source registry definitions only when missing from the target; preserve current target definitions when the same id has changed.",
      "Use legacy definition references to review old runs/tasks whose agent or workflow definitions are missing or differ from the current shared bundle.",
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
      ...(plan.sampleSourceKeys.length ? [`  sample source rows: ${plan.sampleSourceKeys.join("; ")}`] : []),
      ...(plan.sampleExistingKeys.length ? [`  sample existing rows: ${plan.sampleExistingKeys.join("; ")}`] : []),
      ...(plan.sampleInsertKeys.length ? [`  sample inserts: ${plan.sampleInsertKeys.join("; ")}`] : []),
      ...(plan.sampleConflictKeys.length ? [`  sample conflicts: ${plan.sampleConflictKeys.join("; ")}`] : [])
    ]),
    "",
    "Legacy definition references:",
    ...manifest.legacyDefinitionReferences.map((reference) => [
      `- ${reference.definitionType}:${reference.definitionId}: action=${reference.action}, source=${reference.sourceRegistry}, target=${reference.targetRegistry}, references=${reference.referenceCount}, target-differs=${reference.targetDiffers ? "yes" : "no"}, snapshot=${reference.snapshotAvailable ? "yes" : "no"}`,
      ...(reference.sampleRunIds.length ? [`  sample runs: ${reference.sampleRunIds.join(", ")}`] : []),
      ...(reference.sampleStageIds.length ? [`  sample stages: ${reference.sampleStageIds.join(", ")}`] : []),
      ...reference.notes.map((note) => `  ${note}`)
    ]).flat(),
    ...(manifest.legacyDefinitionReferences.length ? [] : ["- none"]),
    "",
    "Warnings:",
    ...(manifest.warnings.length ? manifest.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Recommendations:",
    ...manifest.recommendations.map((item) => `- ${item}`)
  ].join("\n");
}

async function loadRegistryDefinitionRows(client: pg.Client): Promise<StorageMergeDefinitionRow[]> {
  const [agentsExist, workflowsExist] = await Promise.all([
    tableExists(client, "agents"),
    tableExists(client, "workflows")
  ]);
  const rows: StorageMergeDefinitionRow[] = [];
  if (agentsExist) {
    const result = await client.query("select id, source_path, md5(definition::text) as fingerprint from agents order by id");
    rows.push(...result.rows.map((row) => ({
      definitionType: "agent" as const,
      definitionId: String(row.id),
      sourcePath: row.source_path ?? null,
      fingerprint: String(row.fingerprint)
    })));
  }
  if (workflowsExist) {
    const result = await client.query("select id, source_path, md5(definition::text) as fingerprint from workflows order by id");
    rows.push(...result.rows.map((row) => ({
      definitionType: "workflow" as const,
      definitionId: String(row.id),
      sourcePath: row.source_path ?? null,
      fingerprint: String(row.fingerprint)
    })));
  }
  return rows;
}

async function loadDefinitionReferenceRows(client: pg.Client): Promise<StorageMergeDefinitionReferenceRow[]> {
  const [workflowRunsExist, workflowTasksExist] = await Promise.all([
    tableExists(client, "workflow_runs"),
    tableExists(client, "workflow_tasks")
  ]);
  const references: StorageMergeDefinitionReferenceRow[] = [];
  if (workflowRunsExist) {
    const result = await client.query(`
      select workflow_id as definition_id,
        count(*)::int as reference_count,
        array_agg(id::text order by started_at desc) as sample_run_ids,
        bool_or(workflow_snapshot <> '{}'::jsonb) as snapshot_available
      from workflow_runs
      group by workflow_id
      order by workflow_id
    `);
    references.push(...result.rows.map((row) => ({
      definitionType: "workflow" as const,
      definitionId: String(row.definition_id),
      referenceCount: Number(row.reference_count),
      sampleRunIds: toStringList(row.sample_run_ids).slice(0, 5),
      sampleStageIds: [],
      snapshotAvailable: row.snapshot_available === true
    })));
  }
  if (workflowTasksExist) {
    const result = await client.query(`
      select agent_id as definition_id,
        count(*)::int as reference_count,
        array_agg(distinct run_id::text) as sample_run_ids,
        array_agg(distinct stage_id) as sample_stage_ids
      from workflow_tasks
      where agent_id is not null and agent_id <> ''
      group by agent_id
      order by agent_id
    `);
    references.push(...result.rows.map((row) => ({
      definitionType: "agent" as const,
      definitionId: String(row.definition_id),
      referenceCount: Number(row.reference_count),
      sampleRunIds: toStringList(row.sample_run_ids).slice(0, 5),
      sampleStageIds: toStringList(row.sample_stage_ids).slice(0, 8),
      snapshotAvailable: false
    })));
  }
  return references;
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

async function tableExists(client: pg.Client, table: StorageMergeTableName | "agents" | "workflows"): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [`public.${table}`]);
  return result.rows[0]?.exists === true;
}

function buildLegacyDefinitionReferences(
  references: StorageMergeDefinitionReferenceRow[],
  sourceDefinitions: StorageMergeDefinitionRow[],
  targetDefinitions: StorageMergeDefinitionRow[]
): StorageMergeLegacyDefinitionReference[] {
  const sourceByKey = definitionMap(sourceDefinitions);
  const targetByKey = definitionMap(targetDefinitions);
  return references
    .map((reference) => {
      const key = `${reference.definitionType}:${reference.definitionId}`;
      const source = sourceByKey.get(key);
      const target = targetByKey.get(key);
      const targetDiffers = Boolean(source && target && source.fingerprint !== target.fingerprint);
      const action = legacyDefinitionAction(reference, Boolean(source), Boolean(target), targetDiffers);
      return {
        definitionType: reference.definitionType,
        definitionId: reference.definitionId,
        referenceCount: reference.referenceCount,
        sampleRunIds: reference.sampleRunIds,
        sampleStageIds: reference.sampleStageIds,
        sourceRegistry: source ? "present" as const : "missing" as const,
        targetRegistry: target ? "present" as const : "missing" as const,
        targetDiffers,
        snapshotAvailable: reference.snapshotAvailable,
        action,
        notes: legacyDefinitionNotes(reference, action)
      };
    })
    .filter((reference) => reference.action !== "already-current")
    .sort((a, b) => `${a.definitionType}:${a.definitionId}`.localeCompare(`${b.definitionType}:${b.definitionId}`));
}

function legacyDefinitionAction(
  reference: StorageMergeDefinitionReferenceRow,
  sourcePresent: boolean,
  targetPresent: boolean,
  targetDiffers: boolean
): StorageMergeLegacyDefinitionReference["action"] {
  if (sourcePresent && !targetPresent) return "insert-missing-registry";
  if (sourcePresent && targetPresent && targetDiffers) return "preserve-target-current";
  if (!sourcePresent && !targetPresent && !(reference.definitionType === "workflow" && reference.snapshotAvailable)) return "readability-warning";
  return "already-current";
}

function legacyDefinitionNotes(
  reference: StorageMergeDefinitionReferenceRow,
  action: StorageMergeLegacyDefinitionReference["action"]
): string[] {
  if (action === "insert-missing-registry") {
    return [`Source ${reference.definitionType} registry row will be inserted into the target only because the target does not already define this id.`];
  }
  if (action === "preserve-target-current") {
    return [`Source ${reference.definitionType} definition differs from the target; the importer preserves the current target definition and skips overwrite.`];
  }
  if (action === "readability-warning") {
    return [`Historical ${reference.definitionType} reference has no registry row in source or target; inspect stage outputs/artifacts if old run readability is needed.`];
  }
  return [];
}

function definitionMap(rows: StorageMergeDefinitionRow[]): Map<string, StorageMergeDefinitionRow> {
  return new Map(rows.map((row) => [`${row.definitionType}:${row.definitionId}`, row]));
}

interface ProjectConflictRow {
  projectId: string;
  name: string | null;
  rootUri: string;
  profile: string | null;
  config: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  linkedRows: Record<string, number>;
}

async function loadProjectConflictRows(client: pg.Client): Promise<ProjectConflictRow[]> {
  const exists = await tableExists(client, "projects");
  if (!exists) return [];
  const result = await client.query(`
    select
      p.id::text as project_id,
      p.name,
      p.root_uri,
      p.profile,
      p.config,
      p.created_at,
      p.updated_at,
      coalesce(pf.count, 0)::int as project_files,
      coalesce(pis.count, 0)::int as project_index_state,
      coalesce(wr.count, 0)::int as workflow_runs,
      coalesce(mi.count, 0)::int as memory_items
    from projects p
    left join (select project_id, count(*) from project_files group by project_id) pf on pf.project_id = p.id
    left join (select project_id, count(*) from project_index_state group by project_id) pis on pis.project_id = p.id
    left join (select project_id, count(*) from workflow_runs group by project_id) wr on wr.project_id = p.id
    left join (select project_id, count(*) from memory_items group by project_id) mi on mi.project_id = p.id
    order by p.root_uri
  `);
  return result.rows.map((row) => ({
    projectId: String(row.project_id),
    name: row.name ? String(row.name) : null,
    rootUri: String(row.root_uri),
    profile: row.profile ? String(row.profile) : null,
    config: objectRecord(row.config),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    linkedRows: {
      project_files: Number(row.project_files ?? 0),
      project_index_state: Number(row.project_index_state ?? 0),
      workflow_runs: Number(row.workflow_runs ?? 0),
      memory_items: Number(row.memory_items ?? 0)
    }
  }));
}

function buildProjectConflict(source: ProjectConflictRow, target: ProjectConflictRow, differingFields: string[]): StorageProjectConflict {
  const sourceUpdated = Date.parse(source.updatedAt ?? "");
  const targetUpdated = Date.parse(target.updatedAt ?? "");
  const sourceDurableRows = source.linkedRows.workflow_runs + source.linkedRows.memory_items;
  const targetDurableRows = target.linkedRows.workflow_runs + target.linkedRows.memory_items;
  const targetIsBetterDefault = targetDurableRows >= sourceDurableRows || Number.isNaN(sourceUpdated) || (!Number.isNaN(targetUpdated) && targetUpdated >= sourceUpdated);
  const recommendation = targetIsBetterDefault ? "prefer-target" : "manual-review";
  const action = recommendation === "prefer-target" ? "preserve-target-project" : "manual-project-review";
  return {
    rootUri: source.rootUri,
    recommendation,
    reason: recommendation === "prefer-target"
      ? "Target/shared storage has equal or stronger durable history signals, so preserve it unless an operator recognizes the source config as canonical."
      : "Source metadata is newer or has stronger signals; inspect both sides before choosing a canonical project record.",
    differingFields,
    source: projectConflictSide(source),
    target: projectConflictSide(target),
    decisionRecord: {
      action,
      rootUri: source.rootUri,
      sourceProjectId: source.projectId,
      targetProjectId: target.projectId,
      note: recommendation === "prefer-target"
        ? "Preserve shared target project record; source-only history already maps through root_uri."
        : "Manual review required before recording a canonical project choice."
    }
  };
}

function projectConflictSide(row: ProjectConflictRow): StorageProjectConflictSide {
  return {
    projectId: row.projectId,
    name: row.name,
    profile: row.profile,
    configHash: hashValue(stableStringify(row.config)),
    configPreview: redactConfigPreview(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    linkedRows: row.linkedRows
  };
}

function projectDifferingFields(source: ProjectConflictRow, target: ProjectConflictRow): string[] {
  const fields: string[] = [];
  if (source.projectId !== target.projectId) fields.push("project_id");
  if (source.name !== target.name) fields.push("name");
  if (source.profile !== target.profile) fields.push("profile");
  if (stableStringify(source.config) !== stableStringify(target.config)) fields.push("config");
  return fields;
}

function redactConfigPreview(value: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (/key|secret|token|password|credential/i.test(key)) {
      preview[key] = "[redacted]";
    } else if (typeof raw === "string") {
      preview[key] = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
    } else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      preview[key] = raw;
    } else if (Array.isArray(raw)) {
      preview[key] = `[array:${raw.length}]`;
    } else if (typeof raw === "object") {
      preview[key] = "[object]";
    }
  }
  return preview;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
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
  const sampleSourceKeys = sourceRows
    .map((row) => printableKey(row.key))
    .slice(0, 10);
  const sampleExistingKeys = sourceRows
    .filter((row) => targetByKey.has(row.key))
    .map((row) => printableKey(row.key))
    .slice(0, 10);
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
    sampleSourceKeys,
    sampleExistingKeys,
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
    sampleSourceKeys: [],
    sampleExistingKeys: [],
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

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

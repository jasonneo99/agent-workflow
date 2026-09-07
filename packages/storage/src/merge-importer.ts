import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { buildStorageMergeManifest, type StorageMergeManifest } from "./merge-manifest.js";

const { Client } = pg;

export interface StorageMergeImportInput {
  manifestPath: string;
  sourceDatabaseUrl?: string;
  targetDatabaseUrl?: string;
  execute?: boolean;
  allowStaleManifest?: boolean;
  backupDir?: string;
}

export interface StorageMergeImportResult {
  kind: "agentflow_storage_merge_import_result";
  generatedAt: string;
  mode: "dry-run" | "execute";
  status: "ready" | "completed" | "blocked";
  manifestPath: string;
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  reviewedManifestGeneratedAt: string;
  staleManifest: boolean;
  backup: StorageMergeBackupResult | null;
  operations: StorageMergeImportOperation[];
  warnings: string[];
  notes: string[];
}

export interface StorageMergeBackupResult {
  directory: string;
  sourcePath: string;
  targetPath: string;
  rollbackInstructions: string[];
}

export interface StorageMergeImportOperation {
  table: string;
  action: "insert-missing" | "insert-source-only" | "skip-existing";
  candidateRows: number;
  affectedRows: number;
  notes: string[];
}

export async function runStorageMergeImport(input: StorageMergeImportInput): Promise<StorageMergeImportResult> {
  const reviewedManifest = await readManifest(input.manifestPath);
  const sourceDatabaseUrl = input.sourceDatabaseUrl ?? unredactedUrlFromEnv("SOURCE_DATABASE_URL", "DATABASE_URL");
  const targetDatabaseUrl = input.targetDatabaseUrl ?? process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!sourceDatabaseUrl || !targetDatabaseUrl) {
    return blockedResult(input, reviewedManifest, sourceDatabaseUrl, targetDatabaseUrl, ["source and target database URLs are required"]);
  }
  if (canonicalUrl(sourceDatabaseUrl) === canonicalUrl(targetDatabaseUrl)) {
    return blockedResult(input, reviewedManifest, sourceDatabaseUrl, targetDatabaseUrl, ["source and target database URLs point to the same endpoint"]);
  }

  const liveManifest = await buildStorageMergeManifest({ sourceDatabaseUrl, targetDatabaseUrl });
  const staleManifest = manifestSignature(reviewedManifest) !== manifestSignature(liveManifest);
  if (staleManifest && !input.allowStaleManifest) {
    return blockedResult(input, reviewedManifest, sourceDatabaseUrl, targetDatabaseUrl, [
      "reviewed manifest is stale compared with current source/target storage; regenerate it or pass --allow-stale-manifest"
    ], true);
  }

  const backup = input.execute
    ? await createStorageMergeBackups({
        sourceDatabaseUrl,
        targetDatabaseUrl,
        backupDir: input.backupDir ?? path.dirname(input.manifestPath)
      }).catch((error) => error instanceof Error ? error : new Error(String(error)))
    : null;
  if (backup instanceof Error) {
    return blockedResult(input, reviewedManifest, sourceDatabaseUrl, targetDatabaseUrl, [
      `database backup failed before merge import: ${backup.message}`
    ], staleManifest);
  }

  const sourceClient = new Client({ connectionString: sourceDatabaseUrl });
  const targetClient = new Client({ connectionString: targetDatabaseUrl });
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  try {
    const operations = input.execute
      ? await executeImport(sourceClient, targetClient)
      : await dryRunImport(sourceClient, targetClient);
    return {
      kind: "agentflow_storage_merge_import_result",
      generatedAt: new Date().toISOString(),
      mode: input.execute ? "execute" : "dry-run",
      status: input.execute ? "completed" : "ready",
      manifestPath: input.manifestPath,
      sourceDatabaseUrl: redactUrl(sourceDatabaseUrl),
      targetDatabaseUrl: redactUrl(targetDatabaseUrl),
      reviewedManifestGeneratedAt: reviewedManifest.generatedAt,
      staleManifest,
      backup,
      operations,
      warnings: liveManifest.warnings,
      notes: [
        input.execute
          ? "Source and target Postgres backups were created before the merge importer executed inside a target database transaction with insert-only conflict handling."
          : "Dry-run only. No source or target rows were inserted, updated, deleted, or overwritten.",
        "Existing target rows and conflicting project/index rows are skipped by design.",
        "Historical source-only runs, tasks, receipts, approvals, artifacts, and memory are imported with project ids rewritten through root_uri where needed.",
        legacyDefinitionImportNote(liveManifest)
      ]
    };
  } finally {
    await Promise.allSettled([sourceClient.end(), targetClient.end()]);
  }
}

export function formatStorageMergeImportResult(result: StorageMergeImportResult): string {
  return [
    `Shared storage merge import ${result.mode} (${result.generatedAt})`,
    `Status: ${result.status}`,
    "",
    `Manifest: ${result.manifestPath}`,
    `Reviewed manifest: ${result.reviewedManifestGeneratedAt}`,
    `Stale manifest: ${result.staleManifest ? "yes" : "no"}`,
    "",
    "Source:",
    `- Database: ${result.sourceDatabaseUrl}`,
    "",
    "Target:",
    `- Database: ${result.targetDatabaseUrl}`,
    "",
    "Backups:",
    ...(result.backup ? [
      `- Directory: ${result.backup.directory}`,
      `- Source: ${result.backup.sourcePath}`,
      `- Target: ${result.backup.targetPath}`,
      ...result.backup.rollbackInstructions.map((instruction) => `- ${instruction}`)
    ] : ["- none; execute mode creates source and target backups before writing."]),
    "",
    "Operations:",
    ...result.operations.map((operation) => `- ${operation.table}: ${operation.action}, candidates=${operation.candidateRows}, ${result.mode === "execute" ? "inserted" : "would insert"}=${operation.affectedRows}`),
    "",
    "Warnings:",
    ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Notes:",
    ...result.notes.map((note) => `- ${note}`)
  ].join("\n");
}

async function createStorageMergeBackups(input: {
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  backupDir: string;
}): Promise<StorageMergeBackupResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.resolve(input.backupDir, `storage-merge-backup-${stamp}`);
  await fs.mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, "source-before-merge.dump");
  const targetPath = path.join(directory, "target-before-merge.dump");
  await dumpPostgresDatabase(input.sourceDatabaseUrl, sourcePath);
  await dumpPostgresDatabase(input.targetDatabaseUrl, targetPath);
  await fs.writeFile(path.join(directory, "ROLLBACK.md"), [
    "# Storage Merge Rollback",
    "",
    "These backups were created before an insert-only Agent Workflow shared-storage merge import.",
    "",
    "Rollback options:",
    "",
    `- Restore source database: pg_restore --clean --if-exists --dbname <source-database-url> ${shellSafePath(sourcePath)}`,
    `- Restore target database: pg_restore --clean --if-exists --dbname <target-database-url> ${shellSafePath(targetPath)}`,
    "- Review merge import JSON before restoring; the importer is insert-only, so targeted cleanup may be enough when only duplicated evidence was inserted.",
    "- Keep these dump files private because database backups may contain project names, paths, run metadata, artifacts, and approval history."
  ].join("\n"), "utf8");
  return {
    directory,
    sourcePath,
    targetPath,
    rollbackInstructions: [
      `Restore source with pg_restore --clean --if-exists --dbname <source-database-url> ${shellSafePath(sourcePath)}`,
      `Restore target with pg_restore --clean --if-exists --dbname <target-database-url> ${shellSafePath(targetPath)}`,
      "Keep dump files private; they may contain project metadata and workflow history."
    ]
  };
}

async function dumpPostgresDatabase(databaseUrl: string, outPath: string): Promise<void> {
  const parsed = new URL(databaseUrl);
  const args = [
    "--format=custom",
    "--file", outPath,
    "--host", parsed.hostname,
    "--port", parsed.port || "5432",
    "--username", decodeURIComponent(parsed.username),
    "--dbname", decodeURIComponent(parsed.pathname.replace(/^\//, ""))
  ];
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? "10"
  };
  try {
    await runBackupCommand("pg_dump", args, env);
  } catch (error) {
    if (!isMissingExecutableError(error)) throw error;
    await dumpPostgresDatabaseWithDocker(parsed, outPath, env);
  }
}

async function runBackupCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? "unknown"}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

async function dumpPostgresDatabaseWithDocker(parsed: URL, outPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const outDir = path.dirname(outPath);
  const outName = path.basename(outPath);
  const dockerHost = dockerReachableHost(parsed.hostname);
  const image = process.env.AGENTFLOW_PGDUMP_DOCKER_IMAGE ?? "pgvector/pgvector:pg16";
  const args = [
    "run",
    "--rm",
    "--volume", `${outDir}:/backup`,
    "--env", "PGPASSWORD",
    "--env", "PGCONNECT_TIMEOUT",
    image,
    "pg_dump",
    "--format=custom",
    "--file", `/backup/${outName}`,
    "--host", dockerHost,
    "--port", parsed.port || "5432",
    "--username", decodeURIComponent(parsed.username),
    "--dbname", decodeURIComponent(parsed.pathname.replace(/^\//, ""))
  ];
  await runBackupCommand("docker", args, env).catch((error) => {
    if (isMissingExecutableError(error)) {
      throw new Error("pg_dump is not installed and Docker is not available for the backup fallback");
    }
    throw error;
  });
}

function dockerReachableHost(hostname: string): string {
  return hostname === "127.0.0.1" || hostname === "localhost" ? "host.docker.internal" : hostname;
}

function isMissingExecutableError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function shellSafePath(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

async function dryRunImport(sourceClient: pg.Client, targetClient: pg.Client): Promise<StorageMergeImportOperation[]> {
  return [
    operation("agents", "insert-missing", await countMissingRegistry(sourceClient, targetClient, "agents")),
    operation("workflows", "insert-missing", await countMissingRegistry(sourceClient, targetClient, "workflows")),
    operation("projects", "insert-source-only", await countSourceOnlyProjects(sourceClient, targetClient)),
    operation("project_files", "insert-source-only", await countSourceOnlyProjectFiles(sourceClient, targetClient)),
    operation("project_index_state", "insert-source-only", await countSourceOnlyProjectIndexState(sourceClient, targetClient)),
    operation("memory_items", "insert-source-only", await countSourceOnlyMemoryItems(sourceClient, targetClient)),
    operation("workflow_runs", "insert-source-only", await countMissingById(sourceClient, targetClient, "workflow_runs")),
    operation("workflow_tasks", "insert-source-only", await countMissingById(sourceClient, targetClient, "workflow_tasks")),
    operation("action_receipts", "insert-source-only", await countMissingById(sourceClient, targetClient, "action_receipts")),
    operation("action_approvals", "insert-source-only", await countMissingById(sourceClient, targetClient, "action_approvals")),
    operation("artifacts", "insert-source-only", await countMissingByUri(sourceClient, targetClient, "artifacts"))
  ];
}

async function executeImport(sourceClient: pg.Client, targetClient: pg.Client): Promise<StorageMergeImportOperation[]> {
  await targetClient.query("begin");
  try {
    const operations: StorageMergeImportOperation[] = [];
    operations.push(operation("agents", "insert-missing", await countMissingRegistry(sourceClient, targetClient, "agents"), await importAgents(sourceClient, targetClient)));
    operations.push(operation("workflows", "insert-missing", await countMissingRegistry(sourceClient, targetClient, "workflows"), await importWorkflows(sourceClient, targetClient)));
    operations.push(operation("projects", "insert-source-only", await countSourceOnlyProjects(sourceClient, targetClient), await importProjects(sourceClient, targetClient)));
    operations.push(operation("project_files", "insert-source-only", await countSourceOnlyProjectFiles(sourceClient, targetClient), await importProjectFiles(sourceClient, targetClient)));
    operations.push(operation("project_index_state", "insert-source-only", await countSourceOnlyProjectIndexState(sourceClient, targetClient), await importProjectIndexState(sourceClient, targetClient)));
    operations.push(operation("memory_items", "insert-source-only", await countSourceOnlyMemoryItems(sourceClient, targetClient), await importMemoryItems(sourceClient, targetClient)));
    operations.push(operation("workflow_runs", "insert-source-only", await countMissingById(sourceClient, targetClient, "workflow_runs"), await importWorkflowRuns(sourceClient, targetClient)));
    operations.push(operation("workflow_tasks", "insert-source-only", await countMissingById(sourceClient, targetClient, "workflow_tasks"), await importWorkflowTasks(sourceClient, targetClient)));
    operations.push(operation("action_receipts", "insert-source-only", await countMissingById(sourceClient, targetClient, "action_receipts"), await importActionReceipts(sourceClient, targetClient)));
    operations.push(operation("action_approvals", "insert-source-only", await countMissingById(sourceClient, targetClient, "action_approvals"), await importActionApprovals(sourceClient, targetClient)));
    operations.push(operation("artifacts", "insert-source-only", await countMissingByUri(sourceClient, targetClient, "artifacts"), await importArtifacts(sourceClient, targetClient)));
    await targetClient.query("commit");
    return operations;
  } catch (error) {
    await targetClient.query("rollback");
    throw error;
  }
}

async function importAgents(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query("select id, display_name, category, source_path, definition, updated_at from agents order by id")).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into agents (id, display_name, category, source_path, definition, updated_at)
      values ($1, $2, $3, $4, $5, $6) on conflict do nothing`, [
      row.id, row.display_name, row.category, row.source_path, row.definition, row.updated_at
    ]);
  }
  return inserted;
}

async function importWorkflows(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query("select id, name, source_path, definition, updated_at from workflows order by id")).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into workflows (id, name, source_path, definition, updated_at)
      values ($1, $2, $3, $4, $5) on conflict do nothing`, [
      row.id, row.name, row.source_path, row.definition, row.updated_at
    ]);
  }
  return inserted;
}

async function importProjects(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const targetRoots = await targetProjectRoots(targetClient);
  const rows = (await sourceClient.query("select id, name, root_uri, profile, config, created_at, updated_at from projects order by created_at")).rows;
  let inserted = 0;
  for (const row of rows.filter((item) => !targetRoots.has(item.root_uri))) {
    inserted += await exec(targetClient, `insert into projects (id, name, root_uri, profile, config, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`, [
      row.id, row.name, row.root_uri, row.profile, row.config, row.created_at, row.updated_at
    ]);
  }
  return inserted;
}

async function importProjectFiles(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const projectIds = await projectIdMap(sourceClient, targetClient);
  const rows = (await sourceClient.query(`select pf.source_uri, pf.content_hash, pf.token_estimate, pf.summary, pf.metadata, pf.created_at, pf.updated_at, p.root_uri
    from project_files pf join projects p on p.id = pf.project_id order by pf.created_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    const targetProjectId = projectIds.get(row.root_uri);
    if (!targetProjectId) continue;
    inserted += await exec(targetClient, `insert into project_files (project_id, source_uri, content_hash, token_estimate, summary, metadata, created_at, updated_at)
      values ($1::uuid, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`, [
      targetProjectId, row.source_uri, row.content_hash, row.token_estimate, row.summary, row.metadata, row.created_at, row.updated_at
    ]);
  }
  return inserted;
}

async function importProjectIndexState(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const projectIds = await projectIdMap(sourceClient, targetClient);
  const rows = (await sourceClient.query(`select pis.head_commit, pis.indexed_files, pis.deleted_files, pis.metadata, pis.updated_at, p.root_uri
    from project_index_state pis join projects p on p.id = pis.project_id order by pis.updated_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    const targetProjectId = projectIds.get(row.root_uri);
    if (!targetProjectId) continue;
    inserted += await exec(targetClient, `insert into project_index_state (project_id, head_commit, indexed_files, deleted_files, metadata, updated_at)
      values ($1::uuid, $2, $3, $4, $5, $6) on conflict do nothing`, [
      targetProjectId, row.head_commit, row.indexed_files, row.deleted_files, row.metadata, row.updated_at
    ]);
  }
  return inserted;
}

async function importMemoryItems(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const projectIds = await projectIdMap(sourceClient, targetClient);
  const rows = (await sourceClient.query(`select mi.source_uri, mi.content_hash, mi.summary, mi.embedding::text as embedding, mi.metadata, mi.created_at, mi.updated_at, p.root_uri
    from memory_items mi join projects p on p.id = mi.project_id order by mi.created_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    const targetProjectId = projectIds.get(row.root_uri);
    if (!targetProjectId) continue;
    inserted += await exec(targetClient, `insert into memory_items (project_id, source_uri, content_hash, summary, embedding, metadata, created_at, updated_at)
      values ($1::uuid, $2, $3, $4, $5::vector, $6, $7, $8) on conflict do nothing`, [
      targetProjectId, row.source_uri, row.content_hash, row.summary, row.embedding, row.metadata, row.created_at, row.updated_at
    ]);
  }
  return inserted;
}

async function importWorkflowRuns(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const projectIds = await projectIdMap(sourceClient, targetClient);
  const rows = (await sourceClient.query(`select wr.*, p.root_uri
    from workflow_runs wr left join projects p on p.id = wr.project_id order by wr.started_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    const targetProjectId = row.root_uri ? projectIds.get(row.root_uri) : row.project_id;
    inserted += await exec(targetClient, `insert into workflow_runs (
      id, project_id, workflow_id, status, task, autonomy, policy_profile, policy_snapshot, policy_snapshot_hash,
      model_tier_override, provider_override, evaluation_metadata, workflow_snapshot, compiled_brief_uri, started_at, finished_at
    ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) on conflict do nothing`, [
      row.id, targetProjectId, row.workflow_id, row.status, row.task, row.autonomy, row.policy_profile, row.policy_snapshot, row.policy_snapshot_hash,
      row.model_tier_override, row.provider_override, row.evaluation_metadata, row.workflow_snapshot, row.compiled_brief_uri, row.started_at, row.finished_at
    ]);
  }
  return inserted;
}

async function importWorkflowTasks(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query(`select id, run_id, stage_id, agent_id, status, input_uri, output_uri, attempts, idempotency_key, worker_id, lease_expires_at, available_at, started_at, finished_at
    from workflow_tasks order by available_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into workflow_tasks (
      id, run_id, stage_id, agent_id, status, input_uri, output_uri, attempts, idempotency_key,
      worker_id, lease_expires_at, available_at, started_at, finished_at
    ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) on conflict do nothing`, [
      row.id, row.run_id, row.stage_id, row.agent_id, row.status, row.input_uri, row.output_uri, row.attempts, row.idempotency_key,
      row.worker_id, row.lease_expires_at, row.available_at, row.started_at, row.finished_at
    ]);
  }
  return inserted;
}

async function importActionReceipts(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query("select id, run_id, agent_id, action_type, target, summary, metadata, created_at from action_receipts order by created_at")).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into action_receipts (id, run_id, agent_id, action_type, target, summary, metadata, created_at)
      values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8) on conflict do nothing`, [
      row.id, row.run_id, row.agent_id, row.action_type, row.target, row.summary, row.metadata, row.created_at
    ]);
  }
  return inserted;
}

async function importActionApprovals(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query(`select id, run_id, task_id, stage_id, agent_id, action_type, target, status, rationale, policy_decision, payload, idempotency_key,
    decided_by, decided_role, decided_at, executed_by, executed_role, executed_at, decision_note, created_at, updated_at
    from action_approvals order by created_at`)).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into action_approvals (
      id, run_id, task_id, stage_id, agent_id, action_type, target, status, rationale, policy_decision, payload, idempotency_key,
      decided_by, decided_role, decided_at, executed_by, executed_role, executed_at, decision_note, created_at, updated_at
    ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) on conflict do nothing`, [
      row.id, row.run_id, row.task_id, row.stage_id, row.agent_id, row.action_type, row.target, row.status, row.rationale, row.policy_decision, row.payload, row.idempotency_key,
      row.decided_by, row.decided_role, row.decided_at, row.executed_by, row.executed_role, row.executed_at, row.decision_note, row.created_at, row.updated_at
    ]);
  }
  return inserted;
}

async function importArtifacts(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const rows = (await sourceClient.query("select id, run_id, task_id, kind, uri, content, created_at from artifacts order by created_at")).rows;
  let inserted = 0;
  for (const row of rows) {
    inserted += await exec(targetClient, `insert into artifacts (id, run_id, task_id, kind, uri, content, created_at)
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7) on conflict do nothing`, [
      row.id, row.run_id, row.task_id, row.kind, row.uri, row.content, row.created_at
    ]);
  }
  return inserted;
}

async function countMissingRegistry(sourceClient: pg.Client, targetClient: pg.Client, table: "agents" | "workflows"): Promise<number> {
  const sourceIds = new Set((await sourceClient.query(`select id from ${table}`)).rows.map((row) => row.id));
  const targetIds = new Set((await targetClient.query(`select id from ${table}`)).rows.map((row) => row.id));
  return [...sourceIds].filter((id) => !targetIds.has(id)).length;
}

async function countMissingById(sourceClient: pg.Client, targetClient: pg.Client, table: string): Promise<number> {
  const sourceIds = new Set((await sourceClient.query(`select id::text from ${table}`)).rows.map((row) => row.id));
  const targetIds = new Set((await targetClient.query(`select id::text from ${table}`)).rows.map((row) => row.id));
  return [...sourceIds].filter((id) => !targetIds.has(id)).length;
}

async function countMissingByUri(sourceClient: pg.Client, targetClient: pg.Client, table: "artifacts"): Promise<number> {
  const sourceIds = new Set((await sourceClient.query(`select uri from ${table}`)).rows.map((row) => row.uri));
  const targetIds = new Set((await targetClient.query(`select uri from ${table}`)).rows.map((row) => row.uri));
  return [...sourceIds].filter((id) => !targetIds.has(id)).length;
}

async function countSourceOnlyProjects(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const sourceRoots = new Set((await sourceClient.query("select root_uri from projects")).rows.map((row) => row.root_uri));
  const targetRoots = await targetProjectRoots(targetClient);
  return [...sourceRoots].filter((root) => !targetRoots.has(root)).length;
}

async function countSourceOnlyProjectFiles(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const sourceKeys = new Set((await sourceClient.query("select p.root_uri || chr(31) || pf.source_uri as key from project_files pf join projects p on p.id = pf.project_id")).rows.map((row) => row.key));
  const targetKeys = new Set((await targetClient.query("select p.root_uri || chr(31) || pf.source_uri as key from project_files pf join projects p on p.id = pf.project_id")).rows.map((row) => row.key));
  return [...sourceKeys].filter((key) => !targetKeys.has(key)).length;
}

async function countSourceOnlyProjectIndexState(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const sourceKeys = new Set((await sourceClient.query("select p.root_uri as key from project_index_state pis join projects p on p.id = pis.project_id")).rows.map((row) => row.key));
  const targetKeys = new Set((await targetClient.query("select p.root_uri as key from project_index_state pis join projects p on p.id = pis.project_id")).rows.map((row) => row.key));
  return [...sourceKeys].filter((key) => !targetKeys.has(key)).length;
}

async function countSourceOnlyMemoryItems(sourceClient: pg.Client, targetClient: pg.Client): Promise<number> {
  const sourceKeys = new Set((await sourceClient.query("select p.root_uri || chr(31) || mi.source_uri || chr(31) || mi.content_hash as key from memory_items mi join projects p on p.id = mi.project_id")).rows.map((row) => row.key));
  const targetKeys = new Set((await targetClient.query("select p.root_uri || chr(31) || mi.source_uri || chr(31) || mi.content_hash as key from memory_items mi join projects p on p.id = mi.project_id")).rows.map((row) => row.key));
  return [...sourceKeys].filter((key) => !targetKeys.has(key)).length;
}

async function targetProjectRoots(targetClient: pg.Client): Promise<Set<string>> {
  return new Set((await targetClient.query("select root_uri from projects")).rows.map((row) => row.root_uri));
}

async function projectIdMap(sourceClient: pg.Client, targetClient: pg.Client): Promise<Map<string, string>> {
  const sourceProjects = (await sourceClient.query("select id::text, root_uri from projects")).rows;
  const targetProjects = (await targetClient.query("select id::text, root_uri from projects")).rows;
  const map = new Map(sourceProjects.map((project) => [project.root_uri, project.id]));
  for (const project of targetProjects) {
    map.set(project.root_uri, project.id);
  }
  return map;
}

function operation(table: string, action: StorageMergeImportOperation["action"], candidateRows: number, affectedRows = candidateRows): StorageMergeImportOperation {
  return {
    table,
    action,
    candidateRows,
    affectedRows,
    notes: [
      action === "skip-existing"
        ? "Existing target rows are left unchanged."
        : "Uses insert-only conflict handling; existing target rows are not overwritten."
    ]
  };
}

async function exec(client: pg.Client, query: string, values: unknown[]): Promise<number> {
  const result = await client.query(query, values);
  return result.rowCount ?? 0;
}

async function readManifest(manifestPath: string): Promise<StorageMergeManifest> {
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as StorageMergeManifest;
  if (parsed.kind !== "agentflow_storage_merge_manifest") {
    throw new Error(`Not an Agent Workflow storage merge manifest: ${manifestPath}`);
  }
  return parsed;
}

function blockedResult(
  input: StorageMergeImportInput,
  manifest: StorageMergeManifest,
  sourceDatabaseUrl: string | undefined,
  targetDatabaseUrl: string | undefined,
  warnings: string[],
  staleManifest = false
): StorageMergeImportResult {
  return {
    kind: "agentflow_storage_merge_import_result",
    generatedAt: new Date().toISOString(),
    mode: input.execute ? "execute" : "dry-run",
    status: "blocked",
    manifestPath: input.manifestPath,
    sourceDatabaseUrl: sourceDatabaseUrl ? redactUrl(sourceDatabaseUrl) : "missing",
    targetDatabaseUrl: targetDatabaseUrl ? redactUrl(targetDatabaseUrl) : "missing",
    reviewedManifestGeneratedAt: manifest.generatedAt,
    staleManifest,
    backup: null,
    operations: [],
    warnings,
    notes: ["No source or target rows were inserted, updated, deleted, or overwritten."]
  };
}

function manifestSignature(manifest: StorageMergeManifest): string {
  return JSON.stringify({
    projects: manifest.projectMappings.map((mapping) => [mapping.rootUri, mapping.action]),
    tables: manifest.tablePlans.map((plan) => [plan.table, plan.sourceRows, plan.targetRows, plan.insertRows, plan.existingRows, plan.conflictRows, plan.projectIdRewriteRows]),
    legacyDefinitions: (manifest.legacyDefinitionReferences ?? []).map((reference) => [
      reference.definitionType,
      reference.definitionId,
      reference.action,
      reference.referenceCount,
      reference.sourceRegistry,
      reference.targetRegistry,
      reference.targetDiffers
    ])
  });
}

function legacyDefinitionImportNote(manifest: StorageMergeManifest): string {
  const references = manifest.legacyDefinitionReferences ?? [];
  if (!references.length) {
    return "No historical runs or tasks reference missing or changed agent/workflow registry definitions.";
  }
  const insertable = references.filter((reference) => reference.action === "insert-missing-registry").length;
  const preserved = references.filter((reference) => reference.action === "preserve-target-current").length;
  const warnings = references.filter((reference) => reference.action === "readability-warning").length;
  return [
    `Legacy definition references reviewed: ${references.length}.`,
    insertable ? `${insertable} missing registry definition(s) are insert-only candidates.` : "",
    preserved ? `${preserved} changed definition(s) keep the current target registry definition.` : "",
    warnings ? `${warnings} unresolved historical reference(s) require artifact/stage-output inspection for readability.` : ""
  ].filter(Boolean).join(" ");
}

function unredactedUrlFromEnv(primary: string, fallback: string): string | undefined {
  return process.env[primary] ?? process.env[fallback];
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

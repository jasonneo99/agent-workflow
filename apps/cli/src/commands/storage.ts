import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { ObjectArtifactProofReport, OfflineFallbackReport, OfflineSyncSchedulerStatus, StorageMergeEvidenceListing } from "../lib/cli-types.js";
import { parseOfflineFallbackQueueAction, runDaemonOfflineSyncScheduler, runOfflineFallbackSync, writeStorageMergeImportResultFiles, writeStorageMergeManifestFiles } from "../lib/builders-learning.js";
import { formatIndexResult } from "../lib/builders-runs.js";
import { compactDashboardText, formatBytes, indexProjectWithStorage, normalizeActorRole, sleep } from "../lib/builders-shared.js";
import { buildObjectArtifactProofReport, execMcText, formatOfflineFallbackQueue, formatOfflineFallbackSyncResult, loadOfflineFallbackReport, loadStorageMergeEvidenceListing, markOfflineFallbackQueueItemSynced, queueObjectMirrorApproval, recordOfflineFallbackQueueItem, resolveMcRunner, writeStorageProjectConflictDecision } from "../lib/builders-storage.js";
import { loadAgentRecords, loadProjectConfig, loadWorkflowRecords } from "../../../../packages/agent-registry/src/loaders.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { formatStorageMergeImportResult, runStorageMergeImport } from "../../../../packages/storage/src/merge-importer.js";
import { type StorageProjectConflictReport, buildStorageMergeManifest, buildStorageProjectConflictReport, formatStorageMergeManifest } from "../../../../packages/storage/src/merge-manifest.js";
import { type StorageMigrationPlan, buildStorageMigrationPlan, formatStorageMigrationPlan, storageMigrationScript } from "../../../../packages/storage/src/migration-plan.js";
import { getProjectIndexState, migrateStorage, resetStorage, seedRegistry, upsertProject } from "../../../../packages/storage/src/postgres.js";
import { buildStorageVerificationReport, formatStorageVerificationReport } from "../../../../packages/storage/src/verification.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { normalizeLookup } from "../reference-resolution.js";
import fs from "node:fs/promises";
import path from "node:path";

export function registerStorageCommands(program: Command, ctx: CliContext): void {
  async function ensureObjectStorageBucket(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
    const bucket = process.env.OBJECT_STORAGE_BUCKET || "agentflow-artifacts";
    const accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY;
    const secretKey = process.env.OBJECT_STORAGE_SECRET_KEY;
    if (!endpoint || !accessKey || !secretKey) {
      return { ok: false, message: "Object storage bucket was not checked because endpoint or credentials are not configured." };
    }
    const mcConfigDir = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mc-bootstrap");
    await fs.mkdir(mcConfigDir, { recursive: true, mode: 0o700 });
    const runner = await resolveMcRunner(ctx, mcConfigDir);
    if (!runner) {
      return { ok: false, message: `Object storage bucket ${bucket} was not checked because MinIO Client and Docker minio/mc fallback are unavailable.` };
    }
    const alias = "agentflow-bootstrap";
    const aliasResult = await execMcText(ctx, runner, ["alias", "set", alias, runner.mapEndpoint(endpoint), accessKey, secretKey]);
    if (aliasResult.exitCode !== 0) {
      return { ok: false, message: compactDashboardText(aliasResult.stderr || aliasResult.stdout || `${runner.mode} alias setup failed for object storage bootstrap`, 300) };
    }
    const bucketResult = await execMcText(ctx, runner, ["mb", "--ignore-existing", `${alias}/${bucket}`]);
    if (bucketResult.exitCode !== 0) {
      return { ok: false, message: compactDashboardText(bucketResult.stderr || bucketResult.stdout || `${runner.mode} bucket creation failed for ${bucket}`, 300) };
    }
    return { ok: true, message: `Object storage bucket ${bucket} is present via ${runner.mode}.` };
  }

  function formatObjectArtifactProofReport(report: ObjectArtifactProofReport): string {
    return [
      `Object artifact proof (${report.generatedAt})`,
      `Status: ${report.status}`,
      `Project: ${report.projectRootUri ?? "all projects"}`,
      `Endpoint: ${report.endpoint}`,
      `Bucket: ${report.bucket}`,
      `Inspected artifacts: ${report.inspectedArtifacts}`,
      `Referenced objects: ${report.referencedObjects}`,
      `Verified objects: ${report.verifiedObjects}`,
      `Missing objects: ${report.missingObjects}`,
      `Verification: ${report.verification}`,
      "",
      "Bucket parity:",
      report.bucketParity
        ? `- ${report.bucketParity.status}: source=${report.bucketParity.sourceObjects}, target=${report.bucketParity.targetObjects}, missing=${report.bucketParity.missingInTarget}, extra=${report.bucketParity.extraInTarget}, verifier=${report.bucketParity.verifier}\n- ${report.bucketParity.message}`
        : "- not checked",
      "",
      "Objects:",
      ...(report.objects.length ? report.objects.slice(0, 20).map((item) => `- ${item.status} ${item.key} (${item.artifactKind} ${item.artifactUri})`) : ["- none"]),
      "",
      "Warnings:",
      ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ["- none"]),
      "",
      "Recommendations:",
      ...(report.recommendations.length ? report.recommendations.map((item) => `- ${item}`) : ["- none"])
    ].join("\n");
  }

  function formatOfflineFallbackReport(report: OfflineFallbackReport): string {
    const pendingItems = report.queue.items.filter((item) => item.status === "pending");
    return [
      `Offline fallback (${report.generatedAt})`,
      `Mode: ${report.mode}`,
      `Configured storage reachable: ${report.currentServicesReachable ? "yes" : "no"}`,
      `Local fallback reachable: ${report.localServicesReachable ? "yes" : "no"}`,
      `Pending sync queue items: ${pendingItems.length}`,
      `Scheduler: ${report.scheduler.status} (${report.scheduler.message})`,
      "",
      "Configured storage:",
      ...report.currentServices.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
      "",
      "Local fallback:",
      ...report.localServices.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
      "",
      "Commands:",
      `- Stop local fallback: ${report.commands.stopLocal}`,
      `- Start local fallback: ${report.commands.startLocal}`,
      ...report.commands.syncBack.map((command) => `- Sync back: ${command}`),
      "",
      "Sync queue:",
      ...(pendingItems.length ? pendingItems.map((item) => `- ${item.id}: ${item.action}${item.projectRootUri ? ` ${item.projectRootUri}` : ""}${item.runId ? ` run=${item.runId}` : ""}`) : ["- none"]),
      "",
      "Notes:",
      ...report.notes.map((note) => `- ${note}`)
    ].join("\n");
  }

  function formatOfflineSyncSchedulerStatus(status: OfflineSyncSchedulerStatus): string {
    return [
      `Offline sync scheduler (${status.updatedAt})`,
      `Status: ${status.status}`,
      `Pending queue items: ${status.pendingQueueItems}`,
      `Last run: ${status.lastRunAt ?? "none"}`,
      `Next run after: ${status.nextRunAfter ?? "n/a"}`,
      `Last result: ${status.lastResultPath ?? "none"}`,
      `Message: ${status.message}`
    ].join("\n");
  }

  function formatStorageMergeEvidenceListing(report: StorageMergeEvidenceListing): string {
    return [
      `Storage merge evidence (${report.generatedAt})`,
      `Directory: ${report.directory}`,
      `Primary shared state: ${report.safePrimaryStatePlane ? "proven" : "attention"}`,
      "",
      "Latest manifest:",
      report.latestManifest
        ? `- ${report.latestManifest.generatedAt}: source-only=${report.latestManifest.sourceOnlyRows}, conflicts=${report.latestManifest.conflictRows}, project-id rewrites=${report.latestManifest.projectIdRewriteRows}\n  ${report.latestManifest.jsonPath}`
        : "- none",
      "",
      "Latest import:",
      report.latestImport
        ? `- ${report.latestImport.generatedAt}: ${report.latestImport.status} ${report.latestImport.mode}, affected=${report.latestImport.affectedRows}, stale=${report.latestImport.staleManifest ? "yes" : "no"}\n  ${report.latestImport.jsonPath}`
        : "- none",
      "",
      "Latest backup:",
      report.latestBackup
        ? `- ${report.latestBackup.generatedAt ?? "unknown"}: ${report.latestBackup.path}\n${report.latestBackup.files.map((file) => `  - ${file.name}: ${formatBytes(file.sizeBytes)}`).join("\n")}`
        : "- none",
      "",
      "Latest object proof:",
      report.latestObjectProof
        ? `- ${report.latestObjectProof.generatedAt}: ${report.latestObjectProof.status}, refs=${report.latestObjectProof.referencedObjects}, verified=${report.latestObjectProof.verifiedObjects}, missing=${report.latestObjectProof.missingObjects}, bucket=${report.latestObjectProof.bucketParityStatus ?? "not checked"}\n  ${report.latestObjectProof.jsonPath}`
        : "- none",
      "",
      "Switch-over proof:",
      `- Status: ${report.switchOverProof.status}`,
      ...report.switchOverProof.checks.map((check) => `- ${check.status}: ${check.label} - ${check.detail}`),
      "",
      "Conflict classification:",
      `- Critical rows: ${report.conflictClassification.criticalRows}`,
      `- Refreshable derived rows: ${report.conflictClassification.derivedRows}`,
      ...(report.conflictClassification.rows.length
        ? report.conflictClassification.rows.map((row) => {
            const samples = row.sampleConflictKeys.slice(0, 3).join("; ");
            return `- ${row.severity}: ${row.table} (${row.class}) conflicts=${row.conflictRows}${samples ? ` samples=${samples}` : ""}\n  ${row.resolution}`;
          })
        : ["- none"]),
      "",
      "Sampled historical evidence:",
      ...(report.latestManifest?.tables.length
        ? report.latestManifest.tables.map((table) => {
            const samples = table.sampleConflictKeys.length ? table.sampleConflictKeys : table.sampleExistingKeys.length ? table.sampleExistingKeys : table.sampleSourceKeys;
            return `- ${table.table}: source=${table.sourceRows}, insert=${table.insertRows}, conflict=${table.conflictRows}, samples=${samples.slice(0, 3).join("; ") || "regenerate manifest to capture samples"}`;
          })
        : ["- none"]),
      "",
      "Recommended commands:",
      ...report.switchOverProof.recommendedCommands.map((command) => `- ${command}`),
      "",
      "Warnings:",
      ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ["- none"])
    ].join("\n");
  }

  function formatStorageProjectConflictReport(report: StorageProjectConflictReport): string {
    return [
      `Storage project conflicts (${report.generatedAt})`,
      `Source: ${report.sourceDatabaseUrl}`,
      `Target: ${report.targetDatabaseUrl}`,
      "",
      "Conflicts:",
      ...(report.conflicts.length
        ? report.conflicts.flatMap((conflict) => [
            `- ${conflict.rootUri}`,
            `  recommendation: ${conflict.recommendation}`,
            `  reason: ${conflict.reason}`,
            `  differing fields: ${conflict.differingFields.join(", ") || "none"}`,
            `  source: ${conflict.source.name ?? "unnamed"} (${conflict.source.projectId}), profile=${conflict.source.profile ?? "n/a"}, updated=${conflict.source.updatedAt ?? "n/a"}, config=${conflict.source.configHash}, runs=${conflict.source.linkedRows.workflow_runs}`,
            `  target: ${conflict.target.name ?? "unnamed"} (${conflict.target.projectId}), profile=${conflict.target.profile ?? "n/a"}, updated=${conflict.target.updatedAt ?? "n/a"}, config=${conflict.target.configHash}, runs=${conflict.target.linkedRows.workflow_runs}`,
            `  decision: ${conflict.decisionRecord.action} - ${conflict.decisionRecord.note}`
          ])
        : ["- none"]),
      "",
      "Recommendations:",
      ...report.recommendations.map((recommendation) => `- ${recommendation}`)
    ].join("\n");
  }

  function parseStorageMigrationMode(value: string): "copy-empty-target" | "merge-preview" {
    const normalized = normalizeLookup(value);
    if (normalized === "copy-empty-target" || normalized === "copyemptytarget" || normalized === "copy") return "copy-empty-target";
    if (normalized === "merge-preview" || normalized === "mergepreview" || normalized === "merge") return "merge-preview";
    throw new Error(`Storage migration mode must be copy-empty-target or merge-preview. Received: ${value}`);
  }

  async function writeObjectArtifactProofEvidence(report: ObjectArtifactProofReport, outDir: string): Promise<{ markdownPath: string; jsonPath: string }> {
    const resolvedOut = path.resolve(process.cwd(), outDir);
    await fs.mkdir(resolvedOut, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const base = `object-artifact-proof-${stamp}`;
    const markdownPath = path.join(resolvedOut, `${base}.md`);
    const jsonPath = path.join(resolvedOut, `${base}.json`);
    await fs.writeFile(markdownPath, `${formatObjectArtifactProofReport(report)}\n`, "utf8");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { markdownPath, jsonPath };
  }

  async function writeStorageMigrationPlanFiles(plan: StorageMigrationPlan, outDir: string): Promise<{ markdownPath: string; jsonPath: string; scriptPath: string }> {
    const resolvedOut = path.resolve(process.cwd(), outDir);
    await fs.mkdir(resolvedOut, { recursive: true });
    const stamp = plan.generatedAt.replace(/[:.]/g, "-");
    const base = `storage-migration-${stamp}`;
    const markdownPath = path.join(resolvedOut, `${base}.md`);
    const jsonPath = path.join(resolvedOut, `${base}.json`);
    const scriptPath = path.join(resolvedOut, `${base}.sh`);
    await fs.writeFile(markdownPath, `${formatStorageMigrationPlan(plan)}\n`, "utf8");
    await fs.writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await fs.writeFile(scriptPath, storageMigrationScript(plan.mode), { encoding: "utf8", mode: 0o755 });
    await fs.chmod(scriptPath, 0o755);
    return { markdownPath, jsonPath, scriptPath };
  }

  program
    .command("bootstrap-storage")
    .description("Seed enterprise storage with agent and workflow registry definitions")
    .action(async () => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const agents = await loadAgentRecords(ctx.rootDir);
      const workflows = await loadWorkflowRecords(ctx.rootDir);
      await migrateStorage();
      const result = await seedRegistry(agents, workflows);
      const bucketResult = await ensureObjectStorageBucket();
      console.log(`Seeded ${result.agents} agents and ${result.workflows} workflows into enterprise storage.`);
      console.log(bucketResult.ok ? `OK: ${bucketResult.message}` : `WARN: ${bucketResult.message}`);
    });

  program
    .command("migrate-storage")
    .description("Apply additive enterprise storage migrations")
    .action(async () => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      await migrateStorage();
      console.log("Storage migrations applied.");
    });

  program
    .command("storage-migrate")
    .description("Plan a dry-run migration from local enterprise storage to a shared LAN/Tailscale storage host")
    .option("--target-host <host>", "shared storage host used to infer target URLs, for example 192.0.2.10")
    .option("--source-database-url <url>", "source Postgres URL; defaults to DATABASE_URL")
    .option("--source-redis-url <url>", "source Redis URL; defaults to REDIS_URL")
    .option("--source-object-storage-endpoint <url>", "source MinIO/S3 endpoint; defaults to OBJECT_STORAGE_ENDPOINT")
    .option("--source-object-storage-bucket <bucket>", "source object bucket; defaults to OBJECT_STORAGE_BUCKET")
    .option("--target-database-url <url>", "target Postgres URL")
    .option("--target-redis-url <url>", "target Redis URL")
    .option("--target-object-storage-endpoint <url>", "target MinIO/S3 endpoint")
    .option("--target-object-storage-bucket <bucket>", "target object bucket")
    .option("--mode <mode>", "copy-empty-target or merge-preview", "copy-empty-target")
    .option("--out <dir>", "plan output directory", ".agent-workflow/migrations")
    .option("--write-plan", "write JSON, Markdown, and guarded shell script plan files")
    .option("--json", "print machine-readable migration plan")
    .action(async (options: {
      targetHost?: string;
      sourceDatabaseUrl?: string;
      sourceRedisUrl?: string;
      sourceObjectStorageEndpoint?: string;
      sourceObjectStorageBucket?: string;
      targetDatabaseUrl?: string;
      targetRedisUrl?: string;
      targetObjectStorageEndpoint?: string;
      targetObjectStorageBucket?: string;
      mode: string;
      out: string;
      writePlan?: boolean;
      json?: boolean;
    }) => {
      const mode = parseStorageMigrationMode(options.mode);
      const plan = await buildStorageMigrationPlan({
        targetHost: options.targetHost,
        sourceDatabaseUrl: options.sourceDatabaseUrl,
        sourceRedisUrl: options.sourceRedisUrl,
        sourceObjectStorageEndpoint: options.sourceObjectStorageEndpoint,
        sourceObjectStorageBucket: options.sourceObjectStorageBucket,
        targetDatabaseUrl: options.targetDatabaseUrl,
        targetRedisUrl: options.targetRedisUrl,
        targetObjectStorageEndpoint: options.targetObjectStorageEndpoint,
        targetObjectStorageBucket: options.targetObjectStorageBucket,
        mode
      });
      const written = options.writePlan ? await writeStorageMigrationPlanFiles(plan, options.out) : null;
      if (options.json) {
        console.log(JSON.stringify({ ...plan, written }, null, 2));
        return;
      }
      console.log(formatStorageMigrationPlan(plan));
      if (written) {
        console.log("");
        console.log("Written files:");
        console.log(`- Markdown: ${written.markdownPath}`);
        console.log(`- JSON: ${written.jsonPath}`);
        console.log(`- Script: ${written.scriptPath}`);
      }
      if (plan.status === "blocked") process.exitCode = 2;
    });

  program
    .command("storage-merge-manifest")
    .description("Build a read-only row-level merge manifest between two Agent Workflow Postgres databases")
    .option("--target-host <host>", "shared storage host used to infer target Postgres URL, for example 192.0.2.10")
    .option("--source-database-url <url>", "source Postgres URL; defaults to DATABASE_URL")
    .option("--target-database-url <url>", "target Postgres URL")
    .option("--out <dir>", "manifest output directory", ".agent-workflow/migrations")
    .option("--write", "write JSON and Markdown manifest files")
    .option("--json", "print machine-readable merge manifest")
    .action(async (options: {
      targetHost?: string;
      sourceDatabaseUrl?: string;
      targetDatabaseUrl?: string;
      out: string;
      write?: boolean;
      json?: boolean;
    }) => {
      const manifest = await buildStorageMergeManifest({
        targetHost: options.targetHost,
        sourceDatabaseUrl: options.sourceDatabaseUrl,
        targetDatabaseUrl: options.targetDatabaseUrl
      });
      const written = options.write ? await writeStorageMergeManifestFiles(manifest, options.out) : null;
      if (options.json) {
        console.log(JSON.stringify({ ...manifest, written }, null, 2));
        return;
      }
      console.log(formatStorageMergeManifest(manifest));
      if (written) {
        console.log("");
        console.log("Written files:");
        console.log(`- Markdown: ${written.markdownPath}`);
        console.log(`- JSON: ${written.jsonPath}`);
      }
      if (manifest.status === "blocked") process.exitCode = 2;
    });

  program
    .command("storage-merge-import")
    .description("Dry-run or execute an insert-only shared-storage merge from a reviewed merge manifest")
    .requiredOption("--manifest <path>", "reviewed storage-merge-manifest JSON path")
    .option("--source-database-url <url>", "source Postgres URL; defaults to SOURCE_DATABASE_URL or DATABASE_URL")
    .option("--target-database-url <url>", "target Postgres URL; defaults to TARGET_DATABASE_URL or DATABASE_URL")
    .option("--out <dir>", "result output directory", ".agent-workflow/migrations")
    .option("--write-result", "write JSON and Markdown import result files")
    .option("--execute", "perform the insert-only merge; omitted means dry-run")
    .option("--allow-stale-manifest", "allow execution when live source/target counts differ from the reviewed manifest")
    .option("--json", "print machine-readable import result")
    .action(async (options: {
      manifest: string;
      sourceDatabaseUrl?: string;
      targetDatabaseUrl?: string;
      out: string;
      writeResult?: boolean;
      execute?: boolean;
      allowStaleManifest?: boolean;
      json?: boolean;
    }) => {
      const result = await runStorageMergeImport({
        manifestPath: path.resolve(process.cwd(), options.manifest),
        sourceDatabaseUrl: options.sourceDatabaseUrl,
        targetDatabaseUrl: options.targetDatabaseUrl,
        execute: options.execute,
        allowStaleManifest: options.allowStaleManifest,
        backupDir: options.out
      });
      const written = options.writeResult ? await writeStorageMergeImportResultFiles(result, options.out) : null;
      if (options.json) {
        console.log(JSON.stringify({ ...result, written }, null, 2));
        return;
      }
      console.log(formatStorageMergeImportResult(result));
      if (written) {
        console.log("");
        console.log("Written files:");
        console.log(`- Markdown: ${written.markdownPath}`);
        console.log(`- JSON: ${written.jsonPath}`);
      }
      if (result.status === "blocked") process.exitCode = 2;
    });

  program
    .command("storage-merge-evidence")
    .description("Inspect local post-merge evidence artifacts without contacting source or target storage")
    .option("--dir <dir>", "migration evidence directory", ".agent-workflow/migrations")
    .option("--json", "print machine-readable merge evidence")
    .action(async (options: { dir: string; json?: boolean }) => {
      const report = await loadStorageMergeEvidenceListing(ctx, options.dir);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatStorageMergeEvidenceListing(report));
      if (!report.safePrimaryStatePlane) process.exitCode = 1;
    });

  program
    .command("storage-project-conflicts")
    .description("Preview source/target project metadata conflicts before treating shared storage as primary")
    .option("--target-host <host>", "shared storage host used to infer target Postgres URL, for example 192.0.2.10")
    .option("--source-database-url <url>", "source Postgres URL; defaults to DATABASE_URL")
    .option("--target-database-url <url>", "target Postgres URL")
    .option("--json", "print machine-readable project conflict report")
    .action(async (options: { targetHost?: string; sourceDatabaseUrl?: string; targetDatabaseUrl?: string; json?: boolean }) => {
      const report = await buildStorageProjectConflictReport({
        targetHost: options.targetHost,
        sourceDatabaseUrl: options.sourceDatabaseUrl,
        targetDatabaseUrl: options.targetDatabaseUrl
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatStorageProjectConflictReport(report));
      if (report.conflicts.some((conflict) => conflict.recommendation === "manual-review")) process.exitCode = 1;
    });

  program
    .command("storage-project-decision")
    .description("Record a reviewed canonical project decision in local migration evidence")
    .requiredOption("--root <uri>", "project root_uri being decided")
    .requiredOption("--action <action>", "preserve-target-project, promote-source-project, or manual-project-review")
    .option("--source-project-id <id>", "source project id from storage-project-conflicts")
    .option("--target-project-id <id>", "target project id from storage-project-conflicts")
    .option("--reviewer <name>", "operator/reviewer name", process.env.USER || "operator")
    .requiredOption("--note <text>", "decision rationale")
    .option("--out <dir>", "migration evidence directory", ".agent-workflow/migrations")
    .option("--json", "print machine-readable write result")
    .action(async (options: { root: string; action: string; sourceProjectId?: string; targetProjectId?: string; reviewer: string; note: string; out: string; json?: boolean }) => {
      if (!["preserve-target-project", "promote-source-project", "manual-project-review"].includes(options.action)) {
        throw new Error("--action must be preserve-target-project, promote-source-project, or manual-project-review");
      }
      const result = await writeStorageProjectConflictDecision(ctx, {
        outDir: options.out,
        rootUri: options.root,
        action: options.action,
        sourceProjectId: options.sourceProjectId,
        targetProjectId: options.targetProjectId,
        reviewer: options.reviewer,
        note: options.note
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Recorded project decision: ${result.jsonPath}`);
      console.log(`Decision count: ${result.decisionCount}`);
    });

  program
    .command("offline-fallback")
    .description("Inspect shared storage health and localhost fallback readiness")
    .option("--record <action>", "record a fallback queue item: start-local, offline-run, sync-back, use-shared")
    .option("--project <path>", "project path for the recorded fallback item")
    .option("--run-id <id>", "workflow run id for an offline-run queue item")
    .option("--note <text>", "operator note for the recorded fallback item")
    .option("--mark-synced <id>", "mark a fallback queue item synced")
    .option("--json", "print machine-readable offline fallback report")
    .action(async (options: { record?: string; project?: string; runId?: string; note?: string; markSynced?: string; json?: boolean }) => {
      if (options.record) {
        const result = await recordOfflineFallbackQueueItem(ctx, {
          action: parseOfflineFallbackQueueAction(options.record),
          projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
          runId: options.runId,
          note: options.note,
          actor: "cli"
        });
        console.log(options.json ? JSON.stringify(result, null, 2) : formatOfflineFallbackQueue(result.queue));
        return;
      }
      if (options.markSynced) {
        const queue = await markOfflineFallbackQueueItemSynced(ctx, options.markSynced, "cli");
        console.log(options.json ? JSON.stringify(queue, null, 2) : formatOfflineFallbackQueue(queue));
        return;
      }
      const report = await loadOfflineFallbackReport(ctx);
      console.log(options.json ? JSON.stringify(report, null, 2) : formatOfflineFallbackReport(report));
      if (report.mode === "offline-blocked") process.exitCode = 2;
      if (report.mode === "local-fallback-stopped") process.exitCode = 1;
    });

  program
    .command("offline-sync")
    .description("Prepare or execute a local fallback sync back into configured shared storage")
    .option("--out <dir>", "migration evidence output directory", ".agent-workflow/migrations")
    .option("--scheduler-check", "run the daemon-style dry-run scheduler check once")
    .option("--scheduler-execute", "allow the scheduler check to execute insert-only sync when ready")
    .option("--scheduler-interval-ms <number>", "minimum interval for scheduler checks", "900000")
    .option("--execute", "execute the insert-only merge and mark pending fallback items synced")
    .option("--json", "print machine-readable offline sync result")
    .action(async (options: { out: string; schedulerCheck?: boolean; schedulerExecute?: boolean; schedulerIntervalMs: string; execute?: boolean; json?: boolean }) => {
      if (options.schedulerCheck) {
        const status = await runDaemonOfflineSyncScheduler(ctx, {
          actor: "cli",
          minIntervalMs: parsePositiveInteger(options.schedulerIntervalMs, 900000),
          execute: Boolean(options.schedulerExecute)
        });
        console.log(options.json ? JSON.stringify(status, null, 2) : formatOfflineSyncSchedulerStatus(status));
        return;
      }
      const result = await runOfflineFallbackSync(ctx, {
        outDir: options.out,
        execute: Boolean(options.execute),
        actor: "cli"
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatOfflineFallbackSyncResult(result));
      if (result.status === "blocked") process.exitCode = 2;
    });

  program
    .command("object-artifact-proof")
    .description("Inspect object-backed artifact references and optionally verify them in MinIO/S3 with mc")
    .option("-p, --project <dir>", "only inspect artifacts for one project root")
    .option("-l, --limit <number>", "number of recent artifacts to inspect", "500")
    .option("--endpoint <url>", "object storage endpoint; defaults to OBJECT_STORAGE_ENDPOINT")
    .option("--bucket <bucket>", "object storage bucket; defaults to OBJECT_STORAGE_BUCKET")
    .option("--access-key <key>", "object storage access key; defaults to OBJECT_STORAGE_ACCESS_KEY")
    .option("--secret-key <key>", "object storage secret key; defaults to OBJECT_STORAGE_SECRET_KEY")
    .option("--enumerate-buckets", "compare source and target object bucket keys with MinIO Client (mc)")
    .option("--source-endpoint <url>", "source object endpoint for bucket enumeration; defaults to localhost MinIO")
    .option("--source-bucket <bucket>", "source object bucket for bucket enumeration; defaults to OBJECT_STORAGE_BUCKET")
    .option("--source-access-key <key>", "source object access key; defaults to OBJECT_STORAGE_ACCESS_KEY")
    .option("--source-secret-key <key>", "source object secret key; defaults to OBJECT_STORAGE_SECRET_KEY")
    .option("--target-endpoint <url>", "target object endpoint for bucket enumeration; defaults to OBJECT_STORAGE_ENDPOINT")
    .option("--target-bucket <bucket>", "target object bucket for bucket enumeration; defaults to OBJECT_STORAGE_BUCKET")
    .option("--target-access-key <key>", "target object access key; defaults to OBJECT_STORAGE_ACCESS_KEY")
    .option("--target-secret-key <key>", "target object secret key; defaults to OBJECT_STORAGE_SECRET_KEY")
    .option("--verify", "verify referenced object keys with MinIO Client (mc)")
    .option("--queue-mirror-approval", "queue an approval for the missing-object mirror plan; requires --project and --enumerate-buckets")
    .option("--write", "write object proof evidence to .agent-workflow/migrations")
    .option("--out <dir>", "directory for --write output", ".agent-workflow/migrations")
    .option("--actor <name>", "person or tool requesting mirror approval", "cli")
    .option("--actor-role <role>", "project role for approval request audit", "operator")
    .option("--json", "print machine-readable object artifact proof")
    .action(async (options: {
      project?: string;
      limit: string;
      endpoint?: string;
      bucket?: string;
      accessKey?: string;
      secretKey?: string;
      enumerateBuckets?: boolean;
      sourceEndpoint?: string;
      sourceBucket?: string;
      sourceAccessKey?: string;
      sourceSecretKey?: string;
      targetEndpoint?: string;
      targetBucket?: string;
      targetAccessKey?: string;
      targetSecretKey?: string;
      verify?: boolean;
      queueMirrorApproval?: boolean;
      write?: boolean;
      out: string;
      actor: string;
      actorRole: string;
      json?: boolean;
    }) => {
      const report = await buildObjectArtifactProofReport(ctx, {
        projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
        limit: parsePositiveInteger(options.limit, 500),
        endpoint: options.endpoint,
        bucket: options.bucket,
        accessKey: options.accessKey,
        secretKey: options.secretKey,
        enumerateBuckets: Boolean(options.enumerateBuckets),
        sourceEndpoint: options.sourceEndpoint,
        sourceBucket: options.sourceBucket,
        sourceAccessKey: options.sourceAccessKey,
        sourceSecretKey: options.sourceSecretKey,
        targetEndpoint: options.targetEndpoint,
        targetBucket: options.targetBucket,
        targetAccessKey: options.targetAccessKey,
        targetSecretKey: options.targetSecretKey,
        verify: Boolean(options.verify)
      });
      const written = options.write ? await writeObjectArtifactProofEvidence(report, options.out) : null;
      if (options.queueMirrorApproval) {
        const result = await queueObjectMirrorApproval(ctx, {
          projectPath: options.project,
          report,
          sourceEndpoint: options.sourceEndpoint ?? "http://127.0.0.1:19000",
          sourceBucket: options.sourceBucket ?? options.bucket ?? process.env.OBJECT_STORAGE_BUCKET ?? "agentflow-artifacts",
          targetEndpoint: options.targetEndpoint ?? options.endpoint ?? process.env.OBJECT_STORAGE_ENDPOINT ?? "",
          targetBucket: options.targetBucket ?? options.bucket ?? process.env.OBJECT_STORAGE_BUCKET ?? "agentflow-artifacts",
          actor: options.actor,
          actorRole: normalizeActorRole(options.actorRole, "operator")
        });
        if (options.json) {
          console.log(JSON.stringify({ ...report, written, mirrorApproval: result }, null, 2));
        } else {
          console.log(formatObjectArtifactProofReport(report));
          if (written) {
            console.log("");
            console.log("Written files:");
            console.log(`- Markdown: ${written.markdownPath}`);
            console.log(`- JSON: ${written.jsonPath}`);
          }
          console.log("");
          console.log(result.ok ? result.output : result.error);
        }
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(written ? { ...report, written } : report, null, 2));
      } else {
        console.log(formatObjectArtifactProofReport(report));
        if (written) {
          console.log("");
          console.log("Written files:");
          console.log(`- Markdown: ${written.markdownPath}`);
          console.log(`- JSON: ${written.jsonPath}`);
        }
      }
      if (report.status === "missing") process.exitCode = 1;
      if (report.status === "blocked") process.exitCode = 2;
    });

  program
    .command("storage-verify")
    .description("Compare durable Agent Workflow state between a source and target storage plane without mutating either")
    .option("--target-host <host>", "shared storage host used to infer target URLs, for example 192.0.2.10")
    .option("--source-database-url <url>", "source Postgres URL; defaults to DATABASE_URL")
    .option("--source-redis-url <url>", "source Redis URL; defaults to REDIS_URL")
    .option("--source-object-storage-endpoint <url>", "source MinIO/S3 endpoint; defaults to OBJECT_STORAGE_ENDPOINT")
    .option("--source-object-storage-bucket <bucket>", "source object bucket; defaults to OBJECT_STORAGE_BUCKET")
    .option("--target-database-url <url>", "target Postgres URL")
    .option("--target-redis-url <url>", "target Redis URL")
    .option("--target-object-storage-endpoint <url>", "target MinIO/S3 endpoint")
    .option("--target-object-storage-bucket <bucket>", "target object bucket")
    .option("--json", "print machine-readable verification report")
    .action(async (options: {
      targetHost?: string;
      sourceDatabaseUrl?: string;
      sourceRedisUrl?: string;
      sourceObjectStorageEndpoint?: string;
      sourceObjectStorageBucket?: string;
      targetDatabaseUrl?: string;
      targetRedisUrl?: string;
      targetObjectStorageEndpoint?: string;
      targetObjectStorageBucket?: string;
      json?: boolean;
    }) => {
      const report = await buildStorageVerificationReport({
        targetHost: options.targetHost,
        sourceDatabaseUrl: options.sourceDatabaseUrl,
        sourceRedisUrl: options.sourceRedisUrl,
        sourceObjectStorageEndpoint: options.sourceObjectStorageEndpoint,
        sourceObjectStorageBucket: options.sourceObjectStorageBucket,
        targetDatabaseUrl: options.targetDatabaseUrl,
        targetRedisUrl: options.targetRedisUrl,
        targetObjectStorageEndpoint: options.targetObjectStorageEndpoint,
        targetObjectStorageBucket: options.targetObjectStorageBucket
      });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(formatStorageVerificationReport(report));
      if (report.status === "blocked") process.exitCode = 2;
      if (report.status === "mismatch") process.exitCode = 1;
    });

  program
    .command("reset-storage")
    .description("Clear local enterprise run history and indexed project data")
    .option("--include-registry", "also remove seeded agent and workflow definitions")
    .option("--yes", "confirm destructive cleanup")
    .action(async (options: { includeRegistry?: boolean; yes?: boolean }) => {
      if (!options.yes) {
        console.error("Refusing to reset storage without --yes.");
        console.error("This deletes local workflow runs, tasks, receipts, artifacts, indexed project files, memory, and projects.");
        console.error("Use --include-registry to also delete seeded agent and workflow definitions.");
        process.exitCode = 1;
        return;
      }

      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const result = await resetStorage({ includeRegistry: Boolean(options.includeRegistry) });
      console.log("Storage reset complete.");
      console.log(`Deleted artifacts: ${result.artifacts}`);
      console.log(`Deleted action receipts: ${result.actionReceipts}`);
      console.log(`Deleted workflow tasks: ${result.workflowTasks}`);
      console.log(`Deleted workflow runs: ${result.workflowRuns}`);
      console.log(`Deleted project files: ${result.projectFiles}`);
      console.log(`Deleted memory items: ${result.memoryItems}`);
      console.log(`Deleted projects: ${result.projects}`);
      if (options.includeRegistry) {
        console.log(`Deleted workflows: ${result.workflows ?? 0}`);
        console.log(`Deleted agents: ${result.agents ?? 0}`);
        console.log("Run `npm run bootstrap-storage` before queueing workflows.");
      }
    });

  program
    .command("index-project")
    .description("Index project files into durable compact summaries")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--max-files <number>", "maximum files to index", "200")
    .option("--incremental", "only refresh files changed since the last indexed commit")
    .option("--since-commit <sha>", "reference commit for incremental indexing")
    .option("--refine", "refine file summaries with the selected provider")
    .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
    .option("--watch", "keep polling for changed files and refresh incrementally")
    .option("--interval-ms <number>", "watch polling interval in milliseconds", "10000")
    .action(async (options: { project: string; maxFiles: string; incremental?: boolean; sinceCommit?: string; refine?: boolean; forceRefine?: boolean; watch?: boolean; intervalMs: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      const maxFiles = Number.parseInt(options.maxFiles, 10);
      const parsedMaxFiles = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 200;
      const runOnce = async (incrementalOverride: boolean) => {
        const projectId = await upsertProject({
          name: project.project.name,
          rootUri: projectDir,
          profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
          config: project
        });
        const state = await getProjectIndexState({ projectId });
        return indexProjectWithStorage(ctx, {
          projectId,
          projectDir,
          project,
          maxFiles: parsedMaxFiles,
          refineProvider: options.refine ? providerFromEnv() : undefined,
          forceRefine: Boolean(options.forceRefine),
          incremental: incrementalOverride,
          sinceCommit: options.sinceCommit ?? state?.headCommit ?? undefined
        });
      };

      const incremental = Boolean(options.incremental || options.sinceCommit || options.watch);
      const result = await runOnce(incremental);
      console.log(formatIndexResult(result));
      if (!options.watch) {
        return;
      }

      const intervalMs = parsePositiveInteger(options.intervalMs, 10_000);
      console.log(`Watching ${projectDir} for incremental indexing every ${intervalMs}ms. Press Ctrl+C to stop.`);
      while (true) {
        await sleep(intervalMs);
        const tick = await runOnce(true);
        if (tick.count > 0 || tick.deleted > 0 || tick.fullIndexFallback || tick.truncated) {
          console.log(formatIndexResult(tick));
        }
      }
    });

}

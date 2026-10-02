import type { CliContext } from "./context.js";
import type { DashboardFollowUpResult, McRunner, McRunnerMode, ObjectArtifactProofReport, ObjectArtifactReferenceProof, ObjectBucketParityProof, OfflineFallbackQueue, OfflineFallbackQueueAction, OfflineFallbackQueueItem, OfflineFallbackReport, OfflineFallbackSyncResult, StorageMergeEvidenceListing, StorageProjectDecisionEntry } from "./cli-types.js";
import { emptyOfflineFallbackQueue, emptyOfflineSyncSchedulerStatus, readOfflineFallbackQueue, readOfflineSyncSchedulerStatus, writeOfflineFallbackQueue } from "./builders-learning.js";
import { commandAvailable, compactDashboardText, evaluateRoleGate, execFileText, pathIsFile, redactDashboardUrl, shellQuote, stableHash, validateObjectMirrorEndpoint } from "./builders-shared.js";
import { loadAgentRecords, loadProjectConfig, loadWorkflowRecords, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { defaultServiceEndpoints } from "../../../../packages/storage/src/config.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { type StorageMergeImportResult } from "../../../../packages/storage/src/merge-importer.js";
import { type StorageMergeManifest } from "../../../../packages/storage/src/merge-manifest.js";
import { completeApprovalRequestRun, createWorkflowRun, getArtifactByUri, listArtifactLifecycle, requestActionApproval, seedRegistry } from "../../../../packages/storage/src/postgres.js";
import { collectObjectReferences, normalizeObjectArtifactKey, parseMcFindKeys } from "../object-artifact-parsing.js";
import { resolveWorkflow } from "../reference-resolution.js";
import { randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function buildObjectArtifactProofReport(ctx: CliContext, input: {
  projectRootUri?: string;
  limit: number;
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
  verify: boolean;
}): Promise<ObjectArtifactProofReport> {
  const endpoint = input.endpoint ?? process.env.OBJECT_STORAGE_ENDPOINT ?? "not configured";
  const bucket = input.bucket ?? process.env.OBJECT_STORAGE_BUCKET ?? "agentflow-artifacts";
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const artifacts = await listArtifactLifecycle({
    projectRootUri: input.projectRootUri,
    limit: input.limit
  });
  const objectRefs: ObjectArtifactReferenceProof[] = [];
  for (const row of artifacts) {
    const artifact = await getArtifactByUri(row.uri);
    if (!artifact) continue;
    for (const ref of collectObjectReferences(artifact.content)) {
      objectRefs.push({
        key: normalizeObjectArtifactKey(ref.value, bucket),
        artifactId: artifact.id,
        artifactUri: artifact.uri,
        artifactKind: artifact.kind,
        runId: artifact.runId,
        source: ref.path,
        status: "not-checked",
        message: "verification disabled"
      });
    }
  }
  if (!objectRefs.length) {
    recommendations.push("No object-backed artifact references were found in inspected artifact content. Current artifact merge proof is covered by Postgres artifact rows.");
  }
  let verification: ObjectArtifactProofReport["verification"] = "disabled";
  if (input.verify && objectRefs.length) {
    const accessKey = input.accessKey ?? process.env.OBJECT_STORAGE_ACCESS_KEY;
    const secretKey = input.secretKey ?? process.env.OBJECT_STORAGE_SECRET_KEY;
    if (!accessKey || !secretKey || endpoint === "not configured") {
      verification = "unavailable";
      warnings.push("Object verification requested, but OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY, or OBJECT_STORAGE_SECRET_KEY is unavailable.");
      recommendations.push("Configure object-storage credentials before running object-artifact-proof --verify.");
    } else {
      verification = await verifyObjectReferencesWithMc(ctx, objectRefs, {
        endpoint,
        bucket,
        accessKey,
        secretKey
      });
      if (verification === "unavailable") {
        warnings.push("Object verification requested, but neither MinIO Client nor Docker minio/mc fallback is available.");
        recommendations.push("Install MinIO Client or Docker before running object-artifact-proof --verify.");
      }
    }
  }
  const bucketParity = input.enumerateBuckets
    ? await buildObjectBucketParityProof(ctx, {
      sourceEndpoint: input.sourceEndpoint ?? "http://127.0.0.1:19000",
      sourceBucket: input.sourceBucket ?? bucket,
      sourceAccessKey: input.sourceAccessKey ?? input.accessKey ?? process.env.OBJECT_STORAGE_ACCESS_KEY,
      sourceSecretKey: input.sourceSecretKey ?? input.secretKey ?? process.env.OBJECT_STORAGE_SECRET_KEY,
      targetEndpoint: input.targetEndpoint ?? endpoint,
      targetBucket: input.targetBucket ?? bucket,
      targetAccessKey: input.targetAccessKey ?? input.accessKey ?? process.env.OBJECT_STORAGE_ACCESS_KEY,
      targetSecretKey: input.targetSecretKey ?? input.secretKey ?? process.env.OBJECT_STORAGE_SECRET_KEY
    })
    : null;
  if (bucketParity?.status === "blocked") warnings.push(bucketParity.message);
  if (bucketParity?.status === "missing") recommendations.push("Review the object mirror plan and mirror missing source objects to the target bucket before relying on shared storage as complete artifact storage.");
  if (bucketParity?.verifier === "docker-mc") recommendations.push("Bucket enumeration used Docker minio/mc fallback because local MinIO Client was unavailable.");
  const verifiedObjects = objectRefs.filter((ref) => ref.status === "present").length;
  const missingObjects = objectRefs.filter((ref) => ref.status === "missing").length;
  const status: ObjectArtifactProofReport["status"] = missingObjects > 0
    ? "missing"
    : bucketParity?.status === "missing"
      ? "missing"
      : bucketParity?.status === "blocked"
        ? "blocked"
    : verification === "mc" || verification === "docker-mc"
      ? "verified"
      : bucketParity?.status === "verified"
        ? "verified"
      : verification === "unavailable"
        ? "blocked"
        : "metadata-only";
  return {
    kind: "agentflow_object_artifact_proof_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: input.projectRootUri ?? null,
    limit: input.limit,
    status,
    endpoint: redactDashboardUrl(endpoint),
    bucket,
    inspectedArtifacts: artifacts.length,
    referencedObjects: objectRefs.length,
    verifiedObjects,
    missingObjects,
    verification,
    bucketParity,
    objects: objectRefs.slice(0, 200),
    warnings,
    recommendations
  };
}

export async function buildObjectBucketParityProof(ctx: CliContext, input: {
  sourceEndpoint: string;
  sourceBucket: string;
  sourceAccessKey?: string;
  sourceSecretKey?: string;
  targetEndpoint: string;
  targetBucket: string;
  targetAccessKey?: string;
  targetSecretKey?: string;
}): Promise<ObjectBucketParityProof> {
  const mirrorPlan = [
    `mc alias set agentflow-object-source ${shellQuote(input.sourceEndpoint)} "$SOURCE_OBJECT_STORAGE_ACCESS_KEY" "$SOURCE_OBJECT_STORAGE_SECRET_KEY"`,
    `mc alias set agentflow-object-target ${shellQuote(input.targetEndpoint)} "$TARGET_OBJECT_STORAGE_ACCESS_KEY" "$TARGET_OBJECT_STORAGE_SECRET_KEY"`,
    `mc mirror --overwrite=false "agentflow-object-source/${input.sourceBucket}" "agentflow-object-target/${input.targetBucket}"`
  ];
  const missingConfig = [
    !input.sourceEndpoint ? "source endpoint" : "",
    !input.sourceBucket ? "source bucket" : "",
    !input.sourceAccessKey ? "source access key" : "",
    !input.sourceSecretKey ? "source secret key" : "",
    !input.targetEndpoint || input.targetEndpoint === "not configured" ? "target endpoint" : "",
    !input.targetBucket ? "target bucket" : "",
    !input.targetAccessKey ? "target access key" : "",
    !input.targetSecretKey ? "target secret key" : ""
  ].filter(Boolean);
  const blockedBase = {
    status: "blocked" as const,
    sourceEndpoint: redactDashboardUrl(input.sourceEndpoint || "missing"),
    sourceBucket: input.sourceBucket || "missing",
    targetEndpoint: redactDashboardUrl(input.targetEndpoint || "missing"),
    targetBucket: input.targetBucket || "missing",
    sourceObjects: 0,
    targetObjects: 0,
    missingInTarget: 0,
    extraInTarget: 0,
    verifier: "unavailable" as const,
    sampledMissingKeys: [],
    sampledExtraKeys: [],
    mirrorPlan
  };
  if (missingConfig.length) {
    return {
      ...blockedBase,
      message: `Bucket enumeration needs ${missingConfig.join(", ")}.`
    };
  }
  const source = await listBucketKeysWithMc(ctx, {
    alias: "agentflow-object-source",
    endpoint: input.sourceEndpoint,
    bucket: input.sourceBucket,
    accessKey: input.sourceAccessKey!,
    secretKey: input.sourceSecretKey!
  });
  const target = await listBucketKeysWithMc(ctx, {
    alias: "agentflow-object-target",
    endpoint: input.targetEndpoint,
    bucket: input.targetBucket,
    accessKey: input.targetAccessKey!,
    secretKey: input.targetSecretKey!
  });
  if (!source.ok || !target.ok) {
    return {
      ...blockedBase,
      verifier: mergeMcVerifier(source.verifier, target.verifier),
      message: [source.ok ? "" : `source: ${source.error}`, target.ok ? "" : `target: ${target.error}`].filter(Boolean).join(" ")
    };
  }
  const sourceKeys = new Set(source.keys);
  const targetKeys = new Set(target.keys);
  const missing = [...sourceKeys].filter((key) => !targetKeys.has(key)).sort();
  const extra = [...targetKeys].filter((key) => !sourceKeys.has(key)).sort();
  return {
    status: missing.length ? "missing" : "verified",
    sourceEndpoint: redactDashboardUrl(input.sourceEndpoint),
    sourceBucket: input.sourceBucket,
    targetEndpoint: redactDashboardUrl(input.targetEndpoint),
    targetBucket: input.targetBucket,
    sourceObjects: sourceKeys.size,
    targetObjects: targetKeys.size,
    missingInTarget: missing.length,
    extraInTarget: extra.length,
    verifier: mergeMcVerifier(source.verifier, target.verifier),
    sampledMissingKeys: missing.slice(0, 25),
    sampledExtraKeys: extra.slice(0, 25),
    mirrorPlan,
    message: missing.length
      ? `${missing.length} source object(s) are missing from the target bucket.`
      : "Target bucket contains every enumerated source object key."
  };
}

export function buildStorageSwitchOverProof(
  manifest: StorageMergeEvidenceListing["latestManifest"],
  importResult: StorageMergeEvidenceListing["latestImport"],
  backup: StorageMergeEvidenceListing["latestBackup"],
  objectProof: StorageMergeEvidenceListing["latestObjectProof"],
  conflictClassification: StorageMergeEvidenceListing["conflictClassification"] | null
): StorageMergeEvidenceListing["switchOverProof"] {
  const checks: StorageMergeEvidenceListing["switchOverProof"]["checks"] = [];
  const classifiedCriticalConflictRows = conflictClassification?.criticalRows ?? null;
  const commands = [
    "npm run storage-merge-manifest -- --write",
    "npm run agentflow -- storage-project-conflicts --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow --target-database-url \"$DATABASE_URL\"",
    "npm run agentflow -- storage-project-decision --root <root_uri> --action preserve-target-project --source-project-id <source_id> --target-project-id <target_id> --note \"Reviewed source/target metadata; shared target is canonical.\"",
    "npm run storage-merge-import -- --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json",
    "npm run storage-merge-import -- --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json --execute",
    "npm run object-artifact-proof -- --enumerate-buckets --verify",
    "npm run storage-merge-evidence"
  ];

  checks.push({
    label: "Latest merge manifest",
    status: manifest ? manifest.status === "blocked" ? "fail" : "pass" : "fail",
    detail: manifest ? `${manifest.tableCount} table plan(s), ${manifest.sourceOnlyRows} source-only row(s), ${manifest.conflictRows} conflict(s).` : "No reviewed merge manifest was found."
  });
  checks.push({
    label: "No source-only rows remain",
    status: manifest && manifest.sourceOnlyRows === 0 ? "pass" : "warn",
    detail: manifest ? `${manifest.sourceOnlyRows} source-only row(s) remain in the latest manifest.` : "Generate a manifest after the latest import."
  });
  checks.push({
    label: "No critical row conflicts",
    status: manifest && classifiedCriticalConflictRows === 0 ? "pass" : "fail",
    detail: manifest ? `${classifiedCriticalConflictRows ?? manifest.conflictRows} classified critical conflict row(s), ${manifest.conflictRows} total conflict row(s), ${manifest.projectIdRewriteRows} project-id rewrite row(s) tracked.` : "No manifest conflict evidence was found."
  });
  checks.push({
    label: "Legacy definitions readable",
    status: !manifest ? "fail" : manifest.legacyReadabilityWarnings > 0 ? "warn" : "pass",
    detail: manifest
      ? `${manifest.legacyDefinitionReferences} legacy reference issue(s), ${manifest.changedDefinitionReferences} changed definition(s), ${manifest.legacyReadabilityWarnings} unresolved readability warning(s).`
      : "No legacy definition evidence was found."
  });
  checks.push({
    label: "Import completed",
    status: importResult?.status === "completed" && importResult.mode === "execute" && !importResult.staleManifest ? "pass" : "fail",
    detail: importResult ? `${importResult.status} ${importResult.mode}, affected=${importResult.affectedRows}, stale=${importResult.staleManifest ? "yes" : "no"}.` : "No completed execute import result was found."
  });
  checks.push({
    label: "Backup available",
    status: backup && backup.files.length >= 2 ? "pass" : "fail",
    detail: backup ? `${backup.files.length} backup file(s) in ${backup.path}.` : "No source/target backup folder was found."
  });
  for (const table of ["workflow_runs", "artifacts", "action_approvals", "action_receipts", "memory_items", "project_files", "project_index_state"]) {
    const plan = manifest?.tables.find((item) => item.table === table);
    checks.push({
      label: `Historical ${table}`,
      status: plan && plan.conflictRows === 0 ? "pass" : "warn",
      detail: plan
        ? `source=${plan.sourceRows}, source-only=${plan.insertRows}, conflicts=${plan.conflictRows}, project-id rewrites=${plan.projectIdRewriteRows}.`
        : "No table evidence was found in the latest manifest."
    });
  }
  checks.push({
    label: "Object bucket parity",
    status: objectProof?.status === "verified" && objectProof.bucketParityStatus === "verified" && objectProof.missingObjects === 0 && objectProof.missingInTarget === 0 ? "pass" : "warn",
    detail: objectProof
      ? `${objectProof.status}, refs=${objectProof.referencedObjects}, verified=${objectProof.verifiedObjects}, missing=${objectProof.missingObjects}, bucket=${objectProof.bucketParityStatus ?? "not checked"}, target-missing=${objectProof.missingInTarget ?? "n/a"}.`
      : "Run object-artifact-proof --write with bucket enumeration and verification after any object mirror action; this evidence command does not contact MinIO unless object proof was recorded."
  });

  const blocking = checks.some((check) => check.status === "fail");
  return {
    status: blocking ? "attention" : "ready",
    checks,
    recommendedCommands: commands
  };
}

export function classifyStorageMergeConflicts(
  manifest: StorageMergeEvidenceListing["latestManifest"],
  decisions: StorageMergeEvidenceListing["latestProjectDecisions"]
): StorageMergeEvidenceListing["conflictClassification"] {
  const rows: StorageMergeEvidenceListing["conflictClassification"]["rows"] = [];
  const decisionsByRoot = new Map((decisions?.decisions ?? []).map((decision) => [decision.rootUri, decision]));
  const durableOutcomeTables = new Set(["workflow_runs", "workflow_tasks", "action_receipts", "artifacts", "memory_items"]);
  const durableOutcomeConflictRows = (manifest?.tables ?? [])
    .filter((table) => durableOutcomeTables.has(table.table))
    .reduce((sum, table) => sum + table.conflictRows + table.insertRows, 0);
  for (const table of manifest?.tables ?? []) {
    if (table.conflictRows === 0) continue;
    if (table.table === "projects") {
      const reviewedKeys = table.sampleConflictKeys.filter((key) => decisionsByRoot.has(key));
      const unreviewedRows = Math.max(0, table.conflictRows - reviewedKeys.length);
      rows.push({
        table: table.table,
        severity: unreviewedRows > 0 ? "critical" : "info",
        class: "canonical-project-conflict",
        conflictRows: unreviewedRows,
        sampleConflictKeys: table.sampleConflictKeys,
        resolution: unreviewedRows > 0
          ? "Inspect project metadata differences and choose the canonical project record before treating shared storage as the primary state plane."
          : "All sampled project conflicts have reviewed local decision records; target rows remain preserved.",
        reviewedDecision: reviewedKeys.length ? `${reviewedKeys.length} reviewed decision(s)` : undefined
      });
      continue;
    }
    if (table.table === "project_files" || table.table === "project_index_state") {
      rows.push({
        table: table.table,
        severity: "warning",
        class: "derived-index-cache",
        conflictRows: table.conflictRows,
        sampleConflictKeys: table.sampleConflictKeys,
        resolution: "Regenerate project indexes on shared storage after switch-over; these rows are refreshable cache evidence, not durable workflow history."
      });
      continue;
    }
    if (table.table === "action_approvals") {
      const approvalOnlyLifecycleDrift = durableOutcomeConflictRows === 0 && table.insertRows === 0;
      rows.push({
        table: table.table,
        severity: approvalOnlyLifecycleDrift ? "warning" : "critical",
        class: "approval-lifecycle-conflict",
        conflictRows: table.conflictRows,
        sampleConflictKeys: table.sampleConflictKeys,
        resolution: approvalOnlyLifecycleDrift
          ? "Preserve target approval lifecycle state. Durable run, task, receipt, artifact, and memory rows are already present, so approval-row drift is operational history rather than missing workflow evidence."
          : "Review approval rows with their matching run, task, receipt, artifact, and memory history before treating shared storage as primary."
      });
      continue;
    }
    rows.push({
      table: table.table,
      severity: "critical",
      class: "historical-state-conflict",
      conflictRows: table.conflictRows,
      sampleConflictKeys: table.sampleConflictKeys,
      resolution: "Review durable history rows before merge; do not overwrite target run, task, approval, receipt, artifact, or memory state without an operator decision."
    });
  }
  return {
    criticalRows: rows.filter((row) => row.severity === "critical").reduce((sum, row) => sum + row.conflictRows, 0),
    derivedRows: rows.filter((row) => row.class === "derived-index-cache").reduce((sum, row) => sum + row.conflictRows, 0),
    informationalRows: rows.filter((row) => row.severity === "info").reduce((sum, row) => sum + row.conflictRows, 0),
    rows
  };
}

export function dockerReachableObjectEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") url.hostname = "host.docker.internal";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint;
  }
}

export async function execMcText(ctx: CliContext, runner: McRunner, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execFileText(ctx, runner.command, [...runner.argsPrefix, ...args], { allowFailure: true, env: runner.env });
}

export function formatOfflineFallbackQueue(queue: OfflineFallbackQueue): string {
  const rows = queue.items.map((item) => `- ${item.id}: ${item.status} ${item.action}${item.projectRootUri ? ` project=${item.projectRootUri}` : ""}${item.runId ? ` run=${item.runId}` : ""}${item.note ? ` - ${item.note}` : ""}`);
  return [
    `Offline fallback sync queue (${queue.updatedAt})`,
    `Items: ${queue.items.length}`,
    ...(rows.length ? rows : ["- none"])
  ].join("\n");
}

export function formatOfflineFallbackSyncResult(result: OfflineFallbackSyncResult): string {
  return [
    `Offline sync ${result.mode} (${result.generatedAt})`,
    `Status: ${result.status}`,
    `Source: ${result.sourceDatabaseUrl}`,
    `Target: ${result.targetDatabaseUrl}`,
    `Pending queue items: ${result.pendingQueueItems}`,
    `Synced queue items: ${result.syncedQueueItems}`,
    "",
    "Manifest:",
    `- status=${result.manifest.status ?? "none"}, source-only=${result.manifest.sourceOnlyRows}, conflicts=${result.manifest.conflictRows}, rewrites=${result.manifest.projectIdRewriteRows}`,
    result.manifest.path ? `- ${result.manifest.path}` : "- none",
    "",
    "Import:",
    `- status=${result.importResult.status ?? "none"}, affected=${result.importResult.affectedRows}, stale=${result.importResult.staleManifest ?? "n/a"}`,
    result.importResult.path ? `- ${result.importResult.path}` : "- none",
    "",
    "Receipt:",
    result.written.receiptPath ? `- ${result.written.receiptPath}` : "- none",
    "",
    "Warnings:",
    ...(result.warnings.length ? result.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Notes:",
    ...(result.notes.length ? result.notes.map((note) => `- ${note}`) : ["- none"])
  ].join("\n");
}

export async function latestMergeBackup(directory: string, entries: string[]): Promise<StorageMergeEvidenceListing["latestBackup"]> {
  const backupDirs = entries
    .filter((entry) => entry.startsWith("storage-merge-backup-"))
    .sort()
    .reverse();
  for (const entry of backupDirs) {
    const backupPath = path.join(directory, entry);
    const stat = await safeStat(backupPath);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(backupPath);
    const backupFiles = [];
    for (const file of files) {
      const filePath = path.join(backupPath, file);
      const fileStat = await safeStat(filePath);
      if (fileStat?.isFile()) backupFiles.push({ name: file, sizeBytes: fileStat.size });
    }
    return {
      path: backupPath,
      generatedAt: stat.mtime.toISOString(),
      files: backupFiles.sort((a, b) => a.name.localeCompare(b.name))
    };
  }
  return null;
}

export async function latestMergeImportResult(ctx: CliContext, directory: string, entries: string[], warnings: string[]): Promise<StorageMergeEvidenceListing["latestImport"]> {
  const jsonFiles = entries
    .filter((entry) => entry.startsWith("storage-merge-import-") && entry.endsWith(".json"))
    .sort()
    .reverse();
  for (const entry of jsonFiles) {
    const jsonPath = path.join(directory, entry);
    const result = await ctx.readJsonFile<StorageMergeImportResult>(jsonPath);
    if (!result || result.kind !== "agentflow_storage_merge_import_result") {
      warnings.push(`Skipped unrecognized merge import JSON: ${jsonPath}`);
      continue;
    }
    const basePath = jsonPath.slice(0, -".json".length);
    return {
      jsonPath,
      markdownPath: await pathIsFile(`${basePath}.md`) ? `${basePath}.md` : null,
      generatedAt: result.generatedAt,
      status: result.status,
      mode: result.mode,
      affectedRows: result.operations.reduce((sum, operation) => sum + operation.affectedRows, 0),
      staleManifest: result.staleManifest
    };
  }
  return null;
}

export async function latestMergeManifest(ctx: CliContext, directory: string, entries: string[], warnings: string[]): Promise<StorageMergeEvidenceListing["latestManifest"]> {
  const jsonFiles = entries
    .filter((entry) => entry.startsWith("storage-merge-manifest-") && entry.endsWith(".json"))
    .sort()
    .reverse();
  for (const entry of jsonFiles) {
    const jsonPath = path.join(directory, entry);
    const manifest = await ctx.readJsonFile<StorageMergeManifest>(jsonPath);
    if (!manifest || manifest.kind !== "agentflow_storage_merge_manifest") {
      warnings.push(`Skipped unrecognized merge manifest JSON: ${jsonPath}`);
      continue;
    }
    const basePath = jsonPath.slice(0, -".json".length);
    return {
      jsonPath,
      markdownPath: await pathIsFile(`${basePath}.md`) ? `${basePath}.md` : null,
      generatedAt: manifest.generatedAt,
      status: manifest.status,
      sourceOnlyRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.insertRows, 0),
      conflictRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.conflictRows, 0),
      projectIdRewriteRows: manifest.tablePlans.reduce((sum, plan) => sum + plan.projectIdRewriteRows, 0),
      legacyDefinitionReferences: (manifest.legacyDefinitionReferences ?? []).length,
      legacyReadabilityWarnings: (manifest.legacyDefinitionReferences ?? []).filter((reference) => reference.action === "readability-warning").length,
      changedDefinitionReferences: (manifest.legacyDefinitionReferences ?? []).filter((reference) => reference.action === "preserve-target-current").length,
      tableCount: manifest.tablePlans.length,
      projectMappings: manifest.projectMappings ?? [],
      tables: manifest.tablePlans.map((plan) => ({
        table: plan.table,
        sourceRows: plan.sourceRows,
        insertRows: plan.insertRows,
        conflictRows: plan.conflictRows,
        projectIdRewriteRows: plan.projectIdRewriteRows,
        sampleSourceKeys: plan.sampleSourceKeys ?? [],
        sampleExistingKeys: plan.sampleExistingKeys ?? [],
        sampleInsertKeys: plan.sampleInsertKeys ?? [],
        sampleConflictKeys: plan.sampleConflictKeys ?? []
      }))
    };
  }
  return null;
}

export async function latestObjectArtifactProof(ctx: CliContext, directory: string, entries: string[], warnings: string[]): Promise<StorageMergeEvidenceListing["latestObjectProof"]> {
  const jsonFiles = entries
    .filter((entry) => entry.startsWith("object-artifact-proof-") && entry.endsWith(".json"))
    .sort()
    .reverse();
  for (const entry of jsonFiles) {
    const jsonPath = path.join(directory, entry);
    const result = await ctx.readJsonFile<ObjectArtifactProofReport>(jsonPath);
    if (!result || result.kind !== "agentflow_object_artifact_proof_report") {
      warnings.push(`Skipped unrecognized object artifact proof JSON: ${jsonPath}`);
      continue;
    }
    const basePath = jsonPath.slice(0, -".json".length);
    return {
      jsonPath,
      markdownPath: await pathIsFile(`${basePath}.md`) ? `${basePath}.md` : null,
      generatedAt: result.generatedAt,
      status: result.status,
      referencedObjects: result.referencedObjects,
      verifiedObjects: result.verifiedObjects,
      missingObjects: result.missingObjects,
      bucketParityStatus: result.bucketParity?.status ?? null,
      missingInTarget: result.bucketParity?.missingInTarget ?? null,
      extraInTarget: result.bucketParity?.extraInTarget ?? null
    };
  }
  return null;
}

export async function latestStorageProjectConflictDecisions(ctx: CliContext, directory: string, entries: string[], warnings: string[]): Promise<StorageMergeEvidenceListing["latestProjectDecisions"]> {
  const jsonFiles = [
    ...entries.filter((entry) => entry === "storage-project-decisions.json"),
    ...entries
      .filter((entry) => entry.startsWith("storage-project-decisions-") && entry.endsWith(".json"))
      .sort()
      .reverse()
  ];
  for (const entry of jsonFiles) {
    const jsonPath = path.join(directory, entry);
    const result = await ctx.readJsonFile<{ kind?: string; generatedAt?: string; decisions?: StorageProjectDecisionEntry[] }>(jsonPath);
    if (!result || result.kind !== "agentflow_storage_project_conflict_decisions" || !Array.isArray(result.decisions)) {
      warnings.push(`Skipped unrecognized project decision JSON: ${jsonPath}`);
      continue;
    }
    return {
      jsonPath,
      generatedAt: result.generatedAt ?? new Date(0).toISOString(),
      decisions: result.decisions
    };
  }
  return null;
}

export async function listBucketKeysWithMc(ctx: CliContext, input: {
  alias: string;
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}): Promise<{ ok: true; keys: string[]; verifier: McRunnerMode } | { ok: false; error: string; verifier: ObjectBucketParityProof["verifier"] }> {
  const mcConfigDir = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mc-object-proof");
  await fs.mkdir(mcConfigDir, { recursive: true, mode: 0o700 });
  const runner = await resolveMcRunner(ctx, mcConfigDir);
  if (!runner) return { ok: false, error: "Bucket enumeration needs MinIO Client or Docker minio/mc fallback.", verifier: "unavailable" };
  const aliasResult = await execMcText(ctx, runner, ["alias", "set", input.alias, runner.mapEndpoint(input.endpoint), input.accessKey, input.secretKey]);
  if (aliasResult.exitCode !== 0) {
    return { ok: false, error: compactDashboardText(aliasResult.stderr || aliasResult.stdout || `${runner.mode} alias set failed for ${input.alias}`, 300), verifier: runner.mode };
  }
  const listResult = await execMcText(ctx, runner, ["find", `${input.alias}/${input.bucket}`, "--json"]);
  if (listResult.exitCode !== 0) {
    return { ok: false, error: compactDashboardText(listResult.stderr || listResult.stdout || `${runner.mode} find failed for ${input.alias}/${input.bucket}`, 300), verifier: runner.mode };
  }
  return { ok: true, keys: parseMcFindKeys(listResult.stdout, input.alias, input.bucket), verifier: runner.mode };
}

export async function loadOfflineFallbackReport(ctx: CliContext): Promise<OfflineFallbackReport> {
  const currentServices = await checkServices();
  const localEnv = {
    DATABASE_URL: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
    REDIS_URL: "redis://127.0.0.1:16379",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000"
  };
  const localServices = await checkServices(defaultServiceEndpoints(localEnv));
  const currentServicesReachable = currentServices.every((service) => service.reachable);
  const localServicesReachable = localServices.every((service) => service.reachable);
  const mode = currentServicesReachable
    ? "shared-online"
    : localServicesReachable
      ? "local-fallback-ready"
      : localServices.some((service) => service.reachable)
        ? "offline-blocked"
        : "local-fallback-stopped";
  const queue = await readOfflineFallbackQueue(ctx).catch(() => emptyOfflineFallbackQueue());
  return {
    kind: "agentflow_offline_fallback_report",
    generatedAt: new Date().toISOString(),
    currentServicesReachable,
    currentServices,
    localServicesReachable,
    localServices,
    mode,
    queue,
    scheduler: await readOfflineSyncSchedulerStatus(ctx).catch(() => emptyOfflineSyncSchedulerStatus()),
    commands: offlineFallbackCommands(),
    notes: offlineFallbackNotes(mode)
  };
}

export async function loadStorageMergeEvidenceListing(ctx: CliContext, inputDir?: string): Promise<StorageMergeEvidenceListing> {
  const directory = path.resolve(process.cwd(), inputDir?.trim() || ".agent-workflow/migrations");
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        kind: "agentflow_storage_merge_evidence_listing",
        generatedAt,
        directory,
        latestManifest: null,
        latestImport: null,
        latestBackup: null,
        latestObjectProof: null,
        latestProjectDecisions: null,
        switchOverProof: buildStorageSwitchOverProof(null, null, null, null, null),
        conflictClassification: classifyStorageMergeConflicts(null, null),
        safePrimaryStatePlane: false,
        warnings: [`No migration evidence directory found at ${directory}.`]
      };
    }
    throw error;
  }

  const manifest = await latestMergeManifest(ctx, directory, entries, warnings);
  const importResult = await latestMergeImportResult(ctx, directory, entries, warnings);
  const backup = await latestMergeBackup(directory, entries);
  const objectProof = await latestObjectArtifactProof(ctx, directory, entries, warnings);
  const projectDecisions = await latestStorageProjectConflictDecisions(ctx, directory, entries, warnings);
  const conflictClassification = classifyStorageMergeConflicts(manifest, projectDecisions);
  const switchOverProof = buildStorageSwitchOverProof(manifest, importResult, backup, objectProof, conflictClassification);
  const safePrimaryStatePlane = switchOverProof.status === "ready";
  if (!safePrimaryStatePlane) {
    warnings.push("Shared storage is not yet fully proven as primary by local evidence: review the switch-over proof checks and run the recommended follow-up commands.");
  }
  return {
    kind: "agentflow_storage_merge_evidence_listing",
    generatedAt,
    directory,
    latestManifest: manifest,
    latestImport: importResult,
    latestBackup: backup,
    latestObjectProof: objectProof,
    latestProjectDecisions: projectDecisions,
    switchOverProof,
    conflictClassification,
    safePrimaryStatePlane,
    warnings
  };
}

export async function markOfflineFallbackQueueItemSynced(ctx: CliContext, id: string, actor: string): Promise<OfflineFallbackQueue> {
  const queue = await readOfflineFallbackQueue(ctx).catch(() => emptyOfflineFallbackQueue());
  const now = new Date().toISOString();
  let found = false;
  queue.items = queue.items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return {
      ...item,
      status: "synced",
      updatedAt: now,
      note: item.note ? `${item.note} Synced by ${actor}.` : `Synced by ${actor}.`
    };
  });
  if (!found) throw new Error(`Offline fallback queue item not found: ${id}`);
  queue.updatedAt = now;
  await writeOfflineFallbackQueue(ctx, queue);
  return queue;
}

export function mergeMcVerifier(...verifiers: ObjectBucketParityProof["verifier"][]): ObjectBucketParityProof["verifier"] {
  if (verifiers.includes("docker-mc")) return "docker-mc";
  if (verifiers.includes("mc")) return "mc";
  return "unavailable";
}

export function offlineFallbackCommands(): OfflineFallbackReport["commands"] {
  return {
    stopLocal: "docker compose -f infra/docker-compose.yml stop",
    startLocal: "docker compose -f infra/docker-compose.yml up -d",
    useShared: [
      "DATABASE_URL=postgres://agentflow:agentflow@192.0.2.10:15432/agentflow",
      "REDIS_URL=redis://192.0.2.10:16379",
      "OBJECT_STORAGE_ENDPOINT=http://192.0.2.10:19000"
    ],
    useLocal: [
      "DATABASE_URL=postgres://agentflow:agentflow@localhost:15432/agentflow",
      "REDIS_URL=redis://localhost:16379",
      "OBJECT_STORAGE_ENDPOINT=http://localhost:19000"
    ],
    syncBack: [
      "npm run storage-merge-manifest -- --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow --target-database-url \"$DATABASE_URL\" --write",
      "npm run storage-merge-import -- --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow --target-database-url \"$DATABASE_URL\"",
      "npm run storage-merge-import -- --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow --target-database-url \"$DATABASE_URL\" --execute"
    ]
  };
}

export function offlineFallbackDefaultNote(action: OfflineFallbackQueueAction): string {
  if (action === "start-local") return "Operator intends to start localhost fallback services.";
  if (action === "offline-run") return "Workflow run was created while using local fallback storage.";
  if (action === "sync-back") return "Local fallback work should be merged back into shared storage.";
  return "Operator intends to return to shared storage as the primary state plane.";
}

export function offlineFallbackNotes(mode: OfflineFallbackReport["mode"]): string[] {
  if (mode === "shared-online") {
    return [
      "Primary shared storage is reachable. Local fallback services can stay stopped until needed.",
      "Offline sync is currently operator-driven through the merge manifest/import commands."
    ];
  }
  if (mode === "local-fallback-ready") {
    return [
      "Shared storage appears unavailable but local fallback services are reachable.",
      "Point the local environment at localhost before running new offline work, then sync back when shared storage returns."
    ];
  }
  if (mode === "local-fallback-stopped") {
    return [
      "Shared storage appears unavailable and local fallback services are stopped.",
      "Start local fallback services before queueing offline workflow runs."
    ];
  }
  return [
    "Some fallback services are reachable but not all. Repair local Docker services before relying on offline workflow execution."
  ];
}

export async function queueObjectMirrorApproval(ctx: CliContext, input: {
  projectPath?: string;
  report: ObjectArtifactProofReport;
  sourceEndpoint: string;
  sourceBucket: string;
  targetEndpoint: string;
  targetBucket: string;
  actor: string;
  actorRole: string;
}): Promise<DashboardFollowUpResult & { approvalId?: string }> {
  if (!input.projectPath) {
    return { ok: false, error: "Queueing object mirror approval requires --project so roles and receipts are project-scoped." };
  }
  if (!input.report.bucketParity) {
    return { ok: false, error: "Queueing object mirror approval requires --enumerate-buckets so missing target keys are known." };
  }
  if (input.report.bucketParity.status !== "missing" || input.report.bucketParity.missingInTarget <= 0) {
    return { ok: false, error: `No mirror approval needed. Bucket parity status is ${input.report.bucketParity.status}.` };
  }
  let sourceEndpoint: string;
  let targetEndpoint: string;
  try {
    sourceEndpoint = validateObjectMirrorEndpoint(input.sourceEndpoint, "source endpoint");
    targetEndpoint = validateObjectMirrorEndpoint(input.targetEndpoint, "target endpoint");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (sourceEndpoint === targetEndpoint && input.sourceBucket === input.targetBucket) {
    return { ok: false, error: "Source and target object buckets resolve to the same endpoint and bucket." };
  }

  const projectDir = path.resolve(process.cwd(), input.projectPath);
  const configuredProject = await loadProjectConfig(projectDir);
  const requestRoleGate = evaluateRoleGate(configuredProject, input.actorRole, "can_request_approvals");
  if (!requestRoleGate.allowed) {
    return { ok: false, error: requestRoleGate.message };
  }
  const resolvedPolicy = resolveExecutionPolicy(configuredProject, "local");
  const workflows = await loadWorkflows(ctx.rootDir);
  const workflow = resolveWorkflow(workflows, "maintain-context");
  if (!workflow) {
    return { ok: false, error: "The maintain-context workflow is required to queue object mirror approvals." };
  }
  const agents = await loadAgentRecords(ctx.rootDir);
  const workflowRecords = await loadWorkflowRecords(ctx.rootDir);
  await seedRegistry(agents, workflowRecords);
  const target = `${input.sourceBucket} -> ${input.targetBucket}`;
  const payload = {
    requestType: "object_mirror",
    sourceEndpoint,
    sourceBucket: input.sourceBucket,
    targetEndpoint,
    targetBucket: input.targetBucket,
    missingInTarget: input.report.bucketParity.missingInTarget,
    sampledMissingKeys: input.report.bucketParity.sampledMissingKeys,
    mirrorMode: "copy-missing-only",
    overwrite: false,
    requestedBy: input.actor,
    requestedByRole: input.actorRole,
    requestedAt: new Date().toISOString()
  };
  const idempotencyKey = stableHash({
    objectMirror: true,
    projectDir,
    sourceEndpoint,
    sourceBucket: input.sourceBucket,
    targetEndpoint,
    targetBucket: input.targetBucket,
    missingInTarget: input.report.bucketParity.missingInTarget,
    sampledMissingKeys: input.report.bucketParity.sampledMissingKeys
  });
  const run = await createWorkflowRun({
    projectName: resolvedPolicy.project.project.name,
    projectRootUri: projectDir,
    projectProfile: "custom",
    projectConfig: configuredProject,
    workflow,
    task: `Approval requested to mirror missing object artifacts: ${target}`,
    autonomy: String(resolvedPolicy.project.project.autonomy),
    policyProfile: resolvedPolicy.profile,
    policySnapshot: resolvedPolicy.snapshot,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    compiledBrief: [
      "# Object Mirror Approval",
      "",
      `Source: ${sourceEndpoint}/${input.sourceBucket}`,
      `Target: ${targetEndpoint}/${input.targetBucket}`,
      `Missing target keys: ${input.report.bucketParity.missingInTarget}`,
      "Mode: copy missing objects only; do not overwrite target objects.",
      "",
      "## Sample Missing Keys",
      ...input.report.bucketParity.sampledMissingKeys.map((key) => `- ${key}`)
    ].join("\n"),
    compiledBriefMetadata: {
      objectMirror: payload
    }
  });
  const approval = await requestActionApproval({
    runId: run.runId,
    taskId: null,
    stageId: "object-mirror-approval",
    agentId: workflow.lead,
    actionType: "object_mirror",
    target,
    rationale: `Mirror ${input.report.bucketParity.missingInTarget} source object(s) missing from the target bucket after shared-storage migration proof.`,
    policyDecision: {
      approvalRequired: true,
      requestType: "object_mirror",
      actorRole: input.actorRole,
      policyProfile: resolvedPolicy.profile,
      policySnapshotHash: resolvedPolicy.snapshotHash,
      overwrite: false
    },
    payload,
    idempotencyKey
  });
  await completeApprovalRequestRun({
    runId: run.runId,
    agentId: workflow.lead,
    summary: `Object mirror approval queued for ${target}`,
    metadata: {
      ...payload,
      target,
      approvalId: approval.approvalId
    }
  });
  return {
    ok: true,
    title: "Object mirror approval queued",
    runId: run.runId,
    approvalId: approval.approvalId,
    output: [
      `Approval: ${approval.approvalId}`,
      `Run: ${run.runId}`,
      `Source: ${sourceEndpoint}/${input.sourceBucket}`,
      `Target: ${targetEndpoint}/${input.targetBucket}`,
      `Missing target objects: ${input.report.bucketParity.missingInTarget}`,
      `Role gate: ${requestRoleGate.message}`,
      "Approve and execute from /approvals or with:",
      `npm run agentflow -- approvals --approve-execute ${approval.approvalId} --actor "${input.actor}" --actor-role approver`
    ].join("\n")
  };
}

export async function recordOfflineFallbackQueueItem(ctx: CliContext, input: {
  action: OfflineFallbackQueueAction;
  projectRootUri?: string;
  runId?: string;
  note?: string;
  actor: string;
}): Promise<{ item: OfflineFallbackQueueItem; queue: OfflineFallbackQueue }> {
  const queue = await readOfflineFallbackQueue(ctx).catch(() => emptyOfflineFallbackQueue());
  const now = new Date().toISOString();
  const item: OfflineFallbackQueueItem = {
    id: randomUUID(),
    action: input.action,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    actor: input.actor,
    projectRootUri: input.projectRootUri ?? null,
    runId: input.runId ?? null,
    note: input.note?.trim() || offlineFallbackDefaultNote(input.action)
  };
  queue.updatedAt = now;
  queue.items = [item, ...queue.items].slice(0, 500);
  await writeOfflineFallbackQueue(ctx, queue);
  return { item, queue };
}

export async function resolveMcRunner(ctx: CliContext, configDir: string): Promise<McRunner | null> {
  if (await commandAvailable(ctx, "mc")) {
    return {
      mode: "mc",
      command: "mc",
      argsPrefix: [],
      env: { ...process.env, MC_CONFIG_DIR: configDir },
      mapEndpoint: (endpoint) => endpoint
    };
  }
  if (await commandAvailable(ctx, "docker")) {
    const image = process.env.AGENTFLOW_MC_DOCKER_IMAGE || "minio/mc";
    return {
      mode: "docker-mc",
      command: "docker",
      argsPrefix: [
        "run",
        "--rm",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--volume",
        `${configDir}:/mc-config`,
        "--env",
        "MC_CONFIG_DIR=/mc-config",
        image
      ],
      env: process.env,
      mapEndpoint: dockerReachableObjectEndpoint
    };
  }
  return null;
}

export async function safeStat(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

export async function verifyObjectReferencesWithMc(ctx: CliContext, refs: ObjectArtifactReferenceProof[], input: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}): Promise<ObjectArtifactProofReport["verification"]> {
  const mcConfigDir = path.join(ctx.rootDir, ".agent-workflow", "runtime", "mc-object-proof");
  await fs.mkdir(mcConfigDir, { recursive: true, mode: 0o700 });
  const runner = await resolveMcRunner(ctx, mcConfigDir);
  if (!runner) {
    for (const ref of refs) {
      ref.status = "not-checked";
      ref.message = "MinIO Client and Docker minio/mc fallback are unavailable.";
    }
    return "unavailable";
  }
  const aliasResult = await execMcText(ctx, runner, ["alias", "set", "agentflow-object-proof", runner.mapEndpoint(input.endpoint), input.accessKey, input.secretKey]);
  if (aliasResult.exitCode !== 0) {
    for (const ref of refs) {
      ref.status = "missing";
      ref.message = compactDashboardText(aliasResult.stderr || aliasResult.stdout || `${runner.mode} alias setup failed`, 300);
    }
    return runner.mode;
  }
  for (const ref of refs.slice(0, 200)) {
    const result = await execMcText(ctx, runner, ["stat", `agentflow-object-proof/${input.bucket}/${ref.key}`]);
    ref.status = result.exitCode === 0 ? "present" : "missing";
    ref.message = result.exitCode === 0 ? "present" : compactDashboardText(result.stderr || result.stdout || "object missing", 300);
  }
  return runner.mode;
}

export async function writeStorageProjectConflictDecision(ctx: CliContext, input: {
  outDir: string;
  rootUri: string;
  action: string;
  sourceProjectId?: string;
  targetProjectId?: string;
  reviewer: string;
  note: string;
}): Promise<{ jsonPath: string; decisionCount: number }> {
  const directory = path.resolve(process.cwd(), input.outDir);
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory).catch(() => []);
  const latest = await latestStorageProjectConflictDecisions(ctx, directory, entries, []);
  const decidedAt = new Date().toISOString();
  const decisions = [
    ...(latest?.decisions ?? []).filter((decision) => decision.rootUri !== input.rootUri),
    {
      rootUri: input.rootUri,
      action: input.action,
      sourceProjectId: input.sourceProjectId ?? null,
      targetProjectId: input.targetProjectId ?? null,
      reviewer: input.reviewer,
      note: input.note,
      decidedAt
    }
  ].sort((a, b) => a.rootUri.localeCompare(b.rootUri));
  const jsonPath = path.join(directory, "storage-project-decisions.json");
  const tempPath = path.join(directory, `storage-project-decisions-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify({
    kind: "agentflow_storage_project_conflict_decisions",
    generatedAt: decidedAt,
    decisions
  }, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, jsonPath);
  return { jsonPath, decisionCount: decisions.length };
}

import { defaultServiceEndpoints, type ServiceEndpoint } from "./config.js";
import { checkServices, type ServiceCheck } from "./doctor.js";
import { buildStorageVerificationReport, type StorageVerificationDiff, type StorageVerificationReport } from "./verification.js";

export type StorageMigrationPlanStatus = "ready" | "attention" | "blocked";

export interface StorageMigrationPlanInput {
  sourceEnv?: NodeJS.ProcessEnv;
  targetEnv?: NodeJS.ProcessEnv;
  targetHost?: string;
  sourceDatabaseUrl?: string;
  sourceRedisUrl?: string;
  sourceObjectStorageEndpoint?: string;
  sourceObjectStorageBucket?: string;
  targetDatabaseUrl?: string;
  targetRedisUrl?: string;
  targetObjectStorageEndpoint?: string;
  targetObjectStorageBucket?: string;
  mode?: "copy-empty-target" | "merge-preview";
  verificationReport?: StorageVerificationReport;
  sourceChecks?: ServiceCheck[];
  targetChecks?: ServiceCheck[];
}

export interface StorageMigrationPlan {
  kind: "agentflow_storage_migration_plan";
  generatedAt: string;
  status: StorageMigrationPlanStatus;
  mode: "copy-empty-target" | "merge-preview";
  source: StorageMigrationEndpointSummary;
  target: StorageMigrationEndpointSummary;
  sourceChecks: ServiceCheck[];
  targetChecks: ServiceCheck[];
  steps: StorageMigrationStep[];
  requiredTools: StorageMigrationToolCheck[];
  mergePreview?: StorageMigrationMergePreview;
  notes: string[];
  warnings: string[];
}

export interface StorageMigrationMergePreview {
  status: StorageMigrationPlanStatus;
  sourceRows: number;
  targetRows: number;
  sourceOnlyProjectRoots: string[];
  targetOnlyProjectRoots: string[];
  overlappingProjectRoots: string[];
  tableDiffs: StorageVerificationDiff[];
  recommendations: string[];
}

export interface StorageMigrationEndpointSummary {
  databaseUrl: string;
  redisUrl: string;
  objectStorageEndpoint: string;
  objectStorageBucket: string;
}

export interface StorageMigrationStep {
  id: string;
  title: string;
  risk: "low" | "medium" | "high";
  command: string;
  description: string;
}

export interface StorageMigrationToolCheck {
  name: string;
  required: boolean;
  installHint: string;
}

export async function buildStorageMigrationPlan(input: StorageMigrationPlanInput): Promise<StorageMigrationPlan> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const targetEnv = input.targetEnv ?? {};
  const targetHost = input.targetHost ?? sourceEnv.AGENTFLOW_SHARED_STORAGE_HOST ?? targetEnv.AGENTFLOW_SHARED_STORAGE_HOST;
  const source = storageEndpointSummary({
    databaseUrl: input.sourceDatabaseUrl ?? sourceEnv.DATABASE_URL,
    redisUrl: input.sourceRedisUrl ?? sourceEnv.REDIS_URL,
    objectStorageEndpoint: input.sourceObjectStorageEndpoint ?? sourceEnv.OBJECT_STORAGE_ENDPOINT,
    objectStorageBucket: input.sourceObjectStorageBucket ?? sourceEnv.OBJECT_STORAGE_BUCKET
  });
  const target = storageEndpointSummary({
    databaseUrl: input.targetDatabaseUrl ?? targetEnv.DATABASE_URL ?? endpointUrlWhenHostMatches(source.databaseUrl, targetHost),
    redisUrl: input.targetRedisUrl ?? targetEnv.REDIS_URL ?? endpointUrlWhenHostMatches(source.redisUrl, targetHost),
    objectStorageEndpoint: input.targetObjectStorageEndpoint ?? targetEnv.OBJECT_STORAGE_ENDPOINT ?? endpointUrlWhenHostMatches(source.objectStorageEndpoint, targetHost),
    objectStorageBucket: input.targetObjectStorageBucket ?? targetEnv.OBJECT_STORAGE_BUCKET
  }, targetHost);
  const sourceChecks = input.sourceChecks ?? await checkServices(defaultServiceEndpoints({
    DATABASE_URL: source.databaseUrl,
    REDIS_URL: source.redisUrl,
    OBJECT_STORAGE_ENDPOINT: source.objectStorageEndpoint
  }));
  const targetChecks = input.targetChecks ?? await checkServices(defaultServiceEndpoints({
    DATABASE_URL: target.databaseUrl,
    REDIS_URL: target.redisUrl,
    OBJECT_STORAGE_ENDPOINT: target.objectStorageEndpoint
  }));
  const verification = input.verificationReport ?? await buildStorageVerificationReport({
    sourceDatabaseUrl: source.databaseUrl,
    sourceRedisUrl: source.redisUrl,
    sourceObjectStorageEndpoint: source.objectStorageEndpoint,
    sourceObjectStorageBucket: source.objectStorageBucket,
    targetDatabaseUrl: target.databaseUrl,
    targetRedisUrl: target.redisUrl,
    targetObjectStorageEndpoint: target.objectStorageEndpoint,
    targetObjectStorageBucket: target.objectStorageBucket
  });
  const mode = input.mode ?? "copy-empty-target";
  const mergePreview = buildStorageMigrationMergePreview(verification);
  const targetNonEmpty = storageSnapshotHasDurableRows(verification.target);
  const warnings = [
    ...serviceWarnings("source", sourceChecks),
    ...serviceWarnings("target", targetChecks),
    ...sameEndpointWarnings(source, target),
    ...(mode === "copy-empty-target" && targetNonEmpty ? ["target storage is not empty; copy-empty-target mode would risk overwriting or colliding with existing shared history. Use --mode merge-preview."] : []),
    ...(mode === "merge-preview" ? ["Merge mode is dry-run/preflight only. It does not currently write source rows into the target."] : [])
  ];
  const blocked = targetChecks.some((check) => !check.reachable) ||
    sourceChecks.some((check) => !check.reachable) ||
    sameEndpointWarnings(source, target).length > 0 ||
    verification.status === "blocked" ||
    mode === "copy-empty-target" && targetNonEmpty;
  const status: StorageMigrationPlanStatus = blocked
    ? "blocked"
    : warnings.length
      ? "attention"
      : "ready";
  return {
    kind: "agentflow_storage_migration_plan",
    generatedAt: new Date().toISOString(),
    status,
    mode: input.mode ?? "copy-empty-target",
    source: redactedEndpointSummary(source),
    target: redactedEndpointSummary(target),
    sourceChecks,
    targetChecks,
    steps: storageMigrationSteps(mode),
    requiredTools: [
      { name: "pg_dump", required: true, installHint: "Install PostgreSQL client tools." },
      { name: "pg_restore", required: true, installHint: "Install PostgreSQL client tools." },
      { name: "mc", required: false, installHint: "Install MinIO Client to mirror object storage artifacts." }
    ],
    ...(mode === "merge-preview" ? { mergePreview } : {}),
    notes: [
      "Dry-run plan only. This command does not copy, delete, overwrite, or mutate source or target storage.",
      mode === "copy-empty-target"
        ? "Use a fresh destination database for copy-empty-target mode."
        : "Merge preview preserves target data and identifies source history that needs a future merge-safe importer.",
      "Keep Postgres, Redis, and MinIO reachable only on trusted LAN/Tailscale networks.",
      "Run doctor, governance, backup-report, and restore-drill against the destination before switching clients."
    ],
    warnings
  };
}

export function formatStorageMigrationPlan(plan: StorageMigrationPlan): string {
  return [
    `Shared storage migration plan (${plan.generatedAt})`,
    `Status: ${plan.status}`,
    `Mode: ${plan.mode}`,
    "",
    "Source:",
    `- Database: ${plan.source.databaseUrl}`,
    `- Redis: ${plan.source.redisUrl}`,
    `- Object storage: ${plan.source.objectStorageEndpoint}`,
    `- Bucket: ${plan.source.objectStorageBucket}`,
    "",
    "Target:",
    `- Database: ${plan.target.databaseUrl}`,
    `- Redis: ${plan.target.redisUrl}`,
    `- Object storage: ${plan.target.objectStorageEndpoint}`,
    `- Bucket: ${plan.target.objectStorageBucket}`,
    "",
    "Source checks:",
    ...plan.sourceChecks.map(formatServiceCheck),
    "",
    "Target checks:",
    ...plan.targetChecks.map(formatServiceCheck),
    "",
    "Steps:",
    ...plan.steps.map((step) => `- ${step.title} [${step.risk}]\n  ${step.description}\n  ${step.command}`),
    "",
    "Required tools:",
    ...plan.requiredTools.map((tool) => `- ${tool.name}${tool.required ? " (required)" : " (optional)"}: ${tool.installHint}`),
    ...(plan.mergePreview ? [
      "",
      "Merge preview:",
      `- Status: ${plan.mergePreview.status}`,
      `- Source durable rows: ${plan.mergePreview.sourceRows}`,
      `- Target durable rows: ${plan.mergePreview.targetRows}`,
      `- Source-only sampled project roots: ${plan.mergePreview.sourceOnlyProjectRoots.length ? plan.mergePreview.sourceOnlyProjectRoots.join(", ") : "none"}`,
      `- Target-only sampled project roots: ${plan.mergePreview.targetOnlyProjectRoots.length ? plan.mergePreview.targetOnlyProjectRoots.join(", ") : "none"}`,
      `- Overlapping sampled project roots: ${plan.mergePreview.overlappingProjectRoots.length ? plan.mergePreview.overlappingProjectRoots.join(", ") : "none"}`,
      "Recommendations:",
      ...plan.mergePreview.recommendations.map((item) => `- ${item}`)
    ] : []),
    "",
    "Warnings:",
    ...(plan.warnings.length ? plan.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Notes:",
    ...plan.notes.map((note) => `- ${note}`)
  ].join("\n");
}

export function storageMigrationScript(mode: "copy-empty-target" | "merge-preview" = "copy-empty-target"): string {
  if (mode === "merge-preview") {
    return `#!/usr/bin/env bash
set -euo pipefail

cat <<'MESSAGE'
This is a merge-preview operator package.

No merge execution script is generated yet because the target storage plane is
expected to contain existing history. Review the Markdown and JSON preflight
first, back up both databases, and use a future merge-safe importer that maps
projects by root_uri while preserving target ids and existing target history.
MESSAGE

exit 2
`;
  }
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${AGENTFLOW_EXECUTE_STORAGE_MIGRATION:-0}" != "1" ]]; then
  echo "Dry-run only. Set AGENTFLOW_EXECUTE_STORAGE_MIGRATION=1 after reviewing the plan and backups."
  exit 2
fi

: "\${SOURCE_DATABASE_URL:?Set SOURCE_DATABASE_URL}"
: "\${SOURCE_REDIS_URL:?Set SOURCE_REDIS_URL}"
: "\${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL}"
: "\${TARGET_REDIS_URL:?Set TARGET_REDIS_URL}"
: "\${SOURCE_OBJECT_STORAGE_ENDPOINT:?Set SOURCE_OBJECT_STORAGE_ENDPOINT}"
: "\${SOURCE_OBJECT_STORAGE_BUCKET:?Set SOURCE_OBJECT_STORAGE_BUCKET}"
: "\${SOURCE_OBJECT_STORAGE_ACCESS_KEY:?Set SOURCE_OBJECT_STORAGE_ACCESS_KEY}"
: "\${SOURCE_OBJECT_STORAGE_SECRET_KEY:?Set SOURCE_OBJECT_STORAGE_SECRET_KEY}"
: "\${TARGET_OBJECT_STORAGE_ENDPOINT:?Set TARGET_OBJECT_STORAGE_ENDPOINT}"
: "\${TARGET_OBJECT_STORAGE_BUCKET:?Set TARGET_OBJECT_STORAGE_BUCKET}"
: "\${TARGET_OBJECT_STORAGE_ACCESS_KEY:?Set TARGET_OBJECT_STORAGE_ACCESS_KEY}"
: "\${TARGET_OBJECT_STORAGE_SECRET_KEY:?Set TARGET_OBJECT_STORAGE_SECRET_KEY}"

if [[ "$SOURCE_DATABASE_URL" == "$TARGET_DATABASE_URL" ]]; then
  echo "Refusing to migrate: SOURCE_DATABASE_URL and TARGET_DATABASE_URL are identical."
  exit 2
fi

if [[ "$SOURCE_OBJECT_STORAGE_ENDPOINT/$SOURCE_OBJECT_STORAGE_BUCKET" == "$TARGET_OBJECT_STORAGE_ENDPOINT/$TARGET_OBJECT_STORAGE_BUCKET" ]]; then
  echo "Refusing to migrate: source and target object storage endpoint/bucket are identical."
  exit 2
fi

BACKUP_DIR="\${AGENTFLOW_STORAGE_MIGRATION_DIR:-.agent-workflow/migrations/run-\$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$BACKUP_DIR"

echo "Dumping source Postgres to $BACKUP_DIR/agentflow.pgcustom"
pg_dump "$SOURCE_DATABASE_URL" --format=custom --no-owner --no-acl --file "$BACKUP_DIR/agentflow.pgcustom"

echo "Restoring Postgres dump to target database"
pg_restore --dbname "$TARGET_DATABASE_URL" --no-owner --no-acl --single-transaction "$BACKUP_DIR/agentflow.pgcustom"

echo "Mirroring object storage artifacts"
mc alias set agentflow-source "$SOURCE_OBJECT_STORAGE_ENDPOINT" "$SOURCE_OBJECT_STORAGE_ACCESS_KEY" "$SOURCE_OBJECT_STORAGE_SECRET_KEY"
mc alias set agentflow-target "$TARGET_OBJECT_STORAGE_ENDPOINT" "$TARGET_OBJECT_STORAGE_ACCESS_KEY" "$TARGET_OBJECT_STORAGE_SECRET_KEY"
mc mirror "agentflow-source/$SOURCE_OBJECT_STORAGE_BUCKET" "agentflow-target/$TARGET_OBJECT_STORAGE_BUCKET"

cat <<'NEXT'
Migration copy completed.

Next verification:
  DATABASE_URL="$TARGET_DATABASE_URL" REDIS_URL="$TARGET_REDIS_URL" OBJECT_STORAGE_ENDPOINT="$TARGET_OBJECT_STORAGE_ENDPOINT" OBJECT_STORAGE_BUCKET="$TARGET_OBJECT_STORAGE_BUCKET" npm run migrate-storage
  DATABASE_URL="$TARGET_DATABASE_URL" REDIS_URL="$TARGET_REDIS_URL" OBJECT_STORAGE_ENDPOINT="$TARGET_OBJECT_STORAGE_ENDPOINT" OBJECT_STORAGE_BUCKET="$TARGET_OBJECT_STORAGE_BUCKET" npm run bootstrap-storage
  DATABASE_URL="$TARGET_DATABASE_URL" REDIS_URL="$TARGET_REDIS_URL" OBJECT_STORAGE_ENDPOINT="$TARGET_OBJECT_STORAGE_ENDPOINT" OBJECT_STORAGE_BUCKET="$TARGET_OBJECT_STORAGE_BUCKET" npm run doctor
  DATABASE_URL="$TARGET_DATABASE_URL" REDIS_URL="$TARGET_REDIS_URL" OBJECT_STORAGE_ENDPOINT="$TARGET_OBJECT_STORAGE_ENDPOINT" OBJECT_STORAGE_BUCKET="$TARGET_OBJECT_STORAGE_BUCKET" npm run agentflow -- governance
  DATABASE_URL="$TARGET_DATABASE_URL" REDIS_URL="$TARGET_REDIS_URL" OBJECT_STORAGE_ENDPOINT="$TARGET_OBJECT_STORAGE_ENDPOINT" OBJECT_STORAGE_BUCKET="$TARGET_OBJECT_STORAGE_BUCKET" npm run agentflow -- backup-report
NEXT
`;
}

function storageEndpointSummary(
  input: { databaseUrl?: string; redisUrl?: string; objectStorageEndpoint?: string; objectStorageBucket?: string },
  targetHost?: string
): StorageMigrationEndpointSummary {
  return {
    databaseUrl: input.databaseUrl ?? (targetHost ? `postgres://agentflow:agentflow@${targetHost}:15432/agentflow` : "postgres://agentflow:agentflow@localhost:15432/agentflow"),
    redisUrl: input.redisUrl ?? (targetHost ? `redis://${targetHost}:16379` : "redis://localhost:16379"),
    objectStorageEndpoint: input.objectStorageEndpoint ?? (targetHost ? `http://${targetHost}:19000` : "http://localhost:19000"),
    objectStorageBucket: input.objectStorageBucket ?? "agentflow-artifacts"
  };
}

function redactedEndpointSummary(summary: StorageMigrationEndpointSummary): StorageMigrationEndpointSummary {
  return {
    databaseUrl: redactUrl(summary.databaseUrl),
    redisUrl: redactUrl(summary.redisUrl),
    objectStorageEndpoint: redactUrl(summary.objectStorageEndpoint),
    objectStorageBucket: summary.objectStorageBucket
  };
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

function serviceWarnings(prefix: string, checks: ServiceCheck[]): string[] {
  return checks
    .filter((check) => !check.reachable)
    .map((check) => `${prefix} ${check.endpoint.name} is not reachable: ${check.message}`);
}

function sameEndpointWarnings(source: StorageMigrationEndpointSummary, target: StorageMigrationEndpointSummary): string[] {
  const warnings: string[] = [];
  if (canonicalUrl(source.databaseUrl) === canonicalUrl(target.databaseUrl)) {
    warnings.push("source and target database URLs point to the same endpoint");
  }
  if (canonicalUrl(source.redisUrl) === canonicalUrl(target.redisUrl)) {
    warnings.push("source and target Redis URLs point to the same endpoint");
  }
  if (canonicalUrl(source.objectStorageEndpoint) === canonicalUrl(target.objectStorageEndpoint) && source.objectStorageBucket === target.objectStorageBucket) {
    warnings.push("source and target object storage point to the same endpoint and bucket");
  }
  return warnings;
}

function endpointUrlWhenHostMatches(value: string, host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(value).hostname === host ? value : undefined;
  } catch {
    return undefined;
  }
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

function formatServiceCheck(check: ServiceCheck): string {
  return `- ${check.reachable ? "OK" : "MISSING"} ${check.endpoint.name}: ${check.message}`;
}

function storageMigrationSteps(mode: "copy-empty-target" | "merge-preview"): StorageMigrationStep[] {
  if (mode === "merge-preview") {
    return [
      {
        id: "inspect",
        title: "Inspect source and target state",
        risk: "low",
        description: "Compare project roots, run counts, artifacts, approvals, receipts, memory, and index state before designing a merge.",
        command: "npm run agentflow -- storage-migrate --mode merge-preview --json"
      },
      {
        id: "backup-both",
        title: "Back up source and target databases",
        risk: "low",
        description: "Create restorable backups of both storage planes before any future merge importer runs.",
        command: "pg_dump \"$SOURCE_DATABASE_URL\" --format=custom --no-owner --no-acl --file \"$BACKUP_DIR/source-agentflow.pgcustom\" && pg_dump \"$TARGET_DATABASE_URL\" --format=custom --no-owner --no-acl --file \"$BACKUP_DIR/target-agentflow.pgcustom\""
      },
      {
        id: "map-identities",
        title: "Map projects and dependent rows",
        risk: "medium",
        description: "Match projects by root_uri, preserve existing target ids, and plan source-only inserts for runs, tasks, receipts, approvals, artifacts, memory, and index state.",
        command: "agentflow storage-migrate --mode merge-preview --json"
      },
      {
        id: "mirror-source-only-objects",
        title: "Mirror source-only object artifacts",
        risk: "medium",
        description: "Copy only artifact objects referenced by imported source rows after object-key enumeration is available.",
        command: "mc mirror --watch=false \"agentflow-source/$SOURCE_OBJECT_STORAGE_BUCKET\" \"agentflow-target/$TARGET_OBJECT_STORAGE_BUCKET\""
      }
    ];
  }
  return [
    {
      id: "backup-source",
      title: "Create source database backup",
      risk: "low",
      description: "Dump the current local Agent Workflow Postgres database without changing it.",
      command: "pg_dump \"$SOURCE_DATABASE_URL\" --format=custom --no-owner --no-acl --file \"$BACKUP_DIR/agentflow.pgcustom\""
    },
    {
      id: "restore-target",
      title: "Restore into empty target database",
      risk: "medium",
      description: "Restore the dump into the shared storage host database. Use an empty target database for this first implementation.",
      command: "pg_restore --dbname \"$TARGET_DATABASE_URL\" --no-owner --no-acl --single-transaction \"$BACKUP_DIR/agentflow.pgcustom\""
    },
    {
      id: "mirror-objects",
      title: "Mirror object storage bucket",
      risk: "medium",
      description: "Copy Agent Workflow artifacts from source MinIO to target MinIO with MinIO Client.",
      command: "mc mirror \"agentflow-source/$SOURCE_OBJECT_STORAGE_BUCKET\" \"agentflow-target/$TARGET_OBJECT_STORAGE_BUCKET\""
    },
    {
      id: "verify-target",
      title: "Verify destination storage",
      risk: "low",
      description: "Run migrations, seed shared definitions, and inspect governance/backup readiness against the target.",
      command: "DATABASE_URL=\"$TARGET_DATABASE_URL\" REDIS_URL=\"$TARGET_REDIS_URL\" OBJECT_STORAGE_ENDPOINT=\"$TARGET_OBJECT_STORAGE_ENDPOINT\" OBJECT_STORAGE_BUCKET=\"$TARGET_OBJECT_STORAGE_BUCKET\" npm run migrate-storage && DATABASE_URL=\"$TARGET_DATABASE_URL\" REDIS_URL=\"$TARGET_REDIS_URL\" OBJECT_STORAGE_ENDPOINT=\"$TARGET_OBJECT_STORAGE_ENDPOINT\" OBJECT_STORAGE_BUCKET=\"$TARGET_OBJECT_STORAGE_BUCKET\" npm run bootstrap-storage && DATABASE_URL=\"$TARGET_DATABASE_URL\" REDIS_URL=\"$TARGET_REDIS_URL\" OBJECT_STORAGE_ENDPOINT=\"$TARGET_OBJECT_STORAGE_ENDPOINT\" OBJECT_STORAGE_BUCKET=\"$TARGET_OBJECT_STORAGE_BUCKET\" npm run doctor"
    }
  ];
}

function buildStorageMigrationMergePreview(report: StorageVerificationReport): StorageMigrationMergePreview {
  const sourceRows = totalSnapshotRows(report.source.tables);
  const targetRows = totalSnapshotRows(report.target.tables);
  const sourceRoots = new Set(report.source.sampledProjectRoots);
  const targetRoots = new Set(report.target.sampledProjectRoots);
  const sourceOnlyProjectRoots = [...sourceRoots].filter((root) => !targetRoots.has(root)).sort();
  const targetOnlyProjectRoots = [...targetRoots].filter((root) => !sourceRoots.has(root)).sort();
  const overlappingProjectRoots = [...sourceRoots].filter((root) => targetRoots.has(root)).sort();
  const blocked = report.status === "blocked" || report.warnings.some((warning) => warning.includes("same endpoint"));
  const status: StorageMigrationPlanStatus = blocked
    ? "blocked"
    : sourceRows === 0
      ? "attention"
      : "attention";
  const recommendations = [
    "Do not run copy-empty-target against a non-empty shared target.",
    "Use project root_uri to map overlapping projects and preserve target project ids.",
    "Import only source-only runs, tasks, receipts, approvals, artifacts, memory, and index rows after dependency mapping is reviewed.",
    "Back up both source and target Postgres databases before any write-capable merge importer exists.",
    "Mirror only source-only object artifacts after bucket enumeration can prove the required object keys."
  ];
  if (!sourceOnlyProjectRoots.length && overlappingProjectRoots.length) {
    recommendations.push("Most sampled source project roots already exist on the target; prioritize historical run/artifact merge over project creation.");
  }
  return {
    status,
    sourceRows,
    targetRows,
    sourceOnlyProjectRoots,
    targetOnlyProjectRoots,
    overlappingProjectRoots,
    tableDiffs: report.diffs,
    recommendations
  };
}

function storageSnapshotHasDurableRows(snapshot: StorageVerificationReport["target"]): boolean {
  return snapshot.tables.some((table) => table.exists && (table.count ?? 0) > 0);
}

function totalSnapshotRows(tables: StorageVerificationReport["source"]["tables"]): number {
  return tables.reduce((sum, table) => sum + (table.count ?? 0), 0);
}

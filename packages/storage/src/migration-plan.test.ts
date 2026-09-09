import assert from "node:assert/strict";
import test from "node:test";
import { buildStorageMigrationPlan, storageMigrationScript } from "./migration-plan.js";
import type { ServiceCheck } from "./doctor.js";
import type { StorageVerificationReport } from "./verification.js";

test("storage migration plan infers a shared target host and redacts secrets", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetHost: "shared-host.example",
    targetEnv: {}
  });

  assert.match(plan.target.databaseUrl, /shared-host\.example:15432/);
  assert.match(plan.target.redisUrl, /shared-host\.example:16379/);
  assert.equal(plan.target.objectStorageEndpoint, "http://shared-host.example:19000/");
  assert.equal(plan.target.objectStorageBucket, "agentflow-artifacts");
  assert.doesNotMatch(JSON.stringify(plan), /local-secret/);
});

test("storage migration script requires explicit execution opt-in", () => {
  const script = storageMigrationScript();
  assert.match(script, /AGENTFLOW_EXECUTE_STORAGE_MIGRATION/);
  assert.match(script, /Refusing to migrate/);
  assert.match(script, /TARGET_REDIS_URL/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /mc mirror/);
});

test("storage migration merge preview script is non-executable", () => {
  const script = storageMigrationScript("merge-preview");
  assert.match(script, /merge-preview operator package/);
  assert.match(script, /No merge execution script is generated yet/);
  assert.doesNotMatch(script, /pg_restore/);
  assert.doesNotMatch(script, /mc mirror/);
});

test("storage migration plan can use the shared storage host env fallback", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      AGENTFLOW_SHARED_STORAGE_HOST: "192.0.2.10",
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetEnv: {}
  });

  assert.match(plan.target.databaseUrl, /192\.0\.2\.10:15432/);
  assert.match(plan.target.redisUrl, /192\.0\.2\.10:16379/);
  assert.equal(plan.target.objectStorageEndpoint, "http://192.0.2.10:19000/");
});

test("storage migration plan blocks same source and target endpoints", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetHost: "127.0.0.1",
    targetEnv: {}
  });

  assert.equal(plan.status, "blocked");
  assert.match(plan.warnings.join("\n"), /same endpoint/);
});

test("storage migration plan blocks copy into a non-empty target", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: localSourceEnv(),
    targetEnv: sharedTargetEnv(),
    sourceChecks: reachableChecks("127.0.0.1"),
    targetChecks: reachableChecks("192.0.2.10"),
    verificationReport: verificationReport({
      sourceRows: { projects: 10, workflow_runs: 169, artifacts: 2001 },
      targetRows: { projects: 48, workflow_runs: 18, artifacts: 343 },
      sourceRoots: ["/Users/example/Projects/project-a"],
      targetRoots: ["/Users/example/Projects/project-a", "/Users/example/Projects/project-b"]
    })
  });

  assert.equal(plan.status, "blocked");
  assert.match(plan.warnings.join("\n"), /target storage is not empty/);
  assert.equal(plan.mergePreview, undefined);
});

test("storage migration merge preview summarizes mismatched local and shared storage", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: localSourceEnv(),
    targetEnv: sharedTargetEnv(),
    mode: "merge-preview",
    sourceChecks: reachableChecks("127.0.0.1"),
    targetChecks: reachableChecks("192.0.2.10"),
    verificationReport: verificationReport({
      sourceRows: { projects: 10, workflow_runs: 169, artifacts: 2001, memory_items: 13 },
      targetRows: { projects: 48, workflow_runs: 18, artifacts: 343 },
      sourceRoots: ["/Users/example/Projects/project-a"],
      targetRoots: ["/Users/example/Projects/project-a", "/Users/example/Projects/project-b"]
    })
  });

  assert.equal(plan.status, "attention");
  assert.equal(plan.mode, "merge-preview");
  assert.equal(plan.mergePreview?.sourceRows, 2193);
  assert.equal(plan.mergePreview?.targetRows, 409);
  assert.deepEqual(plan.mergePreview?.overlappingProjectRoots, ["/Users/example/Projects/project-a"]);
  assert.deepEqual(plan.mergePreview?.targetOnlyProjectRoots, ["/Users/example/Projects/project-b"]);
  assert.match(plan.warnings.join("\n"), /dry-run\/preflight only/);
  assert.match(plan.mergePreview?.recommendations.join("\n") ?? "", /preserve target project ids/);
});

function localSourceEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
    REDIS_URL: "redis://127.0.0.1:16379",
    OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
    OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
  };
}

function sharedTargetEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://agentflow:shared-secret@192.0.2.10:15432/agentflow",
    REDIS_URL: "redis://192.0.2.10:16379",
    OBJECT_STORAGE_ENDPOINT: "http://192.0.2.10:19000",
    OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
  };
}

function reachableChecks(host: string): ServiceCheck[] {
  return [
    { endpoint: { name: "Postgres + pgvector", host, port: 15432, requiredFor: "enterprise" }, reachable: true, message: `reachable at ${host}:15432` },
    { endpoint: { name: "Redis", host, port: 16379, requiredFor: "enterprise" }, reachable: true, message: `reachable at ${host}:16379` },
    { endpoint: { name: "MinIO object storage", host, port: 19000, requiredFor: "enterprise" }, reachable: true, message: `reachable at ${host}:19000` }
  ];
}

function verificationReport(input: {
  sourceRows: Partial<Record<string, number>>;
  targetRows: Partial<Record<string, number>>;
  sourceRoots: string[];
  targetRoots: string[];
}): StorageVerificationReport {
  const tableNames = [
    "agents",
    "workflows",
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
  const sourceTables = tableNames.map((table) => snapshotTable(table, input.sourceRows[table] ?? 0));
  const targetTables = tableNames.map((table) => snapshotTable(table, input.targetRows[table] ?? 0));
  return {
    kind: "agentflow_storage_verification_report",
    generatedAt: "2026-09-03T00:00:00.000Z",
    status: "mismatch",
    source: {
      endpoint: {
        databaseUrl: "postgres://user:redacted@127.0.0.1:15432/agentflow",
        redisUrl: "redis://127.0.0.1:16379",
        objectStorageEndpoint: "http://127.0.0.1:19000/",
        objectStorageBucket: "agentflow-artifacts"
      },
      checks: reachableChecks("127.0.0.1"),
      tables: sourceTables,
      breakdowns: [],
      sampledProjectRoots: input.sourceRoots,
      warnings: []
    },
    target: {
      endpoint: {
        databaseUrl: "postgres://user:redacted@192.0.2.10:15432/agentflow",
        redisUrl: "redis://192.0.2.10:16379",
        objectStorageEndpoint: "http://192.0.2.10:19000/",
        objectStorageBucket: "agentflow-artifacts"
      },
      checks: reachableChecks("192.0.2.10"),
      tables: targetTables,
      breakdowns: [],
      sampledProjectRoots: input.targetRoots,
      warnings: []
    },
    diffs: tableNames.map((table) => ({
      table,
      sourceCount: input.sourceRows[table] ?? 0,
      targetCount: input.targetRows[table] ?? 0,
      sourceFingerprint: `source-${table}`,
      targetFingerprint: `target-${table}`,
      status: (input.sourceRows[table] ?? 0) === (input.targetRows[table] ?? 0) ? "match" : "mismatch"
    })),
    warnings: [],
    notes: []
  };
}

function snapshotTable(table: string, count: number): StorageVerificationReport["source"]["tables"][number] {
  return {
    table,
    exists: true,
    count,
    fingerprint: `${table}-${count}`
  };
}

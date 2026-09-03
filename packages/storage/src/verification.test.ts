import assert from "node:assert/strict";
import test from "node:test";
import { compareStorageSnapshots, formatStorageVerificationReport, type StorageSnapshot, type StorageVerificationReport } from "./verification.js";

const checks = [
  {
    endpoint: {
      name: "Postgres + pgvector",
      host: "127.0.0.1",
      port: 15432,
      requiredFor: "enterprise" as const
    },
    reachable: true,
    message: "reachable"
  }
];

function snapshot(overrides: Partial<StorageSnapshot> = {}): StorageSnapshot {
  return {
    endpoint: {
      databaseUrl: "postgres://user:redacted@127.0.0.1:15432/agentflow",
      redisUrl: "redis://127.0.0.1:16379",
      objectStorageEndpoint: "http://127.0.0.1:19000/",
      objectStorageBucket: "agentflow-artifacts"
    },
    checks,
    tables: [
      { table: "agents", exists: true, count: 25, fingerprint: "agents-hash" },
      { table: "workflows", exists: true, count: 9, fingerprint: "workflows-hash" },
      { table: "projects", exists: true, count: 2, fingerprint: "projects-hash" },
      { table: "project_files", exists: true, count: 10, fingerprint: "project-files-hash" },
      { table: "project_index_state", exists: true, count: 2, fingerprint: "project-index-hash" },
      { table: "workflow_runs", exists: true, count: 4, fingerprint: "runs-hash" },
      { table: "workflow_tasks", exists: true, count: 12, fingerprint: "tasks-hash" },
      { table: "action_receipts", exists: true, count: 20, fingerprint: "receipts-hash" },
      { table: "action_approvals", exists: true, count: 1, fingerprint: "approvals-hash" },
      { table: "artifacts", exists: true, count: 16, fingerprint: "artifacts-hash" },
      { table: "memory_items", exists: true, count: 3, fingerprint: "memory-hash" }
    ],
    breakdowns: [],
    sampledProjectRoots: ["/repo"],
    warnings: [],
    ...overrides
  };
}

test("storage verification comparison reports matching durable tables", () => {
  const diffs = compareStorageSnapshots(snapshot(), snapshot());

  assert.equal(diffs.length, 11);
  assert.equal(diffs.every((diff) => diff.status === "match"), true);
});

test("storage verification comparison reports count and fingerprint mismatch", () => {
  const target = snapshot({
    tables: snapshot().tables.map((table) =>
      table.table === "workflow_runs"
        ? { ...table, count: 3, fingerprint: "different" }
        : table
    )
  });

  const diff = compareStorageSnapshots(snapshot(), target).find((item) => item.table === "workflow_runs");

  assert.equal(diff?.status, "mismatch");
  assert.equal(diff?.sourceCount, 4);
  assert.equal(diff?.targetCount, 3);
});

test("storage verification formatter does not expose database credentials", () => {
  const report: StorageVerificationReport = {
    kind: "agentflow_storage_verification_report",
    generatedAt: "2026-09-03T00:00:00.000Z",
    status: "match",
    source: snapshot(),
    target: snapshot(),
    diffs: compareStorageSnapshots(snapshot(), snapshot()),
    warnings: [],
    notes: ["Read-only"]
  };

  const formatted = formatStorageVerificationReport(report);

  assert.match(formatted, /workflow_runs: match/);
  assert.doesNotMatch(formatted, /secret/);
});

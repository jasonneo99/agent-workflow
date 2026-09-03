import assert from "node:assert/strict";
import test from "node:test";
import { buildStorageMergeManifestFromRows, formatStorageMergeManifest, type StorageMergeManifestRows } from "./merge-manifest.js";

test("storage merge manifest maps projects by root_uri and preserves target ids", () => {
  const manifest = buildStorageMergeManifestFromRows({
    generatedAt: "2026-09-03T00:00:00.000Z",
    sourceDatabaseUrl: "postgres://agentflow:source-secret@127.0.0.1:15432/agentflow",
    targetDatabaseUrl: "postgres://agentflow:target-secret@100.78.183.30:15432/agentflow",
    sourceRows: rows({
      projects: [
        row("/projects/app", "source-app", "/projects/app", "source-project-id", "App"),
        row("/projects/old", "source-old", "/projects/old", "source-old-id", "Old")
      ],
      project_files: [
        row("/projects/app\u001ffile.ts", "hash-a", "/projects/app", "source-project-id"),
        row("/projects/old\u001flegacy.ts", "hash-b", "/projects/old", "source-old-id")
      ],
      workflow_runs: [
        row("run-1", "run-hash", "/projects/app", "source-project-id")
      ]
    }),
    targetRows: rows({
      projects: [
        row("/projects/app", "source-app", "/projects/app", "target-project-id", "App")
      ],
      project_files: [
        row("/projects/app\u001ffile.ts", "hash-a", "/projects/app", "target-project-id")
      ]
    })
  });

  assert.equal(manifest.status, "ready");
  assert.deepEqual(manifest.projectMappings.map((mapping) => mapping.action), ["map-existing", "insert-project"]);
  assert.equal(manifest.projectMappings[0]?.targetProjectId, "target-project-id");
  const projectFiles = manifest.tablePlans.find((plan) => plan.table === "project_files");
  assert.equal(projectFiles?.insertRows, 1);
  assert.equal(projectFiles?.existingRows, 1);
  assert.equal(projectFiles?.projectIdRewriteRows, 1);
  assert.doesNotMatch(JSON.stringify(manifest), /source-secret|target-secret/);
});

test("storage merge manifest flags row conflicts for review", () => {
  const manifest = buildStorageMergeManifestFromRows({
    sourceDatabaseUrl: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
    targetDatabaseUrl: "postgres://agentflow:agentflow@100.78.183.30:15432/agentflow",
    sourceRows: rows({
      projects: [row("/projects/app", "source-app", "/projects/app", "source-project-id", "App")],
      artifacts: [row("db://artifact/one", "source-fingerprint", "/projects/app", "source-project-id")]
    }),
    targetRows: rows({
      projects: [row("/projects/app", "source-app", "/projects/app", "target-project-id", "App")],
      artifacts: [row("db://artifact/one", "target-fingerprint", "/projects/app", "target-project-id")]
    })
  });

  assert.equal(manifest.status, "attention");
  assert.match(manifest.warnings.join("\n"), /conflict/);
  assert.equal(manifest.tablePlans.find((plan) => plan.table === "artifacts")?.conflictRows, 1);
  assert.match(formatStorageMergeManifest(manifest), /project-id rewrites=1/);
});

function row(key: string, fingerprint: string, projectRoot?: string, projectId?: string, name?: string) {
  return { key, fingerprint, projectRoot, projectId, name };
}

function rows(input: Partial<StorageMergeManifestRows>): StorageMergeManifestRows {
  return {
    projects: [],
    project_files: [],
    project_index_state: [],
    workflow_runs: [],
    workflow_tasks: [],
    action_receipts: [],
    action_approvals: [],
    artifacts: [],
    memory_items: [],
    ...input
  };
}

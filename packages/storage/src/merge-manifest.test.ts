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

test("storage merge manifest surfaces legacy definition references without overwriting target definitions", () => {
  const manifest = buildStorageMergeManifestFromRows({
    sourceDatabaseUrl: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
    targetDatabaseUrl: "postgres://agentflow:agentflow@100.78.183.30:15432/agentflow",
    sourceRows: rows({}),
    targetRows: rows({}),
    sourceDefinitions: [
      definition("agent", "legacy-agent", "hash-a"),
      definition("agent", "changed-agent", "source-hash"),
      definition("workflow", "historic-workflow", "workflow-hash")
    ],
    targetDefinitions: [
      definition("agent", "changed-agent", "target-hash")
    ],
    sourceDefinitionReferences: [
      reference("agent", "legacy-agent", 3, ["run-1"], ["plan"]),
      reference("agent", "changed-agent", 2, ["run-2"], ["verify"]),
      reference("agent", "vanished-agent", 1, ["run-3"], ["document"]),
      reference("workflow", "retired-workflow", 1, ["run-4"], [], true),
      reference("workflow", "historic-workflow", 1, ["run-5"], [], false)
    ]
  });

  assert.equal(manifest.status, "attention");
  assert.deepEqual(
    manifest.legacyDefinitionReferences.map((item) => `${item.definitionType}:${item.definitionId}:${item.action}`),
    [
      "agent:changed-agent:preserve-target-current",
      "agent:legacy-agent:insert-missing-registry",
      "agent:vanished-agent:readability-warning",
      "workflow:historic-workflow:insert-missing-registry"
    ]
  );
  assert.match(manifest.warnings.join("\n"), /target definitions will be preserved/);
  assert.match(manifest.warnings.join("\n"), /do not resolve/);
  assert.doesNotMatch(formatStorageMergeManifest(manifest), /retired-workflow/);
  assert.match(formatStorageMergeManifest(manifest), /Legacy definition references/);
});

function row(key: string, fingerprint: string, projectRoot?: string, projectId?: string, name?: string) {
  return { key, fingerprint, projectRoot, projectId, name };
}

function definition(definitionType: "agent" | "workflow", definitionId: string, fingerprint: string) {
  return { definitionType, definitionId, fingerprint, sourcePath: `${definitionType}s/${definitionId}.yaml` };
}

function reference(
  definitionType: "agent" | "workflow",
  definitionId: string,
  referenceCount: number,
  sampleRunIds: string[],
  sampleStageIds: string[],
  snapshotAvailable = false
) {
  return { definitionType, definitionId, referenceCount, sampleRunIds, sampleStageIds, snapshotAvailable };
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

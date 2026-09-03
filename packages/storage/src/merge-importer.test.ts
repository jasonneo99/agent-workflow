import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runStorageMergeImport } from "./merge-importer.js";
import { buildStorageMergeManifestFromRows, type StorageMergeManifestRows } from "./merge-manifest.js";

test("storage merge import blocks identical source and target before writes", async () => {
  const manifestPath = await writeManifest();
  const result = await runStorageMergeImport({
    manifestPath,
    sourceDatabaseUrl: "postgres://agentflow:source@127.0.0.1:15432/agentflow",
    targetDatabaseUrl: "postgres://agentflow:target@127.0.0.1:15432/agentflow",
    execute: true
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.mode, "execute");
  assert.match(result.warnings.join("\n"), /same endpoint/);
  assert.doesNotMatch(JSON.stringify(result), /source@|target@/);
});

test("storage merge import rejects non-manifest json", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-merge-import-"));
  const manifestPath = path.join(directory, "bad.json");
  await fs.writeFile(manifestPath, JSON.stringify({ kind: "nope" }), "utf8");

  await assert.rejects(
    runStorageMergeImport({
      manifestPath,
      sourceDatabaseUrl: "postgres://agentflow:agentflow@127.0.0.1:15432/agentflow",
      targetDatabaseUrl: "postgres://agentflow:agentflow@100.78.183.30:15432/agentflow"
    }),
    /Not an Agent Workflow storage merge manifest/
  );
});

async function writeManifest(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-merge-import-"));
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = buildStorageMergeManifestFromRows({
    sourceDatabaseUrl: "postgres://agentflow:source@127.0.0.1:15432/agentflow",
    targetDatabaseUrl: "postgres://agentflow:target@100.78.183.30:15432/agentflow",
    sourceRows: rows(),
    targetRows: rows()
  });
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return manifestPath;
}

function rows(): StorageMergeManifestRows {
  return {
    projects: [],
    project_files: [],
    project_index_state: [],
    workflow_runs: [],
    workflow_tasks: [],
    action_receipts: [],
    action_approvals: [],
    artifacts: [],
    memory_items: []
  };
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BundleManifest } from "../../agent-registry/src/manifest.js";
import { buildDefinitionMigrationPlan, loadDefinitionMigrationCatalog, parseDefinitionMigrationCatalog } from "./index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = {
  schemaVersion: 1,
  bundle: { id: "agent-workflow-core", name: "Agent Workflow Core Bundle", version: "0.2.1", source: "test", description: "test" },
  compatibility: { agentWorkflow: ">=0.1.0 <1.0.0", node: ">=24", mcp: ">=1.29.0" },
  counts: { agents: 0, workflows: 0, files: 0 },
  checksum: { algorithm: "sha256", value: "abc" },
  agents: [],
  workflows: [],
  files: [],
  migrations: []
} satisfies BundleManifest;

test("definition migration catalog parses migration guidance", () => {
  const catalog = parseDefinitionMigrationCatalog(`
schema_version: 1
migrations:
  - id: sample
    from: 0.1.0
    to: 0.2.0
    summary: Sample migration.
    definition_changes:
      - Changed field.
    upgrade_steps:
      - Run validate.
    rollback_steps:
      - Restore previous files.
    validation:
      - agentflow validate
`);
  assert.equal(catalog.migrations.length, 1);
  assert.equal(catalog.migrations[0].definitionChanges[0], "Changed field.");
});

test("committed definition migration catalog loads", async () => {
  const catalog = await loadDefinitionMigrationCatalog(rootDir);
  assert.ok(catalog.migrations.length >= 2);
  assert.ok(catalog.migrations.every((migration) => migration.rollbackSteps.length > 0));
});

test("definition migration plan uses project bundle state", async () => {
  const catalog = await loadDefinitionMigrationCatalog(rootDir);
  const plan = buildDefinitionMigrationPlan({
    manifest,
    catalog,
    state: { schemaVersion: 1, bundle: { id: "agent-workflow-core", version: "0.2.0", checksum: "old" } }
  });
  assert.equal(plan.status, "upgrade-available");
  assert.deepEqual(plan.migrations.map((migration) => migration.id), ["core-0.2.0-to-0.2.1-upgrade-safety"]);
});

test("definition migration plan reports current and unknown baselines", async () => {
  const catalog = await loadDefinitionMigrationCatalog(rootDir);
  const current = buildDefinitionMigrationPlan({
    manifest,
    catalog,
    state: { schemaVersion: 1, bundle: { id: "agent-workflow-core", version: "0.2.1", checksum: "abc" } }
  });
  assert.equal(current.status, "current");
  assert.equal(current.migrations.length, 0);

  const unknown = buildDefinitionMigrationPlan({ manifest, catalog });
  assert.equal(unknown.status, "unknown-source");
  assert.ok(unknown.migrations.length >= 2);
});

test("committed catalog file is valid yaml", async () => {
  const raw = await fs.readFile(path.join(rootDir, "migrations", "definition-migrations.yaml"), "utf8");
  assert.equal(parseDefinitionMigrationCatalog(raw).schemaVersion, 1);
});

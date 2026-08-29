import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { BundleManifest } from "../../agent-registry/src/manifest.js";
import type { ProjectBundleState } from "../../bundle-trust/src/index.js";

export interface DefinitionMigrationCatalog {
  schemaVersion: 1;
  migrations: DefinitionMigration[];
}

export interface DefinitionMigration {
  id: string;
  from: string;
  to: string;
  summary: string;
  definitionChanges: string[];
  upgradeSteps: string[];
  rollbackSteps: string[];
  validation: string[];
}

export interface DefinitionMigrationPlan {
  bundleId: string;
  currentVersion: string;
  source: {
    kind: "project-state" | "explicit" | "unknown";
    version?: string;
    checksum?: string;
    path?: string;
  };
  status: "current" | "upgrade-available" | "unknown-source";
  migrations: DefinitionMigration[];
  recommendations: string[];
}

export async function loadDefinitionMigrationCatalog(rootDir: string): Promise<DefinitionMigrationCatalog> {
  const raw = await fs.readFile(path.join(rootDir, "migrations", "definition-migrations.yaml"), "utf8");
  return parseDefinitionMigrationCatalog(raw);
}

export function parseDefinitionMigrationCatalog(raw: string): DefinitionMigrationCatalog {
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  const migrations = Array.isArray(parsed.migrations) ? parsed.migrations : [];
  return {
    schemaVersion: 1,
    migrations: migrations.map((item) => normalizeMigration(item)).filter(Boolean) as DefinitionMigration[]
  };
}

export function buildDefinitionMigrationPlan(input: {
  manifest: BundleManifest;
  catalog: DefinitionMigrationCatalog;
  state?: ProjectBundleState;
  statePath?: string;
  fromVersion?: string;
  fromChecksum?: string;
}): DefinitionMigrationPlan {
  const source = input.fromVersion || input.fromChecksum
    ? {
        kind: "explicit" as const,
        version: input.fromVersion,
        checksum: input.fromChecksum
      }
    : input.state
      ? {
          kind: "project-state" as const,
          version: input.state.bundle.version,
          checksum: input.state.bundle.checksum,
          path: input.statePath
        }
      : { kind: "unknown" as const };

  const status = source.version
    ? compareVersions(source.version, input.manifest.bundle.version) < 0 ? "upgrade-available" : "current"
    : "unknown-source";

  const migrations = input.catalog.migrations.filter((migration) => migrationApplies(migration, source.version, input.manifest.bundle.version, status));
  return {
    bundleId: input.manifest.bundle.id,
    currentVersion: input.manifest.bundle.version,
    source,
    status,
    migrations,
    recommendations: recommendationsFor(status)
  };
}

export function formatDefinitionMigrationPlan(plan: DefinitionMigrationPlan): string {
  const lines = [
    `Definition Migration Plan: ${plan.bundleId}@${plan.currentVersion}`,
    `Status: ${plan.status}`,
    `Source: ${plan.source.kind}${plan.source.version ? ` ${plan.source.version}` : ""}${plan.source.path ? ` (${plan.source.path})` : ""}`,
    "Migrations"
  ];
  if (!plan.migrations.length) {
    lines.push("- none");
  }
  for (const migration of plan.migrations) {
    lines.push(`- ${migration.id}: ${migration.from} -> ${migration.to}`);
    lines.push(`  ${migration.summary}`);
    lines.push("  Definition changes:");
    lines.push(...migration.definitionChanges.map((item) => `  - ${item}`));
    lines.push("  Upgrade:");
    lines.push(...migration.upgradeSteps.map((item) => `  - ${item}`));
    lines.push("  Rollback:");
    lines.push(...migration.rollbackSteps.map((item) => `  - ${item}`));
    lines.push("  Validation:");
    lines.push(...migration.validation.map((item) => `  - ${item}`));
  }
  lines.push("Recommended actions");
  lines.push(...plan.recommendations.map((item) => `- ${item}`));
  return lines.join("\n");
}

function normalizeMigration(value: unknown): DefinitionMigration | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = stringValue(item.id);
  const from = stringValue(item.from);
  const to = stringValue(item.to);
  const summary = stringValue(item.summary);
  if (!id || !from || !to || !summary) return null;
  return {
    id,
    from,
    to,
    summary,
    definitionChanges: stringArray(item.definition_changes),
    upgradeSteps: stringArray(item.upgrade_steps),
    rollbackSteps: stringArray(item.rollback_steps),
    validation: stringArray(item.validation)
  };
}

function migrationApplies(migration: DefinitionMigration, sourceVersion: string | undefined, currentVersion: string, status: DefinitionMigrationPlan["status"]): boolean {
  if (compareVersions(migration.to, currentVersion) > 0) return false;
  if (!sourceVersion || status === "unknown-source") return true;
  return status === "upgrade-available" && compareVersions(migration.to, sourceVersion) > 0;
}

function recommendationsFor(status: DefinitionMigrationPlan["status"]): string[] {
  if (status === "current") {
    return ["No definition migration is required for the recorded project baseline."];
  }
  if (status === "upgrade-available") {
    return [
      "Review every applicable migration before adopting the current bundle.",
      "Run the listed validation commands before queueing write-capable workflows.",
      "Record the reviewed baseline with bundle-adopt only after validation passes."
    ];
  }
  return [
    "No recorded project baseline was found.",
    "Treat this as a fresh adoption and review all migration guidance before recording bundle state."
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return a.localeCompare(b);
  for (let index = 0; index < 3; index += 1) {
    if (parsedA[index] !== parsedB[index]) return parsedA[index] - parsedB[index];
  }
  return 0;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?/);
  if (!match) return null;
  return [Number(match[1]), numericPart(match[2]), numericPart(match[3])];
}

function numericPart(value: string | undefined): number {
  return value && value !== "x" ? Number(value) : 0;
}

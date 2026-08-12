import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { loadAgentRecords, loadWorkflowRecords } from "./loaders.js";

export interface BundleManifest {
  schemaVersion: 1;
  bundle: {
    id: string;
    name: string;
    version: string;
    source: string;
    description: string;
  };
  compatibility: {
    agentWorkflow: string;
    node: string;
    mcp: string;
  };
  counts: {
    agents: number;
    workflows: number;
    files: number;
  };
  checksum: {
    algorithm: "sha256";
    value: string;
  };
  agents: BundleManifestEntry[];
  workflows: BundleManifestEntry[];
  files: BundleManifestFile[];
  migrations: BundleMigrationNote[];
}

export interface BundleManifestEntry {
  id: string;
  path: string;
  checksum: string;
}

export interface BundleManifestFile {
  path: string;
  checksum: string;
}

export interface BundleMigrationNote {
  from: string;
  to: string;
  notes: string[];
}

const manifestPath = "agent-workflow.bundle.json";

export async function buildBundleManifest(rootDir: string): Promise<BundleManifest> {
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as {
    version?: string;
    repository?: { url?: string };
    description?: string;
  };
  const agents = await loadAgentRecords(rootDir);
  const workflows = await loadWorkflowRecords(rootDir);
  const files = await loadBundleFiles(rootDir);

  return {
    schemaVersion: 1,
    bundle: {
      id: "agent-workflow-core",
      name: "Agent Workflow Core Bundle",
      version: packageJson.version ?? "0.0.0",
      source: packageJson.repository?.url ?? "local",
      description: packageJson.description ?? "Portable agent workflow bundle"
    },
    compatibility: {
      agentWorkflow: ">=0.1.0 <1.0.0",
      node: ">=24",
      mcp: ">=1.29.0"
    },
    counts: {
      agents: agents.length,
      workflows: workflows.length,
      files: files.length
    },
    checksum: {
      algorithm: "sha256",
      value: checksumEntries(files.map((file) => `${file.path}:${file.checksum}`))
    },
    agents: agents.map((record) => ({
      id: record.value.id,
      path: record.path,
      checksum: fileChecksum(files, record.path)
    })),
    workflows: workflows.map((record) => ({
      id: record.value.id,
      path: record.path,
      checksum: fileChecksum(files, record.path)
    })),
    files,
    migrations: [
      {
        from: "0.0.x",
        to: "0.1.0",
        notes: [
          "Initial public bundle manifest for portable local developer workflows.",
          "Use project-local AGENTS.md and .agent-workflow/ for private context instead of editing shared bundle files."
        ]
      }
    ]
  };
}

export async function loadCommittedBundleManifest(rootDir: string): Promise<BundleManifest | null> {
  try {
    const raw = await fs.readFile(path.join(rootDir, manifestPath), "utf8");
    return JSON.parse(raw) as BundleManifest;
  } catch {
    return null;
  }
}

export async function writeBundleManifest(rootDir: string, manifest: BundleManifest): Promise<string> {
  const outputPath = path.join(rootDir, manifestPath);
  await fs.writeFile(outputPath, `${formatBundleManifest(manifest)}\n`, "utf8");
  return outputPath;
}

export function formatBundleManifest(manifest: BundleManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function compareBundleManifests(expected: BundleManifest, actual: BundleManifest): string[] {
  const errors: string[] = [];
  if (expected.schemaVersion !== actual.schemaVersion) {
    errors.push(`bundle manifest schema version mismatch: committed ${expected.schemaVersion}, current ${actual.schemaVersion}`);
  }
  if (expected.bundle.version !== actual.bundle.version) {
    errors.push(`bundle version mismatch: committed ${expected.bundle.version}, current ${actual.bundle.version}`);
  }
  if (expected.counts.agents !== actual.counts.agents) {
    errors.push(`bundle agent count mismatch: committed ${expected.counts.agents}, current ${actual.counts.agents}`);
  }
  if (expected.counts.workflows !== actual.counts.workflows) {
    errors.push(`bundle workflow count mismatch: committed ${expected.counts.workflows}, current ${actual.counts.workflows}`);
  }
  if (expected.counts.files !== actual.counts.files) {
    errors.push(`bundle file count mismatch: committed ${expected.counts.files}, current ${actual.counts.files}`);
  }
  if (expected.checksum.value !== actual.checksum.value) {
    errors.push(`bundle checksum mismatch: committed ${expected.checksum.value}, current ${actual.checksum.value}`);
  }
  return errors;
}

async function loadBundleFiles(rootDir: string): Promise<BundleManifestFile[]> {
  const files = await fg([
    "agents/**/*.yaml",
    "workflows/**/*.yaml"
  ], { cwd: rootDir, absolute: true });

  return Promise.all(files.sort().map(async (file) => ({
    path: path.relative(rootDir, file),
    checksum: await sha256File(file)
  })));
}

async function sha256File(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function checksumEntries(entries: string[]): string {
  return crypto.createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

function fileChecksum(files: BundleManifestFile[], filePath: string): string {
  return files.find((file) => file.path === filePath)?.checksum ?? "";
}

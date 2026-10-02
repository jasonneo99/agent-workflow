import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { findAgentWorkflowRoot } from "../../../../packages/runtime-root/src/index.js";
import { agentWorkflowEnvPath } from "../../../../packages/runtime-root/src/index.js";
import { reliabilityProtocolVersions } from "../../../../packages/reliability-control/src/index.js";

export type RuntimeVersionMetadata = {
  runtimeVersion: string;
  bundleVersion: string;
  protocolVersions: typeof reliabilityProtocolVersions;
};

export interface CliContext {
  rootDir: string;
  packageVersion: string;
  configuredEnvPath: string;
  protocolVersions: typeof reliabilityProtocolVersions;
  runtimeVersionMetadata: Promise<RuntimeVersionMetadata>;
  defaultWorkerHeartbeatPath: string;
  defaultWorkerHeartbeatDir: string;
  defaultSupervisorHeartbeatPath: string;
  defaultLaunchAgentLabel: string;
  defaultLaunchAgentLogDir: string;
  defaultBundleRegistryPath: string;
  defaultServerRequestAuditLogPath: string;
  readJsonFile: <T>(filePath: string) => Promise<T | null>;
}

function readPackageVersion(root: string): string {
  const metadata = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error(`Package version is missing from ${path.join(root, "package.json")}`);
  }
  return metadata.version;
}

async function readJsonFileImpl<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function createCliContext(importMetaUrl: string): CliContext {
  const rootDir = findAgentWorkflowRoot(importMetaUrl);
  const protocolVersions = reliabilityProtocolVersions;
  const runtimeVersionMetadata: Promise<RuntimeVersionMetadata> = Promise.all([
    fs.readFile(path.join(rootDir, "package.json"), "utf8"),
    fs.readFile(path.join(rootDir, "agent-workflow.bundle.json"), "utf8")
  ]).then(([packageText, bundleText]) => ({
    runtimeVersion: (JSON.parse(packageText) as { version?: string }).version ?? "unknown",
    bundleVersion: (JSON.parse(bundleText) as { bundle?: { version?: string } }).bundle?.version ?? "unknown",
    protocolVersions
  }));
  const packageVersion = readPackageVersion(rootDir);
  const configuredEnvPath = agentWorkflowEnvPath(rootDir);
  dotenv.config({ path: configuredEnvPath, quiet: true });
  dotenv.config({ path: path.join(rootDir, ".agent-workflow", "runtime.env"), quiet: true, override: true });
  return {
    rootDir,
    packageVersion,
    configuredEnvPath,
    protocolVersions,
    runtimeVersionMetadata,
    defaultWorkerHeartbeatPath: path.join(rootDir, ".agent-workflow", "runtime", "worker-heartbeat.json"),
    defaultWorkerHeartbeatDir: path.join(rootDir, ".agent-workflow", "runtime", "workers"),
    defaultSupervisorHeartbeatPath: path.join(rootDir, ".agent-workflow", "runtime", "supervisor-heartbeat.json"),
    defaultLaunchAgentLabel: process.env.AGENTFLOW_LAUNCHD_LABEL || "dev.agent-workflow.agent",
    defaultLaunchAgentLogDir: path.join(rootDir, ".agent-workflow", "runtime", "launchd"),
    defaultBundleRegistryPath: path.join(rootDir, "registries", "bundles.json"),
    defaultServerRequestAuditLogPath: path.join(rootDir, ".agent-workflow", "runtime", "server", "request-log.jsonl"),
    readJsonFile: readJsonFileImpl,
  };
}

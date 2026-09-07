import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export function findAgentWorkflowRoot(moduleUrl: string): string {
  let current = path.dirname(fileURLToPath(moduleUrl));
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "@jasonneo99/agent-workflow" || existsSync(path.join(current, "agent-workflow.bundle.json"))) return current;
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the Agent Workflow package root");
    current = parent;
  }
}

export function agentWorkflowEnvPath(rootDir: string, cwd = process.cwd()): string {
  if (process.env.AGENTFLOW_ENV_FILE) return path.resolve(cwd, process.env.AGENTFLOW_ENV_FILE);
  const projectEnv = path.join(cwd, ".agent-workflow", ".env");
  if (existsSync(projectEnv)) return projectEnv;
  const repoEnv = path.join(rootDir, ".env");
  if (existsSync(path.join(rootDir, ".git")) || existsSync(repoEnv)) return repoEnv;
  return path.join(os.homedir(), ".config", "agent-workflow", ".env");
}

export type ProjectRootAliasSource = "exact" | "env" | "mac-home" | "linux-home" | "projects-basename" | "missing";

export type ProjectRootAlias = {
  from: string;
  to: string;
  source: Exclude<ProjectRootAliasSource, "exact" | "projects-basename" | "missing">;
};

export type LocalProjectPathResolution = {
  storageRootUri: string;
  localRootUri: string;
  localPathExists: boolean;
  mapped: boolean;
  source: ProjectRootAliasSource;
  note: string;
};

export type ResolveLocalProjectPathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (target: string) => boolean | Promise<boolean>;
};

export function parseProjectRootAliases(value = process.env.AGENTFLOW_PROJECT_PATH_MAP ?? "", cwd = process.cwd()): ProjectRootAlias[] {
  return value
    .split(/[\n,;]/u)
    .map((entry) => {
      const [from, ...toParts] = entry.split("=");
      return {
        from: from?.trim() ? path.resolve(cwd, from.trim()) : "",
        to: toParts.join("=").trim() ? path.resolve(cwd, toParts.join("=").trim()) : "",
        source: "env" as const
      };
    })
    .filter((mapping) => mapping.from && mapping.to)
    .sort((left, right) => right.from.length - left.from.length);
}

export async function resolveLocalProjectPath(rootUri: string, options: ResolveLocalProjectPathOptions = {}): Promise<LocalProjectPathResolution> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const exists = options.exists ?? pathExists;
  const storageRootUri = path.resolve(cwd, rootUri);

  if (await exists(storageRootUri)) {
    return {
      storageRootUri,
      localRootUri: storageRootUri,
      localPathExists: true,
      mapped: false,
      source: "exact",
      note: "Project path is available on this machine."
    };
  }

  for (const mapping of parseProjectRootAliases(env.AGENTFLOW_PROJECT_PATH_MAP ?? "", cwd)) {
    const localRootUri = applyRootAlias(storageRootUri, mapping.from, mapping.to);
    if (localRootUri && await exists(localRootUri)) {
      return {
        storageRootUri,
        localRootUri,
        localPathExists: true,
        mapped: true,
        source: mapping.source,
        note: `Mapped shared project path through AGENTFLOW_PROJECT_PATH_MAP: ${storageRootUri} -> ${localRootUri}.`
      };
    }
  }

  const userName = path.basename(homeDir);
  const linuxHomePrefix = `/home/${userName}`;
  const macHomePrefix = `/Users/${userName}`;

  const macHomeCandidate = applyRootAlias(storageRootUri, linuxHomePrefix, macHomePrefix);
  if (macHomeCandidate && await exists(macHomeCandidate)) {
    return {
      storageRootUri,
      localRootUri: macHomeCandidate,
      localPathExists: true,
      mapped: true,
      source: "mac-home",
      note: `Mapped Linux home path to macOS home path: ${storageRootUri} -> ${macHomeCandidate}.`
    };
  }

  const linuxHomeCandidate = applyRootAlias(storageRootUri, macHomePrefix, linuxHomePrefix);
  if (linuxHomeCandidate && await exists(linuxHomeCandidate)) {
    return {
      storageRootUri,
      localRootUri: linuxHomeCandidate,
      localPathExists: true,
      mapped: true,
      source: "linux-home",
      note: `Mapped macOS home path to Linux home path: ${storageRootUri} -> ${linuxHomeCandidate}.`
    };
  }

  const localProjectsCandidate = path.join(homeDir, "Projects", path.basename(storageRootUri));
  if (await exists(localProjectsCandidate)) {
    return {
      storageRootUri,
      localRootUri: localProjectsCandidate,
      localPathExists: true,
      mapped: true,
      source: "projects-basename",
      note: `Mapped by project folder name under this user's Projects directory: ${storageRootUri} -> ${localProjectsCandidate}.`
    };
  }

  return {
    storageRootUri,
    localRootUri: storageRootUri,
    localPathExists: false,
    mapped: false,
    source: "missing",
    note: `Project path is not available on this machine: ${storageRootUri}. Set AGENTFLOW_PROJECT_PATH_MAP=/remote/prefix=/local/prefix or mount the project locally to write project-local files.`
  };
}

function applyRootAlias(rootUri: string, from: string, to: string): string | null {
  if (rootUri !== from && !rootUri.startsWith(`${from}/`)) return null;
  return `${to}${rootUri.slice(from.length)}`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

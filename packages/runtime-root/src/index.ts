import { existsSync, readFileSync } from "node:fs";
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

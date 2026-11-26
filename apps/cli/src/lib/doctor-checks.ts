import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import type pg from "pg";
import type { ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { runtimeEnvCredentialKeys } from "../../../../packages/runtime-root/src/index.js";

export type DoctorStatus = "OK" | "WARN" | "MISSING";
export interface DoctorLine { status: DoctorStatus; message: string; }

/** Storage schema and registry sync: a run fails on an unseeded registry. */
export async function checkStorageRegistry(client: Pick<pg.Client, "query">, agentIds: string[], workflowIds: string[]): Promise<DoctorLine[]> {
  const tables = (await client.query<{ agents: string | null; workflows: string | null; runs: string | null }>(
    "select to_regclass('agents')::text as agents, to_regclass('workflows')::text as workflows, to_regclass('workflow_runs')::text as runs")).rows[0];
  if (!tables?.agents || !tables.workflows || !tables.runs) {
    return [{ status: "MISSING", message: "Storage schema not migrated. Run `npm run bootstrap-storage`." }];
  }
  const seeded = (await client.query<{ kind: string; id: string }>(
    "select 'agent' as kind, id from agents union all select 'workflow' as kind, id from workflows")).rows;
  const missing = (kind: string, ids: string[]) => {
    const present = new Set(seeded.filter(row => row.kind === kind).map(row => row.id));
    return ids.filter(id => !present.has(id));
  };
  const missingAgents = missing("agent", agentIds), missingWorkflows = missing("workflow", workflowIds);
  if (!missingAgents.length && !missingWorkflows.length) {
    return [{ status: "OK", message: `Storage schema migrated; ${agentIds.length} agents and ${workflowIds.length} workflows registered.` }];
  }
  const names = [...missingWorkflows.map(id => `workflow ${id}`), ...missingAgents.map(id => `agent ${id}`)];
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? `, and ${names.length - 5} more` : "");
  return [{ status: "MISSING", message: `Definitions not registered in storage (${shown}). Run \`npm run bootstrap-storage\`.` }];
}

/** The provider each tier will actually use, after env files and hard switches. */
export function routeLines(routes: Array<{ tier: string; providerId: string; reason?: string }>, requestedDefault = process.env.DEFAULT_MODEL_PROVIDER): DoctorLine[] {
  const lines: DoctorLine[] = routes.map(route => ({ status: "OK", message: `Model route ${route.tier}: ${route.providerId}` }));
  if (requestedDefault?.trim().toLowerCase() === "mock") {
    const live = routes.filter(route => route.providerId !== "mock");
    if (live.length) lines.push({ status: "WARN", message: `DEFAULT_MODEL_PROVIDER=mock but ${live.map(route => route.tier).join(", ")} would use a live provider.` });
  }
  return lines;
}

/** Source workflows need declared environment profiles; there is no host fallback. */
export function environmentLine(projectDir: string, project: ProjectConfig): DoctorLine {
  const environments = project.execution.environments;
  if (!environments) {
    return { status: "WARN", message: `${projectDir}: no execution.environments profiles, so source workflows such as build-feature will block. See docs/run-environments.md.` };
  }
  const count = Object.keys(environments.profiles).length;
  return { status: "OK", message: `${projectDir}: ${count} environment profile${count === 1 ? "" : "s"} declared.` };
}

/** runtime.env is for non-secret settings; name keys only, never values. */
export async function runtimeEnvLine(rootDir: string): Promise<DoctorLine> {
  const file = path.join(rootDir, ".agent-workflow", "runtime.env");
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return { status: "OK", message: "No runtime.env overrides." };
  const keys = runtimeEnvCredentialKeys(dotenv.parse(raw));
  return keys.length
    ? { status: "WARN", message: `runtime.env sets credential ${keys.join(", ")}; move it to the credential .env file.` }
    : { status: "OK", message: "runtime.env holds no credentials." };
}

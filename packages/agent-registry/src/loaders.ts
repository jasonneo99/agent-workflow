import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";
import {
  AgentCard,
  WorkflowDefinition,
  agentCardSchema,
  projectConfigSchema,
  workflowSchema,
  type ProjectConfig
} from "./schemas.js";

export interface RegistryRecord<T> {
  path: string;
  value: T;
}

export async function loadYamlFile<T>(filePath: string, schema: { parse(value: unknown): T }): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = YAML.parse(raw);
  return schema.parse(parsed);
}

export async function loadAgents(rootDir: string): Promise<AgentCard[]> {
  const records = await loadAgentRecords(rootDir);
  return records.map((record) => record.value);
}

export async function loadAgentRecords(rootDir: string): Promise<RegistryRecord<AgentCard>[]> {
  const files = await fg("agents/**/*.yaml", { cwd: rootDir, absolute: true });
  return Promise.all(files.sort().map(async (file) => ({
    path: path.relative(rootDir, file),
    value: await loadYamlFile(file, agentCardSchema)
  })));
}

export async function loadWorkflows(rootDir: string): Promise<WorkflowDefinition[]> {
  const records = await loadWorkflowRecords(rootDir);
  return records.map((record) => record.value);
}

export async function loadWorkflowRecords(rootDir: string): Promise<RegistryRecord<WorkflowDefinition>[]> {
  const files = await fg("workflows/**/*.yaml", { cwd: rootDir, absolute: true });
  return Promise.all(files.sort().map(async (file) => ({
    path: path.relative(rootDir, file),
    value: await loadYamlFile(file, workflowSchema)
  })));
}

export async function loadProjectConfig(projectDir: string): Promise<ProjectConfig> {
  return loadYamlFile(path.join(projectDir, ".agent-workflow", "project.yaml"), projectConfigSchema);
}

export function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

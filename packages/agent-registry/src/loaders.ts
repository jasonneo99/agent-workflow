import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import YAML from "yaml";
import {
  AgentCard,
  WorkflowDefinition,
  agentCardSchema,
  projectConfigSchema,
  workflowSchema,
  type ProjectConfig
} from "./schemas.js";
import { loadGlobalTrustedCommands, type TrustedCommandFileOptions } from "./trusted-commands.js";

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
  const files = await glob("agents/**/*.yaml", { cwd: rootDir, absolute: true, nodir: true });
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
  const files = await glob("workflows/**/*.yaml", { cwd: rootDir, absolute: true, nodir: true });
  return Promise.all(files.sort().map(async (file) => ({
    path: path.relative(rootDir, file),
    value: await loadYamlFile(file, workflowSchema)
  })));
}

export async function loadProjectConfig(projectDir: string, trustedCommandOptions: TrustedCommandFileOptions = {}): Promise<ProjectConfig> {
  const [base, globalTrustedCommands] = await Promise.all([
    loadYamlFile(path.join(projectDir, ".agent-workflow", "project.yaml"), projectConfigSchema),
    loadGlobalTrustedCommands(trustedCommandOptions)
  ]);
  let project=base;
  const overlayPath=path.join(projectDir,'.agent-workflow/project.local.yaml');
  try{
    const stat=await fs.lstat(overlayPath);if(!stat.isFile()||stat.size>2_000_000||await fs.realpath(overlayPath)!==overlayPath)throw Error('Local project runtime overlay must be a bounded regular owned file');
    const overlay=YAML.parse(await fs.readFile(overlayPath,'utf8'));
    if(!overlay||typeof overlay!=='object'||Array.isArray(overlay)||Object.keys(overlay).some(key=>!['execution','actions'].includes(key)))throw Error('Local runtime overlays may contain only execution and action configuration');
    const merge=(left:unknown,right:unknown):unknown=>{
      if(Array.isArray(left)&&Array.isArray(right))return [...new Map([...left,...right].map(value=>[JSON.stringify(value),value])).values()];
      if(left&&right&&typeof left==='object'&&typeof right==='object'&&!Array.isArray(left)&&!Array.isArray(right)){
        const result={...left} as Record<string,unknown>;
        for(const [key,value] of Object.entries(right)){if(['__proto__','constructor','prototype'].includes(key))throw Error('Invalid local runtime overlay key');result[key]=key in result?merge(result[key],value):value;}
        return result;
      }
      return right;
    };
    project=projectConfigSchema.parse(merge(base,overlay));
  }catch(error:any){if(error.code!=='ENOENT')throw error;}
  if (globalTrustedCommands.length === 0) return project;
  return projectConfigSchema.parse({
    ...project,
    actions: {
      ...project.actions,
      allowed_commands: [...new Set([...project.actions.allowed_commands, ...globalTrustedCommands])]
    }
  });
}

export function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

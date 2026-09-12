import path from "node:path";

export interface AgentWorkflowSchema {
  id: "agent" | "workflow" | "workflow-handoff" | "project" | "schedules" | "bundle-state" | "bundle-pin" | "context-routing-policy" | "context-holdout" | "context-corpus";
  title: string;
  fileName: string;
  description: string;
  fileGlobs: string[];
}

export const agentWorkflowSchemas: AgentWorkflowSchema[] = [
  {
    id: "agent",
    title: "Agent Workflow Agent",
    fileName: "agent.schema.json",
    description: "Reusable or project-local agent card.",
    fileGlobs: ["agents/**/*.yaml", "agents/**/*.yml", ".agent-workflow/agents/**/*.yaml", ".agent-workflow/agents/**/*.yml"]
  },
  {
    id: "workflow",
    title: "Agent Workflow Definition",
    fileName: "workflow.schema.json",
    description: "Reusable workflow graph definition.",
    fileGlobs: ["workflows/**/*.yaml", "workflows/**/*.yml"]
  },
  {
    id: "workflow-handoff",
    title: "Durable Workflow Handoff",
    fileName: "workflow-handoff.schema.json",
    description: "Durable agent-to-agent handoff packet and lifecycle state.",
    fileGlobs: [".agent-workflow/handoffs/**/*.json"]
  },
  {
    id: "project",
    title: "Agent Workflow Project Config",
    fileName: "project.schema.json",
    description: "Project-local Agent Workflow configuration.",
    fileGlobs: [".agent-workflow/project.yaml", ".agent-workflow/project.yml"]
  },
  {
    id: "schedules",
    title: "Agent Workflow Schedules",
    fileName: "schedules.schema.json",
    description: "Project-local scheduled workflow or agent tasks.",
    fileGlobs: [".agent-workflow/schedules.yaml", ".agent-workflow/schedules.yml"]
  },
  {
    id: "bundle-state",
    title: "Agent Workflow Bundle State",
    fileName: "bundle-state.schema.json",
    description: "Project-local recorded reusable bundle adoption state.",
    fileGlobs: [".agent-workflow/bundle-state.json"]
  },
  {
    id: "bundle-pin",
    title: "Agent Workflow Bundle Pin",
    fileName: "bundle-pin.schema.json",
    description: "Project-local desired reusable bundle version pin.",
    fileGlobs: [".agent-workflow/bundle-pin.json"]
  },
  {
    id: "context-routing-policy",
    title: "Agent Workflow Context Routing Policy",
    fileName: "context-routing-policy.schema.json",
    description: "Provider-neutral token-aware context routing and privacy policy.",
    fileGlobs: ["policies/context-routing.yaml", "policies/context-routing.yml", ".agent-workflow/context-routing.yaml", ".agent-workflow/context-routing.yml"]
  },
  {
    id: "context-holdout",
    title: "Agent Workflow Context Holdout Cases",
    fileName: "context-holdout.schema.json",
    description: "Direct-versus-routed context quality, citation, token, and latency cases.",
    fileGlobs: ["evaluations/context-*.json", ".agent-workflow/evals/context-*.json"]
  },
  {
    id: "context-corpus",
    title: "Agent Workflow Repository Context Corpus",
    fileName: "context-corpus.schema.json",
    description: "Versioned repository-file context calibration cases.",
    fileGlobs: ["evals/context-gateway-*.json", ".agent-workflow/evals/context-gateway-*.json"]
  }
];

export function schemaDirectory(rootDir: string): string {
  return path.join(rootDir, "schemas");
}

export function schemaPath(rootDir: string, schema: AgentWorkflowSchema): string {
  return path.join(schemaDirectory(rootDir), schema.fileName);
}

export function buildSchemaSummary(rootDir: string): Array<AgentWorkflowSchema & { path: string }> {
  return agentWorkflowSchemas.map((schema) => ({
    ...schema,
    path: schemaPath(rootDir, schema)
  }));
}

export function buildYamlSchemaAssociations(rootDir: string): Record<string, string[]> {
  const associations: Record<string, string[]> = {};
  for (const schema of agentWorkflowSchemas) {
    associations[schemaPath(rootDir, schema)] = schema.fileGlobs;
  }
  return associations;
}

export function buildVsCodeSettings(rootDir: string): Record<string, unknown> {
  return {
    "yaml.schemas": buildYamlSchemaAssociations(rootDir)
  };
}

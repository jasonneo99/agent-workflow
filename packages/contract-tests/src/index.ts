import fs from "node:fs/promises";
import path from "node:path";
import { agentCardSchema, projectConfigSchema, workflowSchema, type AgentCard, type ProjectConfig, type WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import { loadAgentRecords, loadProjectConfig, loadWorkflowRecords, loadYamlFile } from "../../agent-registry/src/loaders.js";
import type { ModelProvider, StageExecutionInput } from "../../model-providers/src/index.js";

export interface ContractTestResult {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface ContractTestReport {
  definitionsDir: string;
  projectDir?: string;
  providerId: string;
  liveProvider: boolean;
  passed: boolean;
  results: ContractTestResult[];
}

export async function runDefinitionContractTests(input: {
  definitionsDir: string;
  projectDir?: string;
  provider: ModelProvider;
  liveProvider: boolean;
}): Promise<ContractTestReport> {
  const results: ContractTestResult[] = [];
  const agents = await loadAgentRecords(input.definitionsDir);
  const workflows = await loadWorkflowRecords(input.definitionsDir);
  const projectAgents = input.projectDir ? await loadProjectAgentRecords(input.projectDir) : [];
  const allAgents = [...agents, ...projectAgents];
  const agentIds = new Set(allAgents.map((record) => record.value.id));

  results.push({ id: "agents.load", status: agents.length + projectAgents.length > 0 ? "pass" : "fail", detail: `${agents.length} shared, ${projectAgents.length} project-local` });
  results.push({ id: "workflows.load", status: workflows.length > 0 ? "pass" : "fail", detail: `${workflows.length} workflow definition(s)` });
  results.push(...uniqueIdResults("agents.unique", allAgents.map((record) => record.value.id)));
  results.push(...uniqueIdResults("workflows.unique", workflows.map((record) => record.value.id)));

  for (const record of agents) {
    results.push({ id: `agent.schema.${record.value.id}`, status: schemaRoundTrip(record.value, agentCardSchema), detail: record.path });
  }
  for (const record of projectAgents) {
    results.push({ id: `agent.schema.${record.value.id}`, status: schemaRoundTrip(record.value, agentCardSchema), detail: record.path });
  }
  for (const record of workflows) {
    results.push({ id: `workflow.schema.${record.value.id}`, status: schemaRoundTrip(record.value, workflowSchema), detail: record.path });
    results.push(...workflowReferenceResults(record.value, agentIds));
  }

  const providerResult = input.provider.id === "mock" || input.liveProvider
    ? await providerExecutionResult(input.provider, input.projectDir ? await loadProjectConfig(input.projectDir).catch(() => defaultProjectConfig()) : defaultProjectConfig())
    : { id: `provider.${input.provider.id}.execute`, status: "skip" as const, detail: "Live provider execution skipped. Pass --live-provider to run it." };
  results.push(providerResult);

  return {
    definitionsDir: input.definitionsDir,
    projectDir: input.projectDir,
    providerId: input.provider.id,
    liveProvider: input.liveProvider,
    passed: results.every((result) => result.status !== "fail"),
    results
  };
}

export function formatContractTestReport(report: ContractTestReport): string {
  return [
    `Contract Tests: ${report.passed ? "PASS" : "FAIL"}`,
    `Definitions: ${report.definitionsDir}`,
    report.projectDir ? `Project: ${report.projectDir}` : "",
    `Provider: ${report.providerId}${report.liveProvider ? " (live)" : ""}`,
    "Results",
    ...report.results.map((result) => `- ${result.status.toUpperCase()} ${result.id}: ${result.detail}`)
  ].filter(Boolean).join("\n");
}

async function loadProjectAgentRecords(projectDir: string): Promise<Array<{ path: string; value: AgentCard }>> {
  const agentsDir = path.join(projectDir, ".agent-workflow", "agents");
  const records: Array<{ path: string; value: AgentCard }> = [];
  try {
    const entries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const filePath = path.join(agentsDir, entry.name);
      records.push({
        path: path.relative(projectDir, filePath),
        value: await loadYamlFile(filePath, agentCardSchema)
      });
    }
  } catch {
    return [];
  }
  return records;
}

function uniqueIdResults(prefix: string, ids: string[]): ContractTestResult[] {
  const seen = new Set<string>();
  const duplicate = ids.find((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });
  return [{
    id: prefix,
    status: duplicate ? "fail" : "pass",
    detail: duplicate ? `Duplicate id: ${duplicate}` : `${ids.length} unique id(s)`
  }];
}

function schemaRoundTrip<T>(value: T, schema: { parse(input: unknown): T }): "pass" | "fail" {
  try {
    schema.parse(value);
    return "pass";
  } catch {
    return "fail";
  }
}

function workflowReferenceResults(workflow: WorkflowDefinition, agentIds: Set<string>): ContractTestResult[] {
  const results: ContractTestResult[] = [];
  const stageIds = workflow.stages.map((stage) => stage.id);
  results.push(...uniqueIdResults(`workflow.${workflow.id}.stages.unique`, stageIds));
  for (const role of [{ kind: "lead", id: workflow.lead }]) {
    results.push({
      id: `workflow.${workflow.id}.${role.kind}.${role.id}`,
      status: agentIds.has(role.id) ? "pass" : "fail",
      detail: agentIds.has(role.id) ? "agent exists" : "missing agent"
    });
  }
  for (const stage of workflow.stages) {
    results.push({
      id: `workflow.${workflow.id}.stage.${stage.id}.agent.${stage.agent}`,
      status: agentIds.has(stage.agent) ? "pass" : "fail",
      detail: agentIds.has(stage.agent) ? "agent exists" : "missing agent"
    });
    for (const subagent of stage.subagents) {
      results.push({
        id: `workflow.${workflow.id}.stage.${stage.id}.subagent.${subagent}`,
        status: agentIds.has(subagent) ? "pass" : "fail",
        detail: agentIds.has(subagent) ? "agent exists" : "missing agent"
      });
    }
  }
  return results;
}

async function providerExecutionResult(provider: ModelProvider, projectConfig: ProjectConfig): Promise<ContractTestResult> {
  try {
    const output = await provider.executeStage(providerFixture(projectConfig));
    const valid = typeof output.summary === "string" && output.summary.trim().length > 0 && output.artifact && typeof output.artifact === "object";
    return {
      id: `provider.${provider.id}.execute`,
      status: valid ? "pass" : "fail",
      detail: valid ? "returned summary and artifact" : "provider output is missing summary or artifact"
    };
  } catch (error) {
    return {
      id: `provider.${provider.id}.execute`,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

function providerFixture(projectConfig: ProjectConfig): StageExecutionInput {
  return {
    runId: "contract-test-run",
    taskId: "contract-test-task",
    projectConfig,
    workflowId: "contract-test",
    workflowTask: "Return a concise provider contract result. Do not request commands or file writes.",
    stageId: "provider-contract",
    agentId: "contract-agent",
    agentName: "Contract Agent",
    agentPrompt: "Return structured, safe development workflow output.",
    stageGoal: "Verify provider adapter output shape.",
    compiledBrief: "Contract test brief.",
    modelTier: "fast",
    priorReceipts: []
  };
}

function defaultProjectConfig(): ProjectConfig {
  return projectConfigSchema.parse({
    project: {
      name: "Contract Test Project",
      summary: "Synthetic project used for provider adapter contract checks.",
      default_workflows: ["review-pr"],
      autonomy: 1
    }
  });
}

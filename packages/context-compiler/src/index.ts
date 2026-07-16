import fs from "node:fs/promises";
import path from "node:path";
import type { AgentCard, ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";

export interface CompileInput {
  task: string;
  projectDir: string;
  project: ProjectConfig;
  workflow: WorkflowDefinition;
  agents: AgentCard[];
  sourceSummaries?: Array<{
    sourceUri: string;
    tokenEstimate: number;
    summary: string;
    score?: number;
    matchedTerms?: string[];
  }>;
}

export async function compileContext(input: CompileInput): Promise<string> {
  const agentIndex = new Map(input.agents.map((agent) => [agent.id, agent]));
  const lead = agentIndex.get(input.workflow.lead);
  const projectFiles = await readProjectContextFiles(input.projectDir);

  const stageBriefs = input.workflow.stages.map((stage) => {
    const agent = agentIndex.get(stage.agent);
    const subagents = stage.subagents
      .map((id) => agentIndex.get(id))
      .filter((item): item is AgentCard => Boolean(item));

    return [
      `### Stage: ${stage.id}`,
      `Agent: ${stage.agent}${agent ? ` (${agent.display_name})` : ""}`,
      `Goal: ${stage.goal}`,
      stage.subagents.length ? `Subagents: ${subagents.map((item) => `${item.id} (${item.display_name})`).join(", ")}` : "Subagents: none",
      `Context budget: ${stage.context.max_tokens} tokens`,
      `Output: ${stage.output}`,
      `Approval required: ${stage.approval_required ? "yes" : "no"}`
    ].join("\n");
  });

  return [
    "# Compiled Agent Workflow Brief",
    "",
    `Task: ${input.task}`,
    `Project: ${input.project.project.name}`,
    `Workflow: ${input.workflow.id} - ${input.workflow.name}`,
    `Lead: ${input.workflow.lead}${lead ? ` (${lead.display_name})` : ""}`,
    `Project autonomy: ${input.project.project.autonomy}`,
    "",
    "## Action Policy",
    formatActionPolicy(input.project),
    "",
    "## Project Context",
    projectFiles,
    "",
    "## Indexed Source Summaries",
    formatSourceSummaries(input.sourceSummaries ?? []),
    "",
    "## Workflow Stages",
    stageBriefs.join("\n\n"),
    "",
    "## Agent Instructions",
    input.agents.map(formatAgent).join("\n\n")
  ].join("\n");
}

function formatActionPolicy(project: ProjectConfig): string {
  return [
    "### Commands",
    "Allowed:",
    ...project.actions.allowed_commands.map((command) => `- ${command}`),
    "Blocked:",
    ...project.actions.blocked_commands.map((command) => `- ${command}`),
    `Timeout: ${project.actions.command_timeout_ms}ms`,
    `Max output: ${project.actions.max_output_chars} chars`,
    "",
    "### File Writes",
    "Allowed paths:",
    ...project.actions.allowed_write_paths.map((pattern) => `- ${pattern}`),
    "Blocked paths:",
    ...project.actions.blocked_write_paths.map((pattern) => `- ${pattern}`),
    `Max write size: ${project.actions.max_write_bytes} bytes`
  ].join("\n");
}

function formatSourceSummaries(summaries: Array<{ sourceUri: string; tokenEstimate: number; summary: string; score?: number; matchedTerms?: string[] }>): string {
  if (!summaries.length) {
    return "_No indexed source summaries available. Run `npm run index-project -- --project <path>`._";
  }

  return summaries.map((summary) => [
    `### ${summary.sourceUri}`,
    `Approx tokens: ${summary.tokenEstimate}`,
    typeof summary.score === "number" ? `Relevance score: ${summary.score}` : "",
    summary.matchedTerms?.length ? `Matched terms: ${summary.matchedTerms.join(", ")}` : "",
    summary.summary
  ].filter(Boolean).join("\n")).join("\n\n");
}

async function readProjectContextFiles(projectDir: string): Promise<string> {
  const candidates = [
    "AGENTS.md",
    ".agent-workflow/context.md",
    ".agent-workflow/commands.md",
    ".agent-workflow/decisions.md"
  ];

  const sections: string[] = [];
  for (const relativePath of candidates) {
    const absolutePath = path.join(projectDir, relativePath);
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      sections.push(`### ${relativePath}\n${raw.trim()}`);
    } catch {
      sections.push(`### ${relativePath}\n_missing_`);
    }
  }

  return sections.join("\n\n");
}

function formatAgent(agent: AgentCard): string {
  return [
    `### ${agent.id} (${agent.display_name})`,
    `Category: ${agent.category}`,
    `Purpose: ${agent.purpose}`,
    `Autonomy: ${agent.autonomy}`,
    `Can: ${agent.can.join(", ") || "none listed"}`,
    `Requires approval: ${agent.requires_approval.join(", ") || "none listed"}`,
    agent.prompt
  ].join("\n");
}

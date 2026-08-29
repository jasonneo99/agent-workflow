import type { AgentCard, ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";
import { evaluateAgentAutonomy, type ResolvedExecutionPolicy } from "../../policy-engine/src/index.js";

export interface WorkflowGraphStage {
  id: string;
  order: number;
  agentId: string;
  agentDisplayName: string | null;
  agentCategory: string | null;
  agentAutonomy: string;
  modelTier: string | null;
  goal: string;
  subagents: Array<{
    id: string;
    displayName: string | null;
    category: string | null;
    autonomy: string | null;
  }>;
  contextLoads: string[];
  contextMaxTokens: number;
  output: string;
  approvalRequired: boolean;
  policyAllowed: boolean;
  policyApprovalRequired: boolean;
  policyReasons: string[];
  dependsOn: string[];
}

export interface WorkflowGraphReport {
  workflow: {
    id: string;
    name: string;
    description: string;
    lead: string;
    defaultAutonomy: string;
    manual: boolean;
    events: string[];
  };
  project: {
    name: string;
    autonomy: string;
    policyProfile: string;
    policySnapshotHash: string;
    allowedCommands: number;
    blockedCommands: number;
    allowedWritePaths: number;
    blockedWritePaths: number;
    requireReceipts: boolean;
    requireApprovalForExternalActions: boolean;
  };
  totals: {
    stages: number;
    approvalStages: number;
    blockedStages: number;
    contextBudgetTokens: number;
    subagentLinks: number;
  };
  stages: WorkflowGraphStage[];
  warnings: string[];
  mermaid: string;
}

export function buildWorkflowGraphReport(input: {
  workflow: WorkflowDefinition;
  agents: AgentCard[];
  project: ProjectConfig;
  resolvedPolicy: ResolvedExecutionPolicy;
}): WorkflowGraphReport {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const stages = input.workflow.stages.map((stage, index): WorkflowGraphStage => {
    const agent = agentsById.get(stage.agent);
    const decision = agent
      ? evaluateAgentAutonomy(agent, input.resolvedPolicy.project)
      : {
        allowed: false,
        approvalRequired: true,
        reasons: [`missing agent ${stage.agent}`]
      };
    const subagents = stage.subagents.map((id) => {
      const subagent = agentsById.get(id);
      return {
        id,
        displayName: subagent?.display_name ?? null,
        category: subagent?.category ?? null,
        autonomy: subagent ? String(subagent.autonomy) : null
      };
    });

    return {
      id: stage.id,
      order: index + 1,
      agentId: stage.agent,
      agentDisplayName: agent?.display_name ?? null,
      agentCategory: agent?.category ?? null,
      agentAutonomy: agent ? String(agent.autonomy) : "unknown",
      modelTier: agent?.model_tier ?? null,
      goal: stage.goal,
      subagents,
      contextLoads: stage.context.load,
      contextMaxTokens: stage.context.max_tokens,
      output: stage.output,
      approvalRequired: stage.approval_required,
      policyAllowed: decision.allowed,
      policyApprovalRequired: decision.approvalRequired,
      policyReasons: decision.reasons,
      dependsOn: index === 0 ? [] : [input.workflow.stages[index - 1].id]
    };
  });
  const warnings = [
    ...stages.filter((stage) => !stage.policyAllowed).map((stage) => `Stage ${stage.id} is blocked by policy: ${stage.policyReasons.join("; ")}`),
    ...stages.flatMap((stage) => stage.subagents.filter((subagent) => !subagent.displayName).map((subagent) => `Stage ${stage.id} references missing subagent ${subagent.id}`))
  ];

  return {
    workflow: {
      id: input.workflow.id,
      name: input.workflow.name,
      description: input.workflow.description,
      lead: input.workflow.lead,
      defaultAutonomy: String(input.workflow.default_autonomy),
      manual: input.workflow.triggers.manual,
      events: input.workflow.triggers.events
    },
    project: {
      name: input.resolvedPolicy.project.project.name,
      autonomy: String(input.resolvedPolicy.project.project.autonomy),
      policyProfile: input.resolvedPolicy.profile,
      policySnapshotHash: input.resolvedPolicy.snapshotHash,
      allowedCommands: input.resolvedPolicy.project.actions.allowed_commands.length,
      blockedCommands: input.resolvedPolicy.project.actions.blocked_commands.length,
      allowedWritePaths: input.resolvedPolicy.project.actions.allowed_write_paths.length,
      blockedWritePaths: input.resolvedPolicy.project.actions.blocked_write_paths.length,
      requireReceipts: input.resolvedPolicy.project.policies.require_receipts,
      requireApprovalForExternalActions: input.resolvedPolicy.project.policies.require_approval_for_external_actions
    },
    totals: {
      stages: stages.length,
      approvalStages: stages.filter((stage) => stage.approvalRequired || stage.policyApprovalRequired).length,
      blockedStages: stages.filter((stage) => !stage.policyAllowed).length,
      contextBudgetTokens: stages.reduce((total, stage) => total + stage.contextMaxTokens, 0),
      subagentLinks: stages.reduce((total, stage) => total + stage.subagents.length, 0)
    },
    stages,
    warnings,
    mermaid: buildMermaid(input.workflow, stages)
  };
}

export function formatWorkflowGraphReport(report: WorkflowGraphReport): string {
  return [
    `Workflow Graph: ${report.workflow.id} - ${report.workflow.name}`,
    `Project: ${report.project.name}`,
    `Policy: ${report.project.policyProfile} (${report.project.policySnapshotHash})`,
    `Stages: ${report.totals.stages}; approvals: ${report.totals.approvalStages}; blocked: ${report.totals.blockedStages}; context budget: ${report.totals.contextBudgetTokens} tokens`,
    "",
    "Stages",
    ...report.stages.map((stage) => [
      `${stage.order}. ${stage.id} -> ${stage.agentId}${stage.agentDisplayName ? ` (${stage.agentDisplayName})` : ""}`,
      `   Goal: ${stage.goal}`,
      `   Depends on: ${stage.dependsOn.length ? stage.dependsOn.join(", ") : "start"}`,
      `   Context: ${stage.contextMaxTokens} tokens; loads ${stage.contextLoads.length ? stage.contextLoads.join(", ") : "none"}`,
      `   Subagents: ${stage.subagents.length ? stage.subagents.map((subagent) => subagent.id).join(", ") : "none"}`,
      `   Approval: ${stage.approvalRequired ? "stage" : stage.policyApprovalRequired ? "policy" : "no"}`,
      `   Policy: ${stage.policyAllowed ? "allowed" : "blocked"} - ${stage.policyReasons.join("; ")}`,
      `   Output: ${stage.output}`
    ].join("\n")),
    report.warnings.length ? "\nWarnings" : "",
    ...report.warnings.map((warning) => `- ${warning}`),
    "",
    "Mermaid",
    "```mermaid",
    report.mermaid,
    "```"
  ].filter(Boolean).join("\n");
}

function buildMermaid(workflow: WorkflowDefinition, stages: WorkflowGraphStage[]): string {
  const lines = [
    "flowchart TD",
    `  start([${escapeMermaid(workflow.id)}])`
  ];
  for (const stage of stages) {
    const label = `${stage.order}. ${stage.id}\\n${stage.agentId}\\n${stage.contextMaxTokens} tokens${stage.approvalRequired || stage.policyApprovalRequired ? "\\napproval" : ""}${stage.policyAllowed ? "" : "\\nblocked"}`;
    lines.push(`  ${nodeId(stage.id)}["${escapeMermaid(label)}"]`);
  }
  lines.push(`  start --> ${nodeId(stages[0]?.id ?? "end")}`);
  for (let index = 1; index < stages.length; index += 1) {
    lines.push(`  ${nodeId(stages[index - 1].id)} --> ${nodeId(stages[index].id)}`);
  }
  for (const stage of stages) {
    for (const subagent of stage.subagents) {
      const subagentId = `${nodeId(stage.id)}_${nodeId(subagent.id)}`;
      lines.push(`  ${subagentId}("${escapeMermaid(subagent.id)}")`);
      lines.push(`  ${nodeId(stage.id)} -. subagent .-> ${subagentId}`);
    }
  }
  return lines.join("\n");
}

function nodeId(value: string): string {
  return `n_${value.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")");
}

import type { AgentCard, ProjectConfig } from "../../agent-registry/src/schemas.js";

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  approvalRequired: boolean;
}

export function evaluateAgentAutonomy(agent: AgentCard, project: ProjectConfig): PolicyDecision {
  const reasons: string[] = [];
  const projectAutonomy = project.project.autonomy;

  if (agent.autonomy === "wide-open" || projectAutonomy === "wide-open") {
    if (!project.policies.allow_wide_open) {
      return {
        allowed: false,
        approvalRequired: true,
        reasons: ["wide-open autonomy requested but project policies do not allow it"]
      };
    }

    reasons.push("wide-open autonomy allowed by project policy");
    return {
      allowed: true,
      approvalRequired: project.policies.require_approval_for_external_actions,
      reasons
    };
  }

  const agentLevel = Number(agent.autonomy);
  const projectLevel = Number(projectAutonomy);
  const allowed = agentLevel <= projectLevel;

  if (!allowed) {
    reasons.push(`agent autonomy ${agentLevel} exceeds project autonomy ${projectLevel}`);
  } else {
    reasons.push(`agent autonomy ${agentLevel} is within project autonomy ${projectLevel}`);
  }

  return {
    allowed,
    approvalRequired: agent.requires_approval.length > 0,
    reasons
  };
}


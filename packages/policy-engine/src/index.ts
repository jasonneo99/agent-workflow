import { createHash } from "node:crypto";
import {
  projectConfigSchema,
  type AgentCard,
  type ExecutionPolicyProfile,
  type ProjectConfig
} from "../../agent-registry/src/schemas.js";

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
  approvalRequired: boolean;
}

const BUILTIN_POLICY_PROFILES: Record<string, ExecutionPolicyProfile> = {
  local: {
    policies: {},
    actions: {}
  },
  staging: {
    autonomy: 2,
    policies: {
      allow_wide_open: false,
      require_approval_for_external_actions: true,
      require_receipts: true
    },
    actions: {}
  },
  production: {
    autonomy: 1,
    policies: {
      allow_wide_open: false,
      require_approval_for_external_actions: true,
      require_receipts: true
    },
    actions: {
      allowed_commands: [],
      allowed_write_paths: []
    }
  }
};

export interface ResolvedExecutionPolicy {
  profile: string;
  project: ProjectConfig;
  snapshot: ProjectConfig;
  snapshotHash: string;
}

export function resolveExecutionPolicy(
  project: ProjectConfig,
  requestedProfile?: string
): ResolvedExecutionPolicy {
  const profile = requestedProfile ?? project.execution.policy_profile;
  const overrides = project.execution.policy_profiles[profile] ?? BUILTIN_POLICY_PROFILES[profile];
  if (!overrides) {
    throw new Error(`Unknown execution policy profile: ${profile}`);
  }

  const resolved = projectConfigSchema.parse({
    ...project,
    project: {
      ...project.project,
      autonomy: overrides.autonomy ?? project.project.autonomy
    },
    policies: {
      ...project.policies,
      ...overrides.policies
    },
    actions: {
      ...project.actions,
      ...overrides.actions
    },
    execution: {
      ...project.execution,
      policy_profile: profile
    }
  });
  const serialized = JSON.stringify(resolved);

  return {
    profile,
    project: resolved,
    snapshot: resolved,
    snapshotHash: createHash("sha256").update(serialized).digest("hex")
  };
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

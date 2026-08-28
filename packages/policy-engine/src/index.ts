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

export interface ActionApprovalRuleMatch {
  id: string;
  description: string;
  actionType: "local_command" | "file_write";
  target: string;
  effect: "auto_execute";
  reasons: string[];
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
  },
  evaluation: {
    policies: {
      allow_wide_open: true,
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

export function evaluateActionApprovalRule(input: {
  project: ProjectConfig;
  actionType: "local_command" | "file_write";
  target: string;
  bytes?: number;
}): ActionApprovalRuleMatch | null {
  const target = input.actionType === "local_command" ? normalizeCommand(input.target) : normalizePath(input.target);
  for (const rule of input.project.actions.approval_rules) {
    if (rule.action_type !== input.actionType) continue;
    if (input.actionType === "local_command" && !matchesCommandPattern(target, rule.target)) continue;
    if (input.actionType === "file_write" && !matchesGlob(target, rule.target)) continue;
    if (rule.max_bytes !== undefined && input.bytes !== undefined && input.bytes > rule.max_bytes) continue;

    const reasons = [`matched approval rule ${rule.id}`];
    if (rule.max_bytes !== undefined) {
      reasons.push(`max_bytes ${rule.max_bytes}`);
    }
    return {
      id: rule.id,
      description: rule.description,
      actionType: rule.action_type,
      target: rule.target,
      effect: rule.effect,
      reasons
    };
  }
  return null;
}

function matchesCommandPattern(commandLine: string, pattern: string): boolean {
  const normalizedPattern = normalizeCommand(pattern);
  if (normalizedPattern.endsWith(" *")) {
    const prefix = normalizedPattern.slice(0, -2);
    return commandLine === prefix || commandLine.startsWith(`${prefix} `);
  }
  return commandLine === normalizedPattern;
}

function matchesGlob(value: string, pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

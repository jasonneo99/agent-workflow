export type GovernanceHealth = "healthy" | "warning" | "critical";
export type GovernanceCheckStatus = "pass" | "warning" | "critical" | "unknown";

export interface GovernanceHealthCheck {
  id: string;
  label: string;
  status: GovernanceCheckStatus;
  evidence: string;
  recommendation: string | null;
  command: string | null;
}

export interface GovernanceProject {
  id: string;
  name: string;
  rootUri: string;
  health: GovernanceHealth;
  accessible: boolean;
  agentsFile: boolean;
  projectConfig: "valid" | "missing" | "invalid";
  policyProfile: string;
  policyDrift: boolean | null;
  configDrift: boolean | null;
  provider: string;
  modelTier: string | null;
  indexedFiles: number;
  runCount: number;
  activeRuns: number;
  failedRuns: number;
  staleActiveRuns: number;
  lastRunAt: string | null;
  recommendations: string[];
  healthChecks: GovernanceHealthCheck[];
}

export interface GovernanceReport {
  kind: "agentflow_governance_report";
  generatedAt: string;
  bundleVersion: string;
  servicesReady: boolean;
  definitionsReady: boolean;
  configuredProvider: string;
  projects: GovernanceProject[];
  counts: Record<GovernanceHealth, number>;
}

export function finalizeGovernanceProject(input: Omit<GovernanceProject, "health" | "recommendations" | "healthChecks">): GovernanceProject {
  const projectArg = shellProjectArg(input.rootUri);
  const healthChecks: GovernanceHealthCheck[] = [
    {
      id: "project_path",
      label: "Project path",
      status: input.accessible ? "pass" : "critical",
      evidence: input.accessible ? "Root path is reachable from this machine." : `Root path is missing or inaccessible: ${input.rootUri}`,
      recommendation: input.accessible ? null : "Restore or unregister the inaccessible project path.",
      command: input.accessible ? null : null
    },
    {
      id: "agents_file",
      label: "AGENTS.md",
      status: input.agentsFile ? "pass" : "warning",
      evidence: input.agentsFile ? "AGENTS.md exists." : "AGENTS.md is missing.",
      recommendation: input.agentsFile ? null : "Run ide-onboard or onboard-project to add AGENTS.md.",
      command: input.agentsFile ? null : `npm run agentflow -- ide-onboard --project ${projectArg}`
    },
    {
      id: "project_config",
      label: "Project config",
      status: input.projectConfig === "valid" ? "pass" : input.projectConfig === "invalid" ? "critical" : "warning",
      evidence: `.agent-workflow/project.yaml is ${input.projectConfig}.`,
      recommendation: input.projectConfig === "valid" ? null : "Repair or regenerate .agent-workflow/project.yaml.",
      command: input.projectConfig === "valid" ? null : `npm run agentflow -- init-project --project ${projectArg} --profile enterprise`
    },
    {
      id: "policy_drift",
      label: "Policy drift",
      status: input.policyDrift === null ? "unknown" : input.policyDrift ? "warning" : "pass",
      evidence: input.policyDrift === null ? "No previous run policy snapshot is available." : input.policyDrift ? "Current policy differs from the latest run snapshot." : "Current policy matches the latest run snapshot.",
      recommendation: input.policyDrift ? "Review policy changes before the next run." : null,
      command: null
    },
    {
      id: "config_drift",
      label: "Config drift",
      status: input.configDrift === null ? "unknown" : input.configDrift ? "warning" : "pass",
      evidence: input.configDrift === null ? "No local project config was available for comparison." : input.configDrift ? "Stored project config differs from the local canonical config." : "Stored project config matches the local canonical config.",
      recommendation: input.configDrift ? "Re-index or run onboarding to synchronize registered configuration." : null,
      command: input.configDrift ? `npm run agentflow -- index-project --project ${projectArg}` : null
    },
    {
      id: "stale_active_runs",
      label: "Stale active runs",
      status: input.staleActiveRuns > 0 ? "critical" : "pass",
      evidence: `${input.staleActiveRuns} stale active run(s), ${input.activeRuns} active run(s).`,
      recommendation: input.staleActiveRuns > 0 ? "Inspect stale active runs and requeue interrupted tasks if appropriate." : null,
      command: input.staleActiveRuns > 0 ? "npm run agentflow -- status" : null
    },
    {
      id: "failed_runs",
      label: "Failed runs",
      status: input.failedRuns > 0 ? "warning" : "pass",
      evidence: `${input.failedRuns} failed run(s) out of ${input.runCount} total run(s).`,
      recommendation: input.failedRuns > 0 ? "Review or dismiss failed queue items." : null,
      command: input.failedRuns > 0 ? "npm run agentflow -- status" : null
    },
    {
      id: "indexed_context",
      label: "Indexed context",
      status: input.indexedFiles === 0 ? "warning" : "pass",
      evidence: `${input.indexedFiles} indexed file(s).`,
      recommendation: input.indexedFiles === 0 ? "Index project context before a substantive workflow run." : null,
      command: input.indexedFiles === 0 ? `npm run agentflow -- index-project --project ${projectArg}` : null
    }
  ];
  const recommendations = healthChecks
    .filter((check) => check.recommendation && (check.status === "warning" || check.status === "critical"))
    .map((check) => check.recommendation!);
  const critical = !input.accessible || input.projectConfig === "invalid" || input.staleActiveRuns > 0;
  const warning = !input.agentsFile || input.projectConfig === "missing" || Boolean(input.policyDrift) || Boolean(input.configDrift) || input.failedRuns > 0 || input.indexedFiles === 0;
  return { ...input, health: critical ? "critical" : warning ? "warning" : "healthy", recommendations, healthChecks };
}

export function buildGovernanceReport(bundleVersion: string, servicesReady: boolean, projects: GovernanceProject[], configuredProvider = "unknown", definitionsReady = true): GovernanceReport {
  return {
    kind: "agentflow_governance_report",
    generatedAt: new Date().toISOString(),
    bundleVersion,
    servicesReady,
    definitionsReady,
    configuredProvider,
    projects,
    counts: {
      healthy: projects.filter((project) => project.health === "healthy").length,
      warning: projects.filter((project) => project.health === "warning").length,
      critical: projects.filter((project) => project.health === "critical").length
    }
  };
}

export function formatGovernanceReport(report: GovernanceReport): string {
  return [
    `Multi-project governance (${report.generatedAt})`,
    `Bundle: ${report.bundleVersion}`,
    `Services: ${report.servicesReady ? "ready" : "attention"}`,
    `Definitions: ${report.definitionsReady ? "ready" : "attention"}`,
    `Configured provider: ${report.configuredProvider}`,
    `Projects: healthy=${report.counts.healthy} warning=${report.counts.warning} critical=${report.counts.critical}`,
    "",
    ...report.projects.map((project) => [
      `- ${project.name} [${project.health}]`,
      `  ${project.rootUri}`,
      `  policy=${project.policyProfile} drift=${project.policyDrift ?? "unknown"} configDrift=${project.configDrift ?? "unknown"} provider=${project.provider} tier=${project.modelTier ?? "default"}`,
      `  runs=${project.runCount} active=${project.activeRuns} stale=${project.staleActiveRuns} failed=${project.failedRuns} indexed=${project.indexedFiles}`,
      ...project.healthChecks
        .filter((check) => check.status === "warning" || check.status === "critical")
        .map((check) => `  - ${check.label}: ${check.evidence}${check.command ? ` (${check.command})` : ""}`)
    ].join("\n"))
  ].join("\n");
}

function shellProjectArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

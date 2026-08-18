export type GovernanceHealth = "healthy" | "warning" | "critical";

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

export function finalizeGovernanceProject(input: Omit<GovernanceProject, "health" | "recommendations">): GovernanceProject {
  const recommendations: string[] = [];
  if (!input.accessible) recommendations.push("Restore or unregister the inaccessible project path.");
  if (!input.agentsFile) recommendations.push("Run ide-onboard or onboard-project to add AGENTS.md.");
  if (input.projectConfig !== "valid") recommendations.push("Repair or regenerate .agent-workflow/project.yaml.");
  if (input.policyDrift) recommendations.push("Review policy changes before the next run.");
  if (input.configDrift) recommendations.push("Re-index or run onboarding to synchronize registered configuration.");
  if (input.staleActiveRuns > 0) recommendations.push("Inspect stale active runs and requeue interrupted tasks if appropriate.");
  if (input.failedRuns > 0) recommendations.push("Review or dismiss failed queue items.");
  if (input.indexedFiles === 0) recommendations.push("Index project context before a substantive workflow run.");
  const critical = !input.accessible || input.projectConfig === "invalid" || input.staleActiveRuns > 0;
  const warning = !input.agentsFile || input.projectConfig === "missing" || Boolean(input.policyDrift) || Boolean(input.configDrift) || input.failedRuns > 0 || input.indexedFiles === 0;
  return { ...input, health: critical ? "critical" : warning ? "warning" : "healthy", recommendations };
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
      ...project.recommendations.map((item) => `  - ${item}`)
    ].join("\n"))
  ].join("\n");
}

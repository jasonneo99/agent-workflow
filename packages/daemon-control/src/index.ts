export type DaemonTrustLevel = "low" | "medium" | "high";
export type DaemonLaneId = "evidence-collector" | "workflow-optimizer" | "action-executor" | "runtime-maintenance" | "repository-steward" | "release-ci-guardian" | "security-sentinel" | "backup-recovery-verifier";
export type DaemonLaneDefinition = { id: DaemonLaneId; name: string; purpose: string; capabilities: string[]; defaultTrust: DaemonTrustLevel; mutationClass: "read-only" | "project-local" | "operational" };
export type DaemonTrustSettings = Record<DaemonLaneId, DaemonTrustLevel>;

export const daemonLanes: DaemonLaneDefinition[] = [
  { id: "evidence-collector", name: "Evidence Collector", purpose: "Collect and normalize local run, feedback, evaluation, provider, cost, and context evidence.", capabilities: ["evidence ingestion", "staleness and anomaly detection", "scrubbed evidence digests"], defaultTrust: "low", mutationClass: "read-only" },
  { id: "workflow-optimizer", name: "Workflow Optimizer", purpose: "Recommend and shadow-test workflow, handoff, context, scheduling, and model-routing changes.", capabilities: ["shadow replay", "workflow and handoff tuning", "experiment design"], defaultTrust: "low", mutationClass: "project-local" },
  { id: "action-executor", name: "Action Executor", purpose: "Apply eligible approved changes with policy rechecks, validation, rollback, and receipts.", capabilities: ["policy-gated application", "validation", "rollback and escalation"], defaultTrust: "low", mutationClass: "project-local" },
  { id: "runtime-maintenance", name: "Runtime Maintenance", purpose: "Repair stale runs and maintain allowlisted local runtime components, queues, synchronization, and caches.", capabilities: ["stale-run recovery", "MCP cleanup", "capacity and sync maintenance"], defaultTrust: "low", mutationClass: "operational" },
  { id: "repository-steward", name: "Repository Steward", purpose: "Maintain dependency, source, test, documentation, and repository hygiene within repository policy.", capabilities: ["bounded dependency hygiene", "missing test and docs detection", "validated local maintenance commits"], defaultTrust: "low", mutationClass: "project-local" },
  { id: "release-ci-guardian", name: "Release & CI Guardian", purpose: "Triage CI failures and prepare release-readiness evidence without publishing autonomously.", capabilities: ["CI triage", "release gate checks", "release evidence preparation"], defaultTrust: "low", mutationClass: "project-local" },
  { id: "security-sentinel", name: "Security Sentinel", purpose: "Inspect dependencies, configuration, secrets exposure, and trust-boundary regressions.", capabilities: ["security scans", "risk triage", "eligible low-risk remediation"], defaultTrust: "low", mutationClass: "project-local" },
  { id: "backup-recovery-verifier", name: "Backup & Recovery Verifier", purpose: "Verify backup freshness, restore readiness, artifact integrity, and recovery evidence.", capabilities: ["backup freshness checks", "non-destructive restore drills", "recovery readiness receipts"], defaultTrust: "low", mutationClass: "operational" }
];

export function defaultDaemonTrustSettings(): DaemonTrustSettings {
  return Object.fromEntries(daemonLanes.map((lane) => [lane.id, lane.defaultTrust])) as DaemonTrustSettings;
}
export function normalizeDaemonTrustSettings(value: unknown): DaemonTrustSettings {
  const result = defaultDaemonTrustSettings();
  if (!value || typeof value !== "object") return result;
  for (const lane of daemonLanes) {
    const candidate = (value as Record<string, unknown>)[lane.id];
    if (candidate === "low" || candidate === "medium" || candidate === "high") result[lane.id] = candidate;
  }
  return result;
}
export function daemonMayAct(input: { trust: DaemonTrustLevel; risk: DaemonTrustLevel; policyAllowed: boolean; validationPassed: boolean }): boolean {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return input.policyAllowed && input.validationPassed && rank[input.risk] <= rank[input.trust];
}

import type { CliContext } from "./context.js";
import type { DashboardActionApproval, DashboardInfo, DashboardRoleAuditExportSummary, DashboardRoleDecisionSummary, DashboardRoleGovernanceReport } from "./cli-types.js";
import { loadDashboardRoleProject } from "./builders-server.js";
import { countStrings, exists, objectValue, pathExists, resolveDashboardProjectPath, stableHash, stringValue } from "./builders-shared.js";
import { loadAgents, loadProjectConfig, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { type ProjectConfig, projectConfigSchema } from "../../../../packages/agent-registry/src/schemas.js";
import { type GovernanceReport, buildGovernanceReport, finalizeGovernanceProject } from "../../../../packages/governance/src/index.js";
import { selectModelRoute } from "../../../../packages/model-providers/src/routing.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { agentWorkflowEnvPath } from "../../../../packages/runtime-root/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { listActionApprovals, listProjectStorageSummaries, listWorkflowRunsForProject } from "../../../../packages/storage/src/postgres.js";
import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function approvalMatchesRoleFilter(approval: DashboardActionApproval, role: string): boolean {
  const roles = [
    approval.decidedRole,
    approval.executedRole,
    approval.status === "pending" ? "pending" : null,
    !approval.decidedRole && approval.status !== "pending" ? "unrecorded" : null
  ].filter(Boolean);
  return roles.some((candidate) => candidate === role);
}


export function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

export function formatRoleAuditSnapshotMarkdown(report: DashboardRoleGovernanceReport): string {
  return [
    "# Role Audit Snapshot",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
    `Recent approvals: ${report.recentApprovals.length}`,
    "",
    "## Decision Counts",
    "",
    "| Role | Total | Pending | Approved | Rejected | Executed | Failed |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(report.decisionsByRole.length
      ? report.decisionsByRole.map((role) => `| ${escapeMarkdownTable(role.role)} | ${role.total} | ${role.pending} | ${role.approved} | ${role.rejected} | ${role.executed} | ${role.failed} |`)
      : ["| none | 0 | 0 | 0 | 0 | 0 | 0 |"]),
    "",
    "## Configured Roles",
    "",
    ...report.projects.flatMap((project) => [
      `### ${project.name}`,
      "",
      `Root: \`${project.rootUri}\``,
      `Config: ${project.configStatus}`,
      `Enforcement: ${project.enforcement}`,
      `Separation of duties: ${project.separationOfDuties}`,
      "",
      "| Role | Capabilities | Description |",
      "| --- | --- | --- |",
      ...(project.roles.length
        ? project.roles.map((role) => `| ${escapeMarkdownTable(role.id)} | ${escapeMarkdownTable(role.capabilities.join(", ") || "none")} | ${escapeMarkdownTable(role.description || "")} |`)
        : ["| none | none | No roles configured. |"]),
      ""
    ]),
    "## Recent Approval Activity",
    "",
    "| Status | Action | Decision Role | Execution Role | Project | Updated |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(report.recentApprovals.length
      ? report.recentApprovals.map((approval) => `| ${escapeMarkdownTable(approval.status)} | ${escapeMarkdownTable(approval.actionType)} | ${escapeMarkdownTable(approval.decidedRole ?? "none")} | ${escapeMarkdownTable(approval.executedRole ?? "none")} | ${escapeMarkdownTable(approval.projectName)} | ${escapeMarkdownTable(approval.updatedAt)} |`)
      : ["| none | none | none | none | none | none |"])
  ].join("\n");
}

export async function listDashboardRoleAuditExports(ctx: CliContext, projectDir: string | null, limit: number): Promise<DashboardRoleAuditExportSummary[]> {
  const exportDir = path.join(projectDir ?? ctx.rootDir, ".agent-workflow", "exports", "roles");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const summaries = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const jsonPath = path.join(exportDir, entry.name);
      try {
        const payload = JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown;
        return roleAuditSummaryFromPayload(jsonPath, payload);
      } catch {
        return null;
      }
    }));
  return summaries
    .filter((summary): summary is DashboardRoleAuditExportSummary => summary !== null)
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    .slice(0, Math.max(0, limit));
}

export async function loadAutoRoutePreviews(ctx: CliContext): Promise<NonNullable<DashboardInfo["provider"]["autoRoutes"]>> {
  const tiers = ["fast", "standard", "reasoning"] as const;
  return Promise.all(tiers.map(async (tier) => {
    const route = await selectModelRoute({
      modelTier: tier,
      agentId: "auto-preview",
      stageId: tier,
      workflowId: "dashboard",
      compiledBrief: ""
    });
    return {
      tier,
      providerId: route.providerId,
      estimatedCostTier: route.estimatedCostTier,
      reason: route.reason
    };
  }));
}

export async function loadGovernanceReport(ctx: CliContext, staleMinutes = 15, includeEphemeral = false): Promise<GovernanceReport> {
  const [summaries, services, packageRaw, agents, workflows] = await Promise.all([
    listProjectStorageSummaries(500),
    checkServices(),
    fs.readFile(path.join(ctx.rootDir, "package.json"), "utf8"),
    loadAgents(ctx.rootDir),
    loadWorkflows(ctx.rootDir)
  ]);
  const staleBefore = Date.now() - staleMinutes * 60_000;
  const governedSummaries = includeEphemeral ? summaries : summaries.filter((summary) =>
    !(summary.name === "Provider Smoke Project" && /agentflow-provider-smoke\./.test(summary.rootUri))
  );
  const projects = await Promise.all(governedSummaries.map(async (summary) => {
    const projectPath = await resolveDashboardProjectPath(summary.rootUri);
    const accessible = projectPath.localPathExists;
    const agentsFile = accessible && await pathExists(path.join(projectPath.localRootUri, "AGENTS.md"));
    let configStatus: "valid" | "missing" | "invalid" = "missing";
    let localConfig: ProjectConfig | null = null;
    if (accessible && await pathExists(path.join(projectPath.localRootUri, ".agent-workflow", "project.yaml"))) {
      try {
        localConfig = await loadProjectConfig(projectPath.localRootUri);
        configStatus = "valid";
      } catch {
        configStatus = "invalid";
      }
    }
    const runs = await listWorkflowRunsForProject({ projectRootUri: summary.rootUri, limit: 100 });
    const latest = runs[0] ?? null;
    let policyDrift: boolean | null = null;
    let configDrift: boolean | null = null;
    if (localConfig) {
      try {
        const currentPolicy = resolveExecutionPolicy(localConfig, latest?.policyProfile ?? localConfig.execution.policy_profile);
        policyDrift = latest?.policySnapshotHash ? currentPolicy.snapshotHash !== latest.policySnapshotHash : null;
      } catch {
        policyDrift = true;
      }
      try {
        const stored = projectConfigSchema.parse(summary.config);
        configDrift = stableHash(stored) !== stableHash(localConfig);
      } catch {
        configDrift = true;
      }
    }
    const active = runs.filter((run) => run.status === "queued" || run.status === "leased" || run.status === "running");
    const staleActiveRuns = active.filter((run) => run.status === "running" && Date.parse(run.startedAt) < staleBefore).length;
    return finalizeGovernanceProject({
      id: summary.id,
      name: summary.name,
      rootUri: summary.rootUri,
      accessible,
      agentsFile,
      projectConfig: configStatus,
      policyProfile: localConfig?.execution.policy_profile ?? latest?.policyProfile ?? "unknown",
      policyDrift,
      configDrift,
      provider: latest?.providerOverride ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
      modelTier: latest?.modelTierOverride ?? null,
      indexedFiles: summary.indexedFiles,
      runCount: summary.runCount,
      activeRuns: summary.queuedRuns + summary.runningRuns,
      failedRuns: summary.failedRuns,
      staleActiveRuns,
      lastRunAt: summary.lastRunAt
    });
  }));
  const packageInfo = JSON.parse(packageRaw) as { version?: string };
  return buildGovernanceReport(packageInfo.version ?? "unknown", services.every((service) => service.reachable), projects.sort((a, b) =>
    ({ critical: 0, warning: 1, healthy: 2 })[a.health] - ({ critical: 0, warning: 1, healthy: 2 })[b.health] || a.name.localeCompare(b.name)
  ), process.env.DEFAULT_MODEL_PROVIDER ?? "mock", agents.length > 0 && workflows.length > 0);
}

export async function loadRoleGovernanceReport(ctx: CliContext, input: { projectRootUri?: string; limit?: number; role?: string | null; status?: string | null; actionType?: string | null } = {}): Promise<DashboardRoleGovernanceReport> {
  const projectRootUri = input.projectRootUri ? path.resolve(process.cwd(), input.projectRootUri) : null;
  const limit = input.limit ?? 50;
  const roleFilter = input.role?.trim() || null;
  const statusFilter = input.status?.trim() || "all";
  const actionFilter = input.actionType?.trim() || null;
  const [summaries, approvals] = await Promise.all([
    listProjectStorageSummaries(500),
    listActionApprovals({
      projectRootUri: projectRootUri ?? undefined,
      limit
    })
  ]);
  const selectedSummaries = projectRootUri
    ? summaries.filter((summary) => summary.rootUri === projectRootUri)
    : summaries;
  const projects = await Promise.all(selectedSummaries.map(loadDashboardRoleProject));
  const filteredApprovals = approvals.filter((approval) =>
    (statusFilter === "all" || approval.status === statusFilter) &&
    (!actionFilter || approval.actionType === actionFilter) &&
    (!roleFilter || approvalMatchesRoleFilter(approval, roleFilter))
  );
  const recentRoleAuditExports = await listDashboardRoleAuditExports(ctx, projectRootUri, 8);
  return {
    kind: "agentflow_role_governance_report",
    generatedAt: new Date().toISOString(),
    projectRootUri,
    limit,
    filters: {
      role: roleFilter,
      status: statusFilter,
      actionType: actionFilter
    },
    projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    statusCounts: countStrings(filteredApprovals.map((approval) => approval.status)),
    actionCounts: countStrings(filteredApprovals.map((approval) => approval.actionType)),
    decisionsByRole: summarizeApprovalDecisionsByRole(filteredApprovals),
    recentApprovals: filteredApprovals,
    recentRoleAuditExports
  };
}

export function roleAuditSummaryFromPayload(jsonPath: string, payload: unknown): DashboardRoleAuditExportSummary | null {
  const record = objectValue(payload);
  if (record.kind !== "agentflow_role_governance_report") return null;
  const filters = objectValue(record.filters);
  const generatedAt = stringValue(record.generatedAt);
  const status = stringValue(filters.status) ?? "all";
  if (!generatedAt) return null;
  const markdownPath = jsonPath.replace(/\.json$/u, ".md");
  const recentApprovals = Array.isArray(record.recentApprovals) ? record.recentApprovals : [];
  const projects = Array.isArray(record.projects) ? record.projects : [];
  const decisionsByRole = Array.isArray(record.decisionsByRole) ? record.decisionsByRole : [];
  return {
    jsonPath,
    markdownPath: fsSync.existsSync(markdownPath) ? markdownPath : null,
    fileName: path.basename(markdownPath),
    generatedAt,
    projectPath: stringValue(record.projectRootUri) ?? null,
    role: stringValue(filters.role) ?? null,
    status,
    actionType: stringValue(filters.actionType) ?? null,
    approvalCount: recentApprovals.length,
    projectCount: projects.length,
    roleCount: decisionsByRole.length
  };
}

export function safeFileSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "graph";
}

export function summarizeApprovalDecisionsByRole(approvals: DashboardActionApproval[]): DashboardRoleDecisionSummary[] {
  const byRole = new Map<string, DashboardRoleDecisionSummary>();
  for (const approval of approvals) {
    const role = approval.decidedRole ?? (approval.status === "pending" ? "pending" : "unrecorded");
    const summary = byRole.get(role) ?? {
      role,
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
      other: 0
    };
    summary.total += 1;
    if (approval.status === "pending") summary.pending += 1;
    else if (approval.status === "approved") summary.approved += 1;
    else if (approval.status === "rejected") summary.rejected += 1;
    else if (approval.status === "executed") summary.executed += 1;
    else if (approval.status === "failed") summary.failed += 1;
    else summary.other += 1;
    byRole.set(role, summary);
  }
  return [...byRole.values()].sort((a, b) => b.total - a.total || a.role.localeCompare(b.role));
}

export async function updateEnvValue(filePath: string, key: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await exists(filePath) ? await fs.readFile(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const nextLine = `${key}=${value}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(nextLine);
    } else {
      nextLines.splice(Math.max(0, nextLines.length - 1), 0, nextLine);
    }
  }

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

export async function writeRoleAuditSnapshot(ctx: CliContext, report: DashboardRoleGovernanceReport, outDir?: string): Promise<{ markdownPath: string; jsonPath: string }> {
  const baseDir = outDir?.trim()
    ? path.resolve(process.cwd(), outDir)
    : path.join(report.projectRootUri ?? ctx.rootDir, ".agent-workflow", "exports", "roles");
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filterSegment = safeFileSegment([
    report.filters.role ?? "all-roles",
    report.filters.status,
    report.filters.actionType ?? "all-actions"
  ].join("-"));
  const markdownPath = path.join(baseDir, `${stamp}-${filterSegment}.md`);
  const jsonPath = path.join(baseDir, `${stamp}-${filterSegment}.json`);
  await fs.writeFile(markdownPath, `${formatRoleAuditSnapshotMarkdown(report)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

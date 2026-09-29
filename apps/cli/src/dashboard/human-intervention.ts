export type HumanInterventionItem = {
  id: string;
  severity: "bad" | "warn";
  kind: "approval" | "execution" | "blocked-run" | "failed-run" | "expired-lease" | "runtime" | "agent-promotion";
  title: string;
  detail: string;
  href: string;
  action: string;
};

type Approval = { id: string; status: string; actionType: string; target: string };
type QueueItem = { runId: string; runStatus: string; task: string; blockedReason?: string | null; failedReason?: string | null; runningLeaseExpiresAt?: string | null };

export function buildHumanInterventionItems(input: {
  pendingApprovals: Approval[];
  approvedExecutableApprovals: Approval[];
  queue: QueueItem[];
  workerStatus: string;
  supervisorStatus: string;
  mcpStatus: string;
  missingServices: string[];
  learningDaemonError?: string | null;
  approvalBacklogErrors?: number;
  approvalBacklogWarnings?: number;
  agentImprovementPending?: Array<{ projectRootUri: string; name: string; pending: number; deferred: number }>;
  now?: Date;
}): HumanInterventionItem[] {
  const now = (input.now ?? new Date()).getTime();
  const items: HumanInterventionItem[] = [];
  for (const approval of input.pendingApprovals) items.push({ id: `approval:${approval.id}`, severity: "warn", kind: "approval", title: `Decide ${approval.actionType}`, detail: approval.target, href: "/approvals?status=pending", action: "Review" });
  for (const approval of input.approvedExecutableApprovals) items.push({ id: `execution:${approval.id}`, severity: "warn", kind: "execution", title: `Execute ${approval.actionType}`, detail: approval.target, href: "/approvals?status=approved", action: "Execute" });
  for (const run of input.queue) {
    if (run.runStatus === "blocked") items.push({ id: `blocked:${run.runId}`, severity: "warn", kind: "blocked-run", title: "Resolve blocked workflow", detail: run.blockedReason || run.task, href: `/run?id=${encodeURIComponent(run.runId)}`, action: "Resolve" });
    if (run.runStatus === "failed") items.push({ id: `failed:${run.runId}`, severity: "bad", kind: "failed-run", title: "Review failed workflow", detail: run.failedReason || run.task, href: `/run?id=${encodeURIComponent(run.runId)}`, action: "Inspect" });
    if (run.runningLeaseExpiresAt && Date.parse(run.runningLeaseExpiresAt) <= now) items.push({ id: `lease:${run.runId}`, severity: "bad", kind: "expired-lease", title: "Recover expired worker lease", detail: run.task, href: "/queue", action: "Recover" });
  }
  if (input.workerStatus !== "running") items.push({ id: "runtime:worker", severity: "bad", kind: "runtime", title: "Restore background worker", detail: `Worker is ${input.workerStatus}.`, href: "/settings", action: "Settings" });
  if (input.supervisorStatus !== "running") items.push({ id: "runtime:supervisor", severity: "bad", kind: "runtime", title: "Restore local supervisor", detail: `Supervisor is ${input.supervisorStatus}.`, href: "/settings", action: "Settings" });
  if (input.mcpStatus !== "ok") items.push({ id: "runtime:mcp", severity: "bad", kind: "runtime", title: "Repair MCP connectivity", detail: `MCP pipeline is ${input.mcpStatus}.`, href: "/server-readiness", action: "Runtime" });
  if (input.missingServices.length) items.push({ id: "runtime:storage", severity: "bad", kind: "runtime", title: "Restore required services", detail: input.missingServices.join(", "), href: "/server-readiness", action: "Runtime" });
  if (input.learningDaemonError) items.push({ id: "runtime:learning", severity: "bad", kind: "runtime", title: "Repair learning daemon", detail: input.learningDaemonError, href: "/learning?view=diagnostics", action: "Diagnose" });
  const backlog = (input.approvalBacklogErrors ?? 0) + (input.approvalBacklogWarnings ?? 0);
  if (backlog) items.push({ id: "runtime:approval-backlog", severity: (input.approvalBacklogErrors ?? 0) > 0 ? "bad" : "warn", kind: "runtime", title: "Review approval backlog health", detail: `${input.approvalBacklogErrors ?? 0} errors and ${input.approvalBacklogWarnings ?? 0} warnings.`, href: "/approvals", action: "Review" });
  for (const entry of input.agentImprovementPending ?? []) {
    const total = entry.pending + entry.deferred;
    if (total <= 0) continue;
    items.push({
      id: `agent-promotion:${entry.projectRootUri}`,
      severity: "warn",
      kind: "agent-promotion",
      title: `${total} agent-improvement promotion${total === 1 ? "" : "s"} awaiting review`,
      detail: `${entry.name}: ${entry.pending} pending, ${entry.deferred} deferred.`,
      href: `/learning?project=${encodeURIComponent(entry.projectRootUri)}&view=agent-improvements`,
      action: "Review"
    });
  }
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1));
}

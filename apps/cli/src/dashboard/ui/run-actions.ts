import { escapeHtml, iconLabel } from "./layout.js";
import type { DashboardRunStatus } from "../../lib/cli-types.js";
import { formatDashboardDateTimeText } from "../../lib/builders-runs.js";
import { type DashboardIconName } from "../icons.js";
import { type RunEta, estimateRunEta, withWorkerAvailability } from "../run-eta.js";
import type { DashboardQueueItem, FailedRunResolution } from "../../commands/daemon-types.js";

export function estimateQueueItemEta(item: DashboardQueueItem, historicalRuns: DashboardRunStatus[], workAvailable = true): RunEta {
  if(item.approvalWait)return {state:"paused",totalTasks:item.totalTasks,completedTasks:item.completedTasks,
    reason:"ETA paused while an exact approval is required.",estimatedCompletionAt:null,remainingMs:null,
    projectedTotalMs:null,confidence:"none",source:"none",sampleCount:0};
  const tasks = [
    ...Array.from({ length: item.completedTasks }, () => ({ status: "completed" })),
    ...Array.from({ length: item.runningTasks }, () => ({ status: "running" })),
    ...Array.from({ length: item.queuedTasks }, () => ({ status: "queued" })),
    ...Array.from({ length: item.failedTasks }, () => ({ status: "failed" }))
  ];
  while (tasks.length < item.totalTasks) tasks.push({ status: item.runStatus === "blocked" ? "blocked" : "queued" });
  const run = { id: item.runId, workflowId: item.workflowId, projectRootUri: item.projectRootUri, status: item.runStatus, startedAt: item.startedAt, finishedAt: null };
  return withWorkerAvailability(estimateRunEta({ run, tasks, historicalRuns }), dashboardRunCanProgress(workAvailable, run, tasks));
}

export function failedRunResolution(reason?: string | null): FailedRunResolution {
  const normalized = reason?.trim().toLowerCase() ?? "";
  if (/auth(?:entication|orization)?|not authenticated|credential/u.test(normalized)) {
    return {
      headline: "Provider authentication failed",
      summary: "Authentication must be repaired on the worker that will claim the retry before execution can safely continue.",
      instructions: [
        "Open Providers and verify the configured provider on the intended worker.",
        "For Codex CLI, run: npm run agentflow -- provider-use codex-cli --login --check",
        "After the provider check succeeds on that worker, choose Retry Failed Stages."
      ],
      automaticRepair: "operator-required"
    };
  }
  if (/billing|payment/u.test(normalized)) {
    return {
      headline: "Provider billing is not configured",
      summary: "The model API rejected the request because billing verification failed on the provider account. No prompt was executed and no tokens were used.",
      instructions: [
        "Open the provider billing settings (for Muse: the Model API dashboard at dev.meta.ai) and add a payment method, then verify billing is active.",
        "Re-run the API check from the project root: node check-muse-api.mjs — chat completions should report OK.",
        "Choose Retry Failed Stages."
      ],
      automaticRepair: "operator-required"
    };
  }
  if (/fallback|provider retry|provider.*failed|model route/u.test(normalized)) {
    return {
      headline: "Provider routing failed",
      summary: "Agent Workflow will preserve the failure and can retry only after a healthy provider route or worker is available.",
      instructions: [
        "Open Providers and confirm at least one eligible route reports ready.",
        "If a remote worker is unhealthy, route the retry to an authenticated worker or repair that node's provider configuration.",
        "Choose Retry Failed Stages, or Diagnose & Fix when the provider is healthy but the stage still fails."
      ],
      automaticRepair: "operator-required"
    };
  }
  if (/policy|permission|not allowed|approval/u.test(normalized)) {
    return {
      headline: "Policy or approval prevented execution",
      summary: "The workflow cannot broaden its own authority; review the denied action and grant only the narrow permission actually required.",
      instructions: [
        "Open Approvals and inspect the exact denied command or file write.",
        "Approve the bounded action or repair the project's policy from Settings.",
        "Return here and choose Retry Failed Stages."
      ],
      automaticRepair: "operator-required"
    };
  }
  if (/enoent|missing executable|command not found/u.test(normalized)) {
    return {
      headline: "Required executable is unavailable",
      summary: "Install or configure the missing executable on the worker, then retry the failed stage.",
      instructions: [
        "Inspect the failure evidence below for the missing executable name.",
        "Install it or update the worker PATH without storing credentials in the repository.",
        "Choose Retry Failed Stages after the command is available."
      ],
      automaticRepair: "operator-required"
    };
  }
  if (/lease|worker.*stale|worker.*stopped/u.test(normalized)) {
    return {
      headline: "Worker execution was interrupted",
      summary: "Expired leases can be safely recovered while preserving completed checkpoints.",
      instructions: [
        "Confirm a healthy worker is running in Settings.",
        "Use Recover Expired Leases on the Queue page if the lease remains active past its deadline.",
        "Retry the failed stage after ownership is released."
      ],
      automaticRepair: "eligible"
    };
  }
  return {
    headline: "Workflow failed",
    summary: "Agent Workflow will attempt bounded diagnosis when evidence supports it; otherwise start a focused repair run from the preserved failure evidence.",
    instructions: [
      "Review the failed stage and receipts below for the last confirmed cause.",
      "Choose Retry Failed Stages when the prerequisite is already fixed.",
      "Choose Diagnose & Fix to create a governed root-cause repair with refreshed project context."
    ],
    automaticRepair: "eligible"
  };
}

/** A run that holds a lease is executing (possibly inline, without a heartbeat). */
export function dashboardRunCanProgress(workAvailable: boolean, run: { status: string }, tasks: Array<{ status: string }> = []): boolean {
  return workAvailable || run.status === "leased" || run.status === "running" || tasks.some((task) => task.status === "leased" || task.status === "running");
}

export function workerEligibleForQueueProject(worker:{projectRootUri:string|null;projectIdentityId:string|null;sourceRevision:string|null},item:{projectIdentityId?:string|null;sourceRevision?:string|null}):boolean{
  if(worker.projectRootUri===null)return true;
  return Boolean(item.projectIdentityId&&item.sourceRevision&&worker.projectIdentityId===item.projectIdentityId&&worker.sourceRevision===item.sourceRevision);
}

export function workerEligibilityReason(workers:Array<{projectRootUri:string|null;projectIdentityId:string|null;sourceRevision:string|null}>,item:{projectIdentityId?:string|null;sourceRevision?:string|null},eligibleCount:number):string{
  if(eligibleCount)return `${eligibleCount} active worker${eligibleCount===1?" is":"s are"} eligible for this project identity and source revision.`;
  if(!workers.length)return "No active worker currently attests the required capability.";
  if(!item.projectIdentityId||!item.sourceRevision)return "The queued run lacks durable project identity or source-revision evidence required for a scoped worker.";
  return "Active capable workers are scoped to a different project identity or source revision.";
}

export function queueRunActionForm(runId: string, action: string, label: string, variant: "primary" | "secondary" = "primary"): string {
  const iconName: DashboardIconName = action === "cancel" ? "x" : action.includes("requeue") || action.includes("recover") || action.includes("retry") ? "refresh" : "play";
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button${variant === "secondary" ? ' class="secondary"' : ""} type="submit">${iconLabel(iconName, label)}</button></form>`;
}

export function renderRunInfoDialog(input: {
  idSuffix?: string;
  runId: string;
  workflowId?: string;
  status?: string;
  projectName?: string;
  projectRootUri?: string;
  task?: string;
  startedAt?: string | null;
  blockedReason?: string | null;
  failedReason?: string | null;
  summary?: string[];
}): string {
  const dialogId = `run-info-${[input.runId, input.idSuffix].filter(Boolean).join("-").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const rows = [
    ["Run", input.runId],
    ["Status", input.status],
    ["Workflow", input.workflowId],
    ["Project", input.projectName],
    ["Project path", input.projectRootUri],
    ["Started", input.startedAt ? formatDashboardDateTimeText(input.startedAt) : undefined]
  ].filter(([, value]) => Boolean(value)).map(([label, value]) => `
    <div><strong>${escapeHtml(label ?? "")}</strong><span>${escapeHtml(String(value))}</span></div>
  `).join("");
  const summary = input.summary?.filter(Boolean).length
    ? `<ul>${input.summary.filter(Boolean).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p class=\"muted\">No compact run summary is available for this row yet.</p>";
  return `<button type="button" class="secondary compact-button" onclick="document.getElementById('${escapeHtml(dialogId)}').showModal()">${iconLabel("info", "Info")}</button>
    <dialog class="run-info-dialog" id="${escapeHtml(dialogId)}">
      <div>
        <div class="section-heading">
          <div>
            <h2>Run Info</h2>
            <span class="muted">${escapeHtml(input.workflowId ?? "workflow")} · ${escapeHtml(input.runId.slice(0, 8))}</span>
          </div>
          <form method="dialog"><button class="secondary" type="submit">${iconLabel("x", "Close")}</button></form>
        </div>
        <div class="meta-grid compact">${rows}</div>
        ${input.status === "blocked" ? `<h3>Reason Blocked</h3><p class="warn-box">${escapeHtml(input.blockedReason?.trim() || "No specific blocker reason was recorded. This is a workflow defect; open the full run for stage evidence.")}</p>` : ""}
        ${input.status === "failed" ? `<h3>Reason Failed</h3><p class="warn-box">${escapeHtml(input.failedReason?.trim() || "No specific failure reason was recorded. Open the full run for stage evidence.")}</p><h3>How to resolve</h3><ol>${failedRunResolution(input.failedReason).instructions.map((instruction) => `<li>${escapeHtml(instruction)}</li>`).join("")}</ol>` : ""}
        ${input.task ? `<h3>Task</h3><p>${escapeHtml(input.task)}</p>` : ""}
        <h3>Summary</h3>
        ${summary}
        <div class="dialog-actions">
          <a class="button" href="/run?id=${encodeURIComponent(input.runId)}">${iconLabel("activity", "Open Full Run")}</a>
          <form method="dialog"><button class="secondary" type="submit">${iconLabel("check", "Stay Here")}</button></form>
        </div>
      </div>
    </dialog>`;
}

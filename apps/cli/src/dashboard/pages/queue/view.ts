import { queueRunActionForm } from "../../ui/run-actions.js";
import { escapeHtml, iconLabel } from "../../ui/layout.js";
import type { DashboardFollowUpResult } from "../../../lib/cli-types.js";
import { type QueueCardSnapshot } from "../../../lib/queue-card-snapshot.js";
import { acceptanceDigest } from "../../../../../../packages/storage/src/acceptance.js";
import { failedCardRemovalSnapshot } from "../../../lib/queue-removal.js";
import type { DashboardQueueItem, DashboardQueueSnapshot } from "../../../commands/daemon-types.js";

export function dashboardResultRunPath(result: DashboardFollowUpResult, fallbackPath: string): string {
  return result.ok && result.runId ? `/run?id=${encodeURIComponent(result.runId)}` : fallbackPath;
}

export function hasExpiredLease(item: DashboardQueueItem): boolean {
  return Boolean(item.runningLeaseExpiresAt && Date.parse(item.runningLeaseExpiresAt) < Date.now());
}

export function queueSnapshotHeaders(snapshot: QueueCardSnapshot<DashboardQueueSnapshot>): Record<string,string> {
  return {
    "x-agentflow-queue-captured-at": new Date(snapshot.capturedAt).toISOString(),
    "x-agentflow-queue-age-ms": String(Math.round(snapshot.ageMs)),
    "x-agentflow-queue-refreshing": String(snapshot.refreshing)
  };
}

export function queueDismissAllForm(queue:DashboardQueueItem[]): string {
  const removals=failedCardRemovalSnapshot(queue);
  if(!removals.length)return '<p class="muted">No failed cards in this view.</p>';
  return `<form class="bulk-dismiss-form" method="post" action="/api/queue-action">
    <input type="hidden" name="action" value="remove-failed-visible"><input type="hidden" name="removals" value="${escapeHtml(JSON.stringify(removals))}">
    <label>Reason<input name="reason" placeholder="Optional removal reason"></label>
    <label class="check-row"><input type="checkbox" name="confirmed" required> Remove these ${removals.length} reviewed failed attempts in ${queue.filter(item=>item.runStatus==='failed').length} cards; preserve failed statuses and history.</label>
    <button class="danger" type="submit">${iconLabel("trash", "Remove failed cards")}</button>
  </form>`;
}

export function queueWithdrawRunForm(item:DashboardQueueItem): string {
  if(item.runStatus==='failed'){
    const removals=failedCardRemovalSnapshot([item]);
    if(!removals.length)return '<span class="muted">This family has no current failed attempts to remove.</span>';
    return `<form class="dismiss-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="remove-failed-visible"><input type="hidden" name="removals" value="${escapeHtml(JSON.stringify(removals))}"><input name="reason" aria-label="Removal reason" placeholder="Optional removal reason"><label class="check-row"><input type="checkbox" name="confirmed" required> Remove these ${removals.length} failed family attempts; preserve history.</label><button class="danger" type="submit">${iconLabel("archive", "Remove from queue")}</button></form>`;
  }
  return `<form class="dismiss-form" method="post" action="/api/queue-action"><input type="hidden" name="runId" value="${escapeHtml(item.runId)}"><input type="hidden" name="expectedTaskDigest" value="${acceptanceDigest(item.task)}"><input type="hidden" name="action" value="withdraw-unaccepted"><input name="reason" aria-label="Withdrawal instruction" placeholder="Optional removal reason"><label class="check-row"><input type="checkbox" name="confirmed" required> Remove this exact unsuccessful run; preserve its status and history.</label><button class="danger" type="submit">${iconLabel("archive", "Remove from queue")}</button></form>`;
}

export function queueItemPrimaryForms(item: DashboardQueueItem): string {
  if (hasExpiredLease(item)) {
    return queueRunActionForm(item.runId, "recover-expired-leases", "Recover expired lease");
  }
  if (item.failedTasks > 0 || item.runStatus === "failed") {
    if (item.failureOwnership?.owner==="agent-workflow-runtime" && item.failureOwnership.requiredWorkerCapability) {
      return item.runtimeRemedy?.state==="compatible-worker-active"
        ? queueRunActionForm(item.failureOwnership.evidenceRunId,"retry-runtime-fixed","Replay validation once")
        : `<button type="button" disabled title="A current worker must attest ${escapeHtml(item.failureOwnership.requiredWorkerCapability)}">Await worker rollout</button>`;
    }
    return queueRunActionForm(item.runId, "retry-failed", "Retry failed stages");
  }
  if (item.runStatus === "blocked") {
    return queueRunActionForm(item.runId, "resolve-blocker", "Resolve blocker");
  }
  return `<a class="button secondary" href="/run?id=${encodeURIComponent(item.runId)}">${iconLabel("activity", item.runningTasks > 0 ? "Watch progress" : "Review run")}</a>`;
}

export function queueItemSecondaryForms(item: DashboardQueueItem): string {
  const forms: string[] = [];
  if (item.runningTasks > 0) {
    forms.push(queueRunActionForm(item.runId, "requeue-running", "Requeue Running"));
  }
  if (item.queuedTasks > 0 || item.runningTasks > 0 || item.failedTasks > 0 || item.runStatus === "failed" || item.runStatus === "blocked") {
    forms.push(queueRunActionForm(item.runId, "resume-checkpoint", "Resume Checkpoint"));
  }
  if (item.failedTasks > 0 || item.runStatus === "failed" || item.runStatus === "blocked") {
    if (item.runStatus === "blocked") {
      forms.push(queueRunActionForm(item.runId, "repair-blocked", "Diagnose as New Run"));
    }
    forms.push(queueWithdrawRunForm(item));
  }
  if (item.runStatus === "queued" || item.runStatus === "running") {
    forms.push(queueRunActionForm(item.runId, "cancel", "Cancel"));
  }
  return forms.join("");
}

export function queueProcessForm(project: string): string {
  return `<form class="worker-form queue-worker-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="process"><input type="hidden" name="project" value="${escapeHtml(project)}"><label>Batch limit<input name="workerLimit" inputmode="numeric" value="6"></label><label>Concurrency<input name="workerConcurrency" inputmode="numeric" value="1"></label><button type="submit">${iconLabel("play", "Process Worker Batch")}</button></form>`;
}

export function queueRecoverExpiredLeasesForm(): string {
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="recover-expired-leases"><button type="submit">${iconLabel("refresh", "Recover Expired Leases")}</button></form>`;
}

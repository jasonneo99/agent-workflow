import type { WorkflowQueueItem } from "../../../../packages/storage/src/workflow-run-types.js";
import { dashboardIcon } from "./icons.js";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/gu, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function renderApprovalWait(wait: WorkflowQueueItem["approvalWait"], executable: (type: string) => boolean): string {
  if (!wait) return "";
  const form = (id: string, decision: string, label: string, style = "") => `<form class="approval-form" method="post" action="/api/approval-action">
    <input type="hidden" name="approvalId" value="${escape(id)}"><input type="hidden" name="decision" value="${decision}">
    <input type="hidden" name="actorRole" value="${decision === "execute" ? "operator" : "approver"}">
    <button class="${style}" type="submit">${label}</button></form>`;
  return `<section class="queue-approval-wait" aria-label="Awaiting approval">
    <h3>Awaiting approval</h3><p>Progress is saved. Later stages are waiting. Approve the exact request below to continue ${escape(wait.stageId)}.</p>
    ${wait.approvals.map(approval => `<div class="queue-card-callout queue-approval-request warn">${dashboardIcon("warning", "Approval required")}<div>
      <p><strong>Allow this ${escape(approval.actionType.replaceAll("_", " "))}?</strong></p>
      <code>${escape(approval.target)}</code><p>${escape(approval.rationale)}</p>
      <details><summary>Exact request · ${escape(approval.id)}</summary><pre>${escape(JSON.stringify(approval.payload, null, 2))}</pre></details>
      <div class="actions">${approval.status === "pending"
        ? (executable(approval.actionType) ? form(approval.id, "approve_execute", "Approve and continue") + form(approval.id, "approved", "Approve only", "secondary")
          : form(approval.id, "approved", "Approve")) + form(approval.id, "rejected", "Reject", "danger")
        : approval.status === "approved" && executable(approval.actionType) ? form(approval.id, "execute", "Execute and continue")
          : `<span class="muted">${escape(approval.status === "executing" ? "Approved action is executing; continuation will follow its receipt." : approval.status)}</span>`}</div>
    </div></div>`).join("")}</section>`;
}

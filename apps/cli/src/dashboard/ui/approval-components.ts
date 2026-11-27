import { titleCase, formatNumber } from "./format.js";
import { escapeHtml } from "./layout.js";
import type { ApprovalBacklogItem, DashboardActionApproval } from "../../lib/cli-types.js";
import { approvalRuleDisplayTarget, approvalRuleExactTarget } from "../../lib/builders-approvals.js";
import { isExecutableApprovalAction } from "../../lib/builders-shared.js";
import { listActionApprovals } from "../../../../../packages/storage/src/postgres.js";

export function approvalDismissForm(approvalId: string): string {
  return `<form class="approval-form" method="post" action="/api/approval-action">
    <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
    <input type="hidden" name="decision" value="dismiss">
    <input type="hidden" name="actorRole" value="operator">
    <input name="note" aria-label="Dismissal note" placeholder="Why skip it?">
    <button class="secondary" type="submit">Dismiss</button>
  </form>`;
}

export function approvalExecuteForm(approvalId: string): string {
  return `<form class="approval-form" method="post" action="/api/approval-action">
    <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
    <input type="hidden" name="decision" value="execute">
    <input type="hidden" name="actorRole" value="operator">
    <button type="submit">Execute</button>
  </form>`;
}

export function formatApprovalAge(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatApprovalPayload(payload: Record<string, unknown>): string {
  const hash = typeof payload.payloadHash === "string" ? payload.payloadHash.slice(0, 12) : "unknown";
  const bytes = typeof payload.bytes === "number" ? `, ${formatNumber(payload.bytes)} bytes` : "";
  return `payload hash ${hash}${bytes}`;
}

export async function formatPendingApprovalNotice(runId: string, projectRootUri?: string): Promise<string> {
  const approvals = await listActionApprovals({
    runId,
    projectRootUri,
    status: "pending",
    limit: 10
  });
  if (!approvals.length) {
    return "";
  }

  const lines = [
    "Approval required:",
    "The workflow can keep processing other stages, but these side effects are waiting for approval in your current client."
  ];
  for (const approval of approvals) {
    const executable = isExecutableApprovalAction(approval.actionType);
    lines.push(
      `- ${approval.actionType} ${approval.target}`,
      `  id: ${approval.id}`,
        `  requested by: ${approval.stageId} (${approval.agentId})`,
        `  approve in CLI: npm run agentflow -- approvals --approve ${approval.id} --actor "Your Name" --actor-role approver`,
        executable ? `  approve and execute in CLI: npm run agentflow -- approvals --approve-execute ${approval.id} --actor "Your Name" --actor-role approver` : "",
        approval.actionType === "local_command" || approval.actionType === "file_write" || approval.actionType === "executor_adapter" ? `  always exact in CLI: npm run agentflow -- approvals --always ${approval.id} --always-scope exact --actor "Your Name" --actor-role approver` : "",
        approval.actionType === "local_command" || approval.actionType === "file_write" ? `  always broad in CLI: npm run agentflow -- approvals --always ${approval.id} --always-scope broad --actor "Your Name" --actor-role approver` : "",
        executable ? `  execute after approval: npm run agentflow -- approvals --execute ${approval.id} --actor "Your Name" --actor-role operator` : "",
        `  approve in dashboard: /approvals?run=${encodeURIComponent(runId)}`,
        "  approve in MCP/Codex: ask the user to choose approve and execute, approve only, reject, always exact, always broad, execute, or dismiss; then call agentflow_approvals with the matching field and id."
    );
  }
  return lines.filter(Boolean).join("\n");
}

export function renderMobileApprovalCard(approval: DashboardActionApproval, backlogItem?: ApprovalBacklogItem): string {
  const risk = backlogItem?.autopilotRisk ?? (approval.actionType === "deployment" || approval.actionType === "autonomy" ? "high" : "medium");
  const ageReference = approval.updatedAt ?? approval.createdAt;
  const ageMs = Math.max(0, Date.now() - Date.parse(ageReference));
  const executable = isExecutableApprovalAction(approval.actionType);
  const decisionControls = approval.status === "pending"
    ? `<div class="mobile-approval-actions">
        <form method="post" action="/api/approval-action">
          <input type="hidden" name="approvalId" value="${escapeHtml(approval.id)}">
          <input type="hidden" name="decision" value="rejected">
          <input type="hidden" name="actorRole" value="approver">
          <button class="danger secondary" type="submit">Reject</button>
        </form>
        ${approval.actionType === "local_command" || approval.actionType === "file_write" ? `<form method="post" action="/api/approval-rule-action">
          <input type="hidden" name="approvalId" value="${escapeHtml(approval.id)}">
          <input type="hidden" name="actorRole" value="approver">
          <input type="hidden" name="target" value="${escapeHtml(approvalRuleExactTarget(approval))}">
          <input type="hidden" name="approveCurrent" value="on">
          <input type="hidden" name="note" value="Always approve ${escapeHtml(approvalRuleDisplayTarget(approval, approvalRuleExactTarget(approval)))}">
          <button class="secondary" type="submit">Always allow</button>
        </form>` : ""}
        <form method="post" action="/api/approval-action">
          <input type="hidden" name="approvalId" value="${escapeHtml(approval.id)}">
          <input type="hidden" name="decision" value="${executable ? "approve_execute" : "approved"}">
          <input type="hidden" name="actorRole" value="approver">
          <button type="submit">${executable ? "Approve & run" : "Approve"}</button>
        </form>
      </div>`
    : approval.status === "approved" && executable
      ? `<div class="mobile-approval-actions two-up">${approvalDismissForm(approval.id)}${approvalExecuteForm(approval.id).replace(">Execute<", ">Execute now<")}</div>`
      : approval.status === "failed" && executable
        ? `<div class="mobile-approval-actions two-up">${approvalDismissForm(approval.id)}${approvalExecuteForm(approval.id).replace(">Execute<", ">Retry now<")}</div>`
        : `<p class="muted">${escapeHtml(approval.decisionNote ?? "No action available.")}</p>`;
  return `<article class="mobile-approval-card risk-${escapeHtml(risk)}">
    <div class="mobile-approval-meta">
      <span class="approval-risk"><strong>${escapeHtml(titleCase(risk))} risk</strong></span>
      <span class="approval-kind">${escapeHtml(titleCase(approval.actionType.replaceAll("_", " ")))}</span>
      <span class="approval-age">${escapeHtml(formatApprovalAge(ageMs))}</span>
    </div>
    <div class="mobile-approval-context">
      <strong>${escapeHtml(approval.projectName)}</strong>
      <span>${escapeHtml(approval.workflowId)} · ${escapeHtml(approval.stageId)}</span>
    </div>
    <code class="mobile-approval-target">${escapeHtml(approval.target)}</code>
    <details class="mobile-approval-details">
      <summary>View details</summary>
      <dl>
        <div><dt>Requested by</dt><dd>${escapeHtml(approval.agentId)}</dd></div>
        <div><dt>Why</dt><dd>${escapeHtml(approval.rationale)}</dd></div>
        <div><dt>Approval ID</dt><dd>${escapeHtml(approval.id)}</dd></div>
        <div><dt>Run</dt><dd><a href="/run?id=${encodeURIComponent(approval.runId)}">${escapeHtml(approval.runId)}</a></dd></div>
        <div><dt>Payload</dt><dd>${escapeHtml(formatApprovalPayload(approval.payload))}</dd></div>
      </dl>
    </details>
    ${decisionControls}
  </article>`;
}

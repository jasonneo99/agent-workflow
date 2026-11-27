import { formatNumber } from "./format.js";
import { escapeHtml } from "./layout.js";
import type { DashboardFeedbackTarget, FeedbackRating } from "../../lib/cli-types.js";
import { defaultFeedbackNote, formatDuration, loadDashboardFeedbackTargetsFromRuns, readDashboardJsonFile, readTuningApprovalHistory, tuningHistoryEventSignature } from "../../lib/builders-learning.js";
import { formatDashboardDateTimeText } from "../../lib/builders-runs.js";
import { countStrings } from "../../lib/builders-shared.js";
import { type TuningApprovalHistory, type TuningHistoryStatus, type TuningProposalSet } from "../../../../../packages/run-reporter/src/index.js";
import { listWorkflowRunsForProject } from "../../../../../packages/storage/src/postgres.js";
import path from "node:path";
import type { DashboardTuningOverlayStatus, TuningOverlayDocument } from "../../commands/daemon-types.js";

export function countDuplicateTuningHistoryEvents(history: TuningApprovalHistory, status?: TuningHistoryStatus): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const event of history.events) {
    if (status && event.status !== status) {
      continue;
    }
    const key = tuningHistoryEventSignature(event);
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

export function feedbackTargetActionForm(runId: string, rating: FeedbackRating, label: string, note: string): string {
  return `<form class="feedback-form compact-feedback-form" method="post" action="/api/follow-up">
    <input type="hidden" name="runId" value="${escapeHtml(runId)}">
    <input type="hidden" name="action" value="feedback">
    <input type="hidden" name="rating" value="${escapeHtml(rating)}">
    <input name="note" value="${escapeHtml(note)}" aria-label="${escapeHtml(label)} feedback note" placeholder="Why?">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

export async function loadDashboardFeedbackTargets(projectRuns: Awaited<ReturnType<typeof listWorkflowRunsForProject>>): Promise<DashboardFeedbackTarget[]> {
  const candidates = projectRuns
    .filter((run) => run.status === "completed" || run.status === "failed")
    .slice(0, 25);
  return loadDashboardFeedbackTargetsFromRuns(candidates, 8);
}

export async function loadDashboardTuningOverlayStatus(projectDir: string): Promise<DashboardTuningOverlayStatus> {
  const overlayPath = path.join(projectDir, ".agent-workflow", "tuning", "proposals.json");
  const overlayResult = await readDashboardJsonFile<TuningOverlayDocument>(overlayPath, (value) =>
    value.kind === "agentflow_tuning_overlay" &&
    Array.isArray(value.selectedIds) &&
    Array.isArray(value.proposals)
  );
  const history = await readTuningApprovalHistory(projectDir).catch(() => null);
  const appliedEvents = history?.events.filter((event) => event.status === "applied").length ?? 0;
  const appliedProposalIds = [...new Set((history?.events ?? [])
    .filter((event) => event.status === "applied")
    .map((event) => event.proposalId))]
    .sort();
  const latestAppliedAt = history?.events
    .filter((event) => event.status === "applied")
    .map((event) => event.occurredAt)
    .sort()
    .at(-1) ?? null;
  const duplicateAppliedEvents = history ? countDuplicateTuningHistoryEvents(history, "applied") : 0;
  return {
    exists: overlayResult.exists && !overlayResult.error && Boolean(overlayResult.value),
    path: ".agent-workflow/tuning/proposals.json",
    generatedAt: overlayResult.value?.generatedAt ?? null,
    sourceGeneratedAt: overlayResult.value?.sourceGeneratedAt ?? null,
    sourceRunsAnalyzed: overlayResult.value?.sourceRunsAnalyzed ?? null,
    selectedIds: overlayResult.value?.selectedIds ?? [],
    appliedProposalIds,
    proposalCount: overlayResult.value?.proposals?.length ?? 0,
    proposalKinds: countStrings((overlayResult.value?.proposals ?? []).map((proposal) => proposal.kind)),
    latestAppliedAt,
    appliedEvents,
    duplicateAppliedEvents,
    error: overlayResult.error
  };
}

export function renderFeedbackTargetActionForms(target: DashboardFeedbackTarget): string {
  return `
    <div class="feedback-row-actions">
      ${feedbackTargetActionForm(target.runId, "accepted", "Accept", defaultFeedbackNote(target, "accepted"))}
      ${feedbackTargetActionForm(target.runId, "revised", "Revise", defaultFeedbackNote(target, "revised"))}
      ${feedbackTargetActionForm(target.runId, "rejected", "Reject", defaultFeedbackNote(target, "rejected"))}
    </div>
  `;
}

export function renderFeedbackTargetEvidenceHtml(target: DashboardFeedbackTarget): string {
  const quality = target.quality
    ? [
      `quality ${target.quality.averageQuality ?? "n/a"}`,
      `${target.quality.qualityPassCount} pass`,
      `${target.quality.qualityFailCount} review`,
      `${target.quality.fallbackCount} fallback`,
      target.quality.averageLatencyMs === null ? "" : `avg ${formatDuration(target.quality.averageLatencyMs)}`
    ].filter(Boolean).join(" · ")
    : "quality n/a";
  const findings = target.summary?.keyFindings.length
    ? `<strong>Findings</strong><ul>${target.summary.keyFindings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  const failures = target.summary?.failures.length
    ? `<strong>Failures</strong><ul>${target.summary.failures.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";
  return `<span class="muted">${escapeHtml(quality)}</span>${findings}${failures}`;
}

export function renderTuningProposalsHtml(proposalSet: TuningProposalSet, tuningOverlay?: DashboardTuningOverlayStatus): string {
  const appliedIds = new Set([
    ...(tuningOverlay?.selectedIds ?? []),
    ...(tuningOverlay?.appliedProposalIds ?? [])
  ]);
  const activeProposals = proposalSet.proposals.filter((proposal) => !appliedIds.has(proposal.id));
  const appliedCurrentProposals = proposalSet.proposals.filter((proposal) => appliedIds.has(proposal.id));
  const summary = proposalSet.summary.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const rows = activeProposals.slice(0, 8).map((proposal) => `
    <tr>
      <td>${escapeHtml(proposal.id)}<br><span class="flag ${proposal.priority === "high" ? "bad" : proposal.priority === "medium" ? "warn" : "good"}">${escapeHtml(proposal.priority)}</span></td>
      <td>${escapeHtml(proposal.kind)}</td>
      <td>${escapeHtml(proposal.workflowId)}<br><span class="muted">${escapeHtml(proposal.stageId)} / ${escapeHtml(proposal.agentId)}</span></td>
      <td>${escapeHtml(proposal.recommendation)}</td>
      <td>${escapeHtml(proposal.patchHint)}</td>
    </tr>
  `).join("");
  const appliedRows = appliedCurrentProposals.slice(0, 8).map((proposal) => `
    <tr>
      <td>${escapeHtml(proposal.id)}<br><span class="flag good">applied</span></td>
      <td>${escapeHtml(proposal.kind)}</td>
      <td>${escapeHtml(proposal.workflowId)}<br><span class="muted">${escapeHtml(proposal.stageId)} / ${escapeHtml(proposal.agentId)}</span></td>
      <td>${escapeHtml(proposal.recommendation)}</td>
      <td>${escapeHtml(tuningOverlay?.latestAppliedAt ? `Applied ${formatDashboardDateTimeText(tuningOverlay.latestAppliedAt)}` : "Applied in project-local tuning overlay.")}</td>
    </tr>
  `).join("");
  const appliedNotice = appliedCurrentProposals.length
    ? `<p class="success">${formatNumber(appliedCurrentProposals.length)} current proposal(s) already have project-local tuning overlay/history and are hidden from the active list.</p>`
    : tuningOverlay?.exists
      ? `<p class="muted">A tuning overlay exists, but none of the current proposal ids match its applied ids. New evidence may have generated fresh proposals.</p>`
      : "";

  return `
    <ul>${summary}</ul>
    ${appliedNotice}
    <form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="action" value="apply-tuning-dry-run">
      <input type="hidden" name="project" value="${escapeHtml(proposalSet.projectRootUri)}">
      <input name="ids" value="${escapeHtml(activeProposals.length ? "all" : "")}" aria-label="Proposal ids" placeholder="No active proposal ids">
      <button type="submit">Dry Run Apply</button>
    </form>
    <table>
      <thead><tr><th>ID</th><th>Kind</th><th>Target</th><th>Recommendation</th><th>Patch Hint</th></tr></thead>
      <tbody>${rows || "<tr><td colspan=\"5\">No active unapplied tuning proposals.</td></tr>"}</tbody>
    </table>
    ${appliedRows ? `<details class="governance-details"><summary>Applied Current Proposals</summary><div class="table-wrap"><table><thead><tr><th>ID</th><th>Kind</th><th>Target</th><th>Recommendation</th><th>Status</th></tr></thead><tbody>${appliedRows}</tbody></table></div></details>` : ""}
  `;
}

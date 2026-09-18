import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("dashboard exposes a unified redacted activity timeline and API", () => {
  assert.match(source, /requestUrl\.pathname === "\/activity"/u);
  assert.match(source, /requestUrl\.pathname === "\/api\/activity"/u);
  assert.match(source, /One chronological, redacted view/u);
  assert.match(source, /Prompt bodies, model response bodies, credentials, private file contents/u);
  assert.match(source, /\["activity", "\/activity", "Activity", "list"\]/u);
});

test("activity aggregation includes durable and project-local event sources", () => {
  for (const sourceName of [
    "workflow_runs",
    "workflow_tasks",
    "action_receipts",
    "action_approvals",
    "learning/action-receipts.json",
    "learning/daemon-status.json",
    "learning/roadmap-snapshot-publication.json",
    "runtime/server/request-log.jsonl"
  ]) assert.match(source, new RegExp(sourceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("run detail exposes an in-place live progress log", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/run-progress"/u);
  assert.match(source, /listActivityEvents\(\{ runId, limit: 250 \}\)/u);
  assert.match(source, /id="run-live-log"/u);
  assert.match(source, /aria-label="Run progress log"/u);
  assert.match(source, /fetch\('\/api\/run-progress\?id='/u);
  assert.match(source, /next update in 2s/u);
  assert.doesNotMatch(source, /meta http-equiv=\\"refresh\\" content=\\"5\\"/u);
});

test("run detail acts as a live governed command center", () => {
  assert.match(source, /id="run-command-center"/u);
  assert.match(source, /renderRunCommandCenterBody/u);
  assert.match(source, /Decisions Required/u);
  assert.match(source, /approvalDecisionForms|renderMobileApprovalCard/u);
  assert.match(source, /All Run Approvals/u);
  assert.match(source, /commandCenterHtml/u);
  assert.match(source, /The workflow resumes automatically after its final required action is resolved/u);
  assert.match(source, /resumeBlockedRunAfterResolvedApprovals/u);
  assert.match(source, /Final required approval resolved; resume from completed checkpoints/u);
  assert.match(source, /runId: resumed\.replacementRunId \?\?/u);
  assert.match(source, /redirectToRun: Boolean\(resumed\.replacementRunId\)/u);
  assert.match(source, /result\.ok && result\.redirectToRun && result\.runId/u);
});

test("run detail renders a live numbered stage timeline", () => {
  assert.match(source, /id="run-stage-timeline"/u);
  assert.match(source, /renderRunStageTimeline/u);
  assert.match(source, /aria-label="Workflow stage progress"/u);
  assert.match(source, /run-stage-circle/u);
  assert.match(source, /stageTimelineHtml/u);
  assert.match(source, /task\.status === "completed"[\s\S]+"completed"/u);
  assert.match(source, /task\.status === "completed" && !task\.skipped/u);
  assert.match(source, /Workflow completed with exceptions/u);
});

test("run stages open a bounded live stage activity view", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/run-stage"/u);
  assert.match(source, /data-stage-watch=/u);
  assert.match(source, /id="stage-watch-dialog"/u);
  assert.match(source, /aria-label="Stage activity log"/u);
  assert.match(source, /What the agent is doing/u);
  assert.match(source, /fetch\('\/api\/run-stage\?id='/u);
  assert.match(source, /slice\(0, 16_000\)/u);
  assert.match(source, /taskId === task\.id/u);
});

test("run detail shows and safely changes the run approval level", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/run-approval-level"/u);
  assert.match(source, /Approval level/u);
  assert.match(source, /aria-label="Run approval level"/u);
  assert.match(source, /Project\/profile ceiling/u);
  assert.match(source, /setQueuedWorkflowRunAutonomy/u);
  assert.match(source, /autonomyOverride: level/u);
  assert.match(source, /preserveCompletedCheckpoints: true/u);
  assert.match(source, /cannot change while a worker owns the run/u);
  assert.match(source, /No continuation or policy mutation was created/u);
});

test("run detail clearly links checkpoint continuation runs in both directions", () => {
  assert.match(source, /id="run-continuation"/u);
  assert.match(source, /renderRunContinuationBanner/u);
  assert.match(source, /This run has active follow-up work/u);
  assert.match(source, /Open continuation run/u);
  assert.match(source, /Follow-up run in progress/u);
  assert.match(source, /evaluationMetadata\?\.sourceRunId/u);
  assert.match(source, /continuationHtml/u);
});

test("queue presents active recovery chains without counting source failures twice", () => {
  assert.match(source, /const recovering = queue\.filter/u);
  assert.match(source, /<strong>Recovering<\/strong>/u);
  assert.match(source, /Recovery in Progress/u);
  assert.match(source, /recovery running/u);
  assert.match(source, /!recoveringRunIds\.has\(item\.runId\)/u);
});

test("failed runs expose their reason and root-cause resolution controls", () => {
  assert.match(source, /Reason Failed/u);
  assert.match(source, /failedRunResolution\(run\.failedReason\)/u);
  assert.match(source, /Retry Failed Stages/u);
  assert.match(source, /Diagnose & Fix/u);
  assert.match(source, /Open Providers/u);
  assert.match(source, /Open Approvals/u);
  assert.match(source, /provider-use codex-cli --login --check/u);
});

test("blocked runs explain resolution choices and allow an audited skip", () => {
  assert.match(source, /How to move this run forward/u);
  assert.match(source, /Skip blocked stage &amp; continue/u);
  assert.match(source, /name="confirmed" required/u);
  assert.match(source, /action === "skip-blocker"/u);
  assert.match(source, /skipStageIds: skippedStageIds/u);
  assert.match(source, /redirectToRun: true/u);
  assert.match(source, /This run is read-only history/u);
  assert.match(source, /Do not act on blockers here/u);
});

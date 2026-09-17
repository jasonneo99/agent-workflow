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

test("run detail clearly links checkpoint continuation runs in both directions", () => {
  assert.match(source, /id="run-continuation"/u);
  assert.match(source, /renderRunContinuationBanner/u);
  assert.match(source, /This run continued in a new run/u);
  assert.match(source, /Open continuation run/u);
  assert.match(source, /New continuation run started/u);
  assert.match(source, /it did not restart from stage 1/u);
  assert.match(source, /continuationHtml/u);
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

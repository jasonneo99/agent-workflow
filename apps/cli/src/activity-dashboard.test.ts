import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  "./index.ts",
  "./commands/system.ts",
  "./commands/bundle.ts",
  "./commands/project.ts",
  "./commands/storage.ts",
  "./commands/runs.ts",
  "./commands/approvals.ts",
  "./commands/learning.ts",
  "./commands/local-llm.ts",
  "./commands/server.ts",
  "./commands/context-extra.ts",
  "./commands/daemon.ts",
  "./lib/builders-shared.ts",
  "./lib/builders-learning.ts",
      "./lib/builders-server.ts",
      "./lib/builders-system.ts",
      "./lib/builders-bundle.ts",
      "./lib/builders-project.ts",
      "./lib/builders-storage.ts",
      "./lib/builders-runs.ts",
      "./lib/builders-approvals.ts",
      "./lib/builders-local-llm.ts",
      "./lib/builders-context.ts",
      "./lib/context.ts",
      "./lib/cli-types.ts",
].map((p) => {
  try {
    return readFileSync(new URL(p, import.meta.url), "utf8");
  } catch {
    return "";
  }
}).join("\n");
const stylesSource = readFileSync(new URL("./dashboard/styles.ts", import.meta.url), "utf8");
const questionChatSource = ["./dashboard/question-chat.ts", "./dashboard/partner-chat-client.ts"].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");

test("dashboard exposes a unified redacted activity timeline and API", () => {
  assert.match(source, /requestUrl\.pathname === "\/activity"/u);
  assert.match(source, /requestUrl\.pathname === "\/api\/activity"/u);
  assert.match(source, /One chronological, redacted view/u);
  assert.match(source, /Prompt bodies, model response bodies, credentials, private file contents/u);
  assert.match(source, /\["activity", "\/activity", "Activity", "list"\]/u);
});

test("queue watcher preserves exact project baseline and updates cards without replacing Partner",()=>{
 assert.match(source,/watcher\.postMessage\(\{ type: "start", project: \$\{serializeInlineScriptJson\(projectFilter \|\| null\)\}/u);
 assert.match(source,/id="queue-watch-refresh" hidden/u);
 assert.match(source,/queueCardRefreshScript\(\)/u);
 assert.match(source,/if \(event\.data\.changed\) cards.request\(\)/u);
 assert.match(source,/const fallback = window\.setInterval\(\(\) => cards\.request\(\), 10000\)/u);
 assert.match(source,/clearInterval\(fallback\); watcher\.postMessage\(\{ type: "stop" \}\)/u);
 assert.match(source,/data-queue-live-region="cards"/u);
 assert.match(source,/buildQueueCardTitle\(item\)/u);
 assert.match(source,/<strong>Version set<\/strong>[^\n]+versionSetId/u);
 assert.match(source,/requestUrl\.searchParams\.get\("_queue_snapshot"\) === "fresh"/u);
 assert.match(source,/loadQueueCardSnapshot\(projectRootUri, freshSnapshot\)/u);
 assert.match(source,/listWorkflowQueue\(100, \{ projectRootUri, latestRelated: true \}\)/u);
});

test("home human intervention renders as a compact keyboard-scrollable list", () => {
  assert.match(source, /class="ops-approval-list" role="region" aria-label="Human intervention items" tabindex="0"/u);
  assert.match(stylesSource, /\.ops-approval-list \{ display: grid; align-content: start; max-height: 268px; overflow-y: auto/u);
  assert.match(stylesSource, /\.ops-approval-row \{[^}]+min-height: 40px; padding: 5px 2px/u);
});

test("home omits the conversation while queue and run surfaces retain governed Partner chat", () => {
  const home=source.slice(source.indexOf('function renderDashboardHtml('),source.indexOf('\n  function ',source.indexOf('function renderDashboardHtml(')+1));
  assert.doesNotMatch(home,/renderDashboardQuestionPanel\(/u);
  assert.match(questionChatSource, /id="dashboard-question-form"/u);
  assert.match(questionChatSource, /id="dashboard-question-thread"[^>]+role="log"/u);
  assert.match(questionChatSource, /fetch\('\/api\/queue-partner-message'/u);
  assert.match(questionChatSource, /'x-agentflow-queue-partner':'1'/u);
  assert.match(questionChatSource, /conversationId:chat\.id/u);
  assert.match(questionChatSource, /proposalFor\(chat\)/u);
  assert.match(source, /createPartnerChatAdapter\(projectId, root/u);
  assert.match(questionChatSource, /isTrustedLocalDashboardRequest/u);
  assert.match(stylesSource, /\.ops-question-thread \{[^}]+max-height: 320px; overflow-y: auto/u);
  assert.match(stylesSource, /\.ops-question-form \{[^}]+grid-template-columns/u);
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

test("workflow runs expose evidence-based live ETA estimates", () => {
  assert.match(source, /eta: estimateRunEta\(\{ run, tasks: \[\{ status: run\.status \}\], historicalRuns: runs \}\)/u);
  assert.match(source, /eta: estimateRunEta\(\{ run: details\.run, tasks: details\.tasks, historicalRuns \}\)/u);
  assert.match(source, /id="run-live-eta"/u);
  assert.match(source, /payload\.eta\.confidence/u);
  assert.match(source, /<th>ETA<\/th>/u);
  assert.match(source, /estimateQueueItemEta\(item, historicalRuns\)/u);
  assert.match(source, /<strong>ETA<\/strong>/u);
  assert.match(source, /renderOpsAgentFlow\(health\.queue, runs\)/u);
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

test("run stages use the inline verbose live progress stream", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/run-stage"/u);
  assert.match(source, /data-stage-watch=/u);
  assert.match(source, /id="run-live-verbose"/u);
  assert.match(source, /Verbose stage activity stream/u);
  assert.match(source, /Streaming full activity for stage/u);
  assert.match(source, /verboseRunEntries/u);
  assert.match(source, /Artifact · /u);
  assert.match(source, /Action · /u);
  assert.doesNotMatch(source, /id="stage-watch-dialog"/u);
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
  assert.match(source, /queue-family-attempts/u);
  assert.match(source, /All \$\{formatNumber\(item.familyAttempts.length\)\} attempts in this version set/u);
  assert.match(source, /Open family in new window/u);
  assert.match(source, /attempt.approvals.map/u);
  assert.match(source, /escapeHtml\(redactApprovalCardText\(attempt.blocker,2000\)\)/u);
  assert.match(source, /approval record\(s\) need review/u);
  assert.match(source, /const recovering = queue\.filter/u);
  assert.match(source, /<strong>Recovering<\/strong>/u);
  assert.match(source, /Recovery in Progress/u);
  assert.match(source, /recovery running/u);
  assert.match(source, /!recoveringRunIds\.has\(item\.runId\)/u);
  assert.match(source, /\/runs\?relatedTo=\$\{encodeURIComponent\(item\.runId\)\}/u);
  assert.match(source, /Open history/u);
  assert.match(source, /latestRelated: true/u);
  assert.match(source, /Earlier attempts need review/u);
});

test("run history presents a concise summary while preserving the original request", () => {
  assert.match(source, /class="run-task-cell"/u);
  assert.match(source, /dashboardRunPresentation\(run\)/u);
  assert.match(source, /<strong>\$\{escapeHtml\(presentation\.title\)\}<\/strong>/u);
  assert.match(source, /<details class="run-task-details"><summary>Original request<\/summary>/u);
  assert.match(stylesSource, /\.run-task-cell \{[^}]+max-width: 420px/u);
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

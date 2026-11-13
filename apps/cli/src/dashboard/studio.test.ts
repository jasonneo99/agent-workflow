import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderStudioHtml } from "./studio.js";

const workflows = [
  { id: "build-feature", name: "Build Feature", triggers: { manual: true } },
  { id: "automatic-only", name: "Automatic Only", triggers: { manual: false } }
];

test("studio renders the task-first governed workflow surface", () => {
  const html = renderStudioHtml({ workflows, defaultProject: "templates/project" });
  assert.match(html, /Archive from active views/);
  assert.match(html, /Restore to active views/);

  assert.match(html, /Agent Workflow Studio/);
  assert.match(html, /href="\/#dashboard-question-heading">Queue Partner<\/a>/);
  assert.match(html, /href="\/assets\/agent-workflow-favicon\.png"/);
  assert.match(html, /src="\/assets\/agent-workflow-mark\.png"/);
  assert.doesNotMatch(html, /class="brand-mark"/);
  assert.match(html, /id="stage-strip"/);
  assert.match(html, /Changes/);
  assert.match(html, /Tests/);
  assert.match(html, /Artifacts/);
  assert.match(html, /Receipts/);
  assert.match(html, /action="\/api\/studio-task"/);
  assert.match(html, /action="\/api\/follow-up"/);
  assert.match(html, /name="returnTo"/);
  assert.match(html, /id="approval-banner"/);
  assert.match(html, /params\.get\("run"\) \|\| params\.get\("actionRun"\)/);
  assert.match(html, /id="command-return" value="\/studio"/);
  assert.match(html, /id="accept-return" value="\/studio"/);
  assert.match(html, /value="auto" selected/);
  assert.match(html, /Auto-route from my request/);
  assert.match(html, /\/api\/studio-route\?project=/);
  assert.match(html, /id="routing-preview"/);
  assert.match(html, /id="plan-editor"/);
  assert.match(html, /name="planStages"/);
  assert.match(html, /data-run-action="resume-checkpoint"/);
  assert.match(html, /data-run-action="replay-run"/);
  assert.match(html, /data-tab="files"/);
  assert.match(html, /data-tab="terminal"/);
  assert.match(html, /\/api\/studio-workspace\?project=/);
  assert.match(html, /new EventSource\("\/api\/studio-events"\)/);
  assert.match(html, /id="live-status">Connecting…/);
  assert.match(html, /events\.addEventListener\("error"/);
  assert.match(html, /setInterval\(\(\) => refresh\(false\), 5000\)/);
  assert.match(html, /refreshInFlight/);
  assert.match(html, /replacementRunId/);
  assert.match(html, /Historical task/);
  assert.match(html, /taskTitle\(run\.task\)/);
  assert.match(html, /id="outcome-card"/);
  assert.match(html, /renderOutcome\(run, details\.outcome/);
  assert.match(html, /result\.acceptReady/);
  assert.match(html, /id="needs-input-card"/);
  assert.match(html, /Studio needs your input/);
  assert.match(html, /runAction\("resume-checkpoint"\)/);
  assert.match(html, /const projectOptions =/);
  assert.match(html, /new Map\(visible\.map/);
  assert.match(html, /Connection indicator|setConnection\("polling", "Polling"\)/);
  assert.match(html, /status === "blocked" \? "blocked"/);
  assert.match(html, /status === "cancelled" \? "cancelled"/);
  assert.match(html, /action="\/api\/studio-reply"/);
  assert.match(html, /Requested by/);
  assert.match(html, /Reply with what’s missing/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /id="project-switcher"/);
  assert.match(html, /Guide evidence/);
  assert.match(html, /learning\?view=diagnostics&amp;project=templates%2Fproject#guide-evidence-integrity/);
  assert.match(html, /updateGuideEvidenceLink\(run\.projectRootUri/);
  assert.doesNotMatch(html, /Automatic Only/);
});

test("studio escapes configured project paths", () => {
  const html = renderStudioHtml({ workflows, defaultProject: 'projects/<private>&"demo"' });

  assert.match(html, /projects\/&lt;private&gt;&amp;&quot;demo&quot;/);
  assert.doesNotMatch(html, /projects\/<private>/);
});

test("coordinator history is exposed consistently by CLI, MCP, dashboard, and Studio", () => {
  const cli=readFileSync(new URL("../commands/runs.ts",import.meta.url),"utf8");
  const mcp=readFileSync(new URL("../../../mcp/src/index.ts",import.meta.url),"utf8");
  const dashboard=readFileSync(new URL("../commands/daemon.ts",import.meta.url),"utf8");
  assert.match(cli,/coordinator-history-\$\{action\}/);assert.match(cli,/\["archive", "restore"\]/);
  assert.match(cli,/COORDINATOR_HISTORY_ARCHIVE_CONFIRMATION/);assert.match(cli,/executionAuthorityGranted:false/);
  assert.match(mcp,/agentflow_coordinator_history/);assert.match(mcp,/Exact human-approved obsolete run list/);
  assert.match(dashboard,/\/api\/coordinator-history/);assert.match(dashboard,/Archive from active views/);
  assert.match(dashboard,/runs = historyRuns[\s\S]+\.filter\(\(run\) => !run\.dismissed\)[\s\S]+\.filter\(\(run\) => run\.workflowId === workflow\.id\)/);
});

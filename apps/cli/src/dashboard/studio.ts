type StudioWorkflow = {
  id: string;
  name: string;
  triggers: { manual: boolean };
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(name: "activity" | "check" | "chevron" | "code" | "file" | "folder" | "play" | "plus" | "search" | "send" | "shield"): string {
  const paths = {
    activity: '<path d="M4 12h3l2-7 4 14 2-7h5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    code: '<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/>',
    file: '<path d="M6 3h8l4 4v14H6zM14 3v5h5"/>',
    folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
  } as const;
  return `<svg class="studio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function renderStudioHtml(input: { workflows: StudioWorkflow[]; defaultProject: string }): string {
  const workflowOptions = input.workflows
    .filter((workflow) => workflow.triggers.manual)
    .map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Studio</title>
  <style>${studioCss()}</style>
</head>
<body>
  <div class="studio-shell">
    <header class="studio-topbar">
      <a class="studio-brand" href="/studio" aria-label="Agent Workflow Studio home"><span class="brand-mark">&gt;_</span><strong>Agent Workflow Studio</strong></a>
      <div class="studio-crumbs"><select id="project-switcher" aria-label="Switch project"><option value="${escapeHtml(input.defaultProject)}">Projects</option></select><span>/</span><span>Tasks</span><span>/</span><b id="run-crumb">Current</b></div>
      <label class="studio-search" for="task-search">${icon("search")}<input id="task-search" type="search" placeholder="Search tasks" autocomplete="off"><kbd>⌘ K</kbd></label>
      <a class="topbar-link" href="/">Dashboard</a>
    </header>

    <aside class="studio-rail">
      <nav aria-label="Studio navigation">
        <a class="rail-link active" href="/studio">${icon("activity")}<span>Active task</span></a>
        <a class="rail-link" href="/projects">${icon("folder")}<span>Projects</span></a>
        <a class="rail-link" href="/runs">${icon("file")}<span>Run history</span></a>
        <a class="rail-link" href="/approvals?status=open">${icon("shield")}<span>Approvals</span><i id="approval-count" hidden>0</i></a>
      </nav>
      <section class="rail-section">
        <div class="rail-heading"><span>Recent tasks</span><button type="button" id="new-task-compact" aria-label="Start a task">${icon("plus")}</button></div>
        <div id="run-list" class="run-list"><div class="rail-loading">Loading workflow history…</div></div>
      </section>
      <button class="new-task-button" id="new-task" type="button">${icon("plus")} Start a task</button>
      <div class="rail-footer"><span class="health-dot"></span><span>Local runtime</span><b>Connected</b></div>
    </aside>

    <main class="task-workspace" id="task-workspace" aria-live="polite">
      <section class="task-pane">
        <div class="task-scroll">
          <div id="studio-notice" class="studio-notice" hidden></div>
          <div class="task-kicker"><span id="run-short">RUN</span><span id="task-status" class="status-token">Loading</span></div>
          <section id="approval-banner" class="approval-banner" hidden>${icon("shield")}<span><strong>Approval required</strong><small id="approval-summary">Review the requested action before this workflow can continue.</small></span><div id="inline-approval-actions"></div></section>
          <h1 id="task-title">Loading your workflow…</h1>
          <p id="task-summary">Connecting to Agent Workflow and finding the most recent task.</p>
          <div id="stage-strip" class="stage-strip" aria-label="Workflow progress"></div>
          <div class="run-toolbar" id="run-toolbar"><button type="button" data-run-action="pause">Pause</button><button type="button" data-run-action="resume-checkpoint">Resume</button><button type="button" data-run-action="retry-failed">Retry</button><button type="button" data-run-action="replay-run">Replay</button><button type="button" data-run-action="cancel">Cancel</button></div>
          <div class="activity-header"><h2>Task thread</h2><a id="open-run" href="/runs">Open full run ${icon("chevron")}</a></div>
          <div id="activity-feed" class="activity-feed"><div class="empty-state">Waiting for run details…</div></div>
        </div>

        <form class="command-composer" id="command-form" method="post" action="/api/studio-task">
          <input type="hidden" name="returnTo" id="command-return" value="/studio">
          <input type="hidden" name="project" id="command-project" value="${escapeHtml(input.defaultProject)}">
          <input type="hidden" name="workflowId" id="command-workflow" value="build-feature">
          <label for="command-task">Command</label>
          <div class="command-field">${icon("chevron")}<textarea id="command-task" name="task" rows="2" placeholder="Tell the workflow what to do next…" required></textarea><button type="submit" aria-label="Send command">${icon("send")}</button></div>
          <p>Starts a governed follow-up run using this task’s project and workflow.</p>
        </form>
      </section>

      <aside class="evidence-pane">
        <div class="evidence-tabs" role="tablist" aria-label="Run evidence">
          <button class="active" role="tab" aria-selected="true" data-tab="changes">Changes</button>
          <button role="tab" aria-selected="false" data-tab="tests">Tests</button>
          <button role="tab" aria-selected="false" data-tab="artifacts">Artifacts</button>
          <button role="tab" aria-selected="false" data-tab="receipts">Receipts</button><button role="tab" aria-selected="false" data-tab="files">Files</button><button role="tab" aria-selected="false" data-tab="terminal">Terminal</button>
        </div>
        <div class="evidence-toolbar"><span id="evidence-title">Run evidence</span><a id="evidence-json" href="/api/runs">View JSON</a></div>
        <div id="evidence-content" class="evidence-content"><div class="empty-state">Evidence will appear as agents complete work.</div></div>
        <div class="review-bar">
          <div><strong id="review-count">0 artifacts</strong><span id="review-status">Loading evidence</span></div>
          <button class="review-secondary" id="request-changes" type="button">Request changes</button>
          <form method="post" action="/api/follow-up" id="accept-form"><input type="hidden" name="returnTo" id="accept-return" value="/studio"><input type="hidden" name="action" value="feedback"><input type="hidden" name="rating" value="accepted"><input type="hidden" name="note" value="Accepted in Agent Workflow Studio"><input type="hidden" name="runId" id="accept-run"><button class="review-primary" type="submit">${icon("check")} Accept changes</button></form>
        </div>
      </aside>
    </main>
  </div>

  <dialog id="new-task-dialog">
    <form class="new-task-form" method="post" action="/api/studio-task">
      <input type="hidden" name="returnTo" value="/studio">
      <div class="dialog-heading"><div><h2>Start a task</h2><p>Describe the outcome. Agent Workflow handles the execution plan.</p></div><button type="button" class="dialog-close" aria-label="Close">×</button></div>
      <label>Project<select id="dialog-project" name="project"><option value="${escapeHtml(input.defaultProject)}">${escapeHtml(input.defaultProject)}</option></select><small>Choose an indexed project. New projects can still be onboarded from Projects.</small></label>
      <label>Routing<select id="dialog-routing" name="workflowId"><option value="auto" selected>Auto-route from my request</option>${workflowOptions}</select><small>Agent Workflow will choose the primary governed workflow. Select one manually only when you need an explicit override.</small></label>
      <label>What should change?<textarea id="dialog-task" name="task" rows="5" placeholder="Build, fix, review, or investigate…" required autofocus></textarea></label>
      <div id="routing-preview" class="routing-preview" hidden aria-live="polite"></div>
      <input type="hidden" id="plan-stages" name="planStages">
      <section id="plan-editor" class="plan-editor" hidden><header><strong>Execution plan</strong><span id="plan-summary"></span></header><div id="plan-stage-list"></div></section>
      <div class="dialog-actions"><button type="button" class="dialog-cancel">Cancel</button><button type="submit" class="dialog-start">${icon("play")} Start workflow</button></div>
    </form>
  </dialog>
  <script>${studioScript()}</script>
</body>
</html>`;
}

function studioScript(): string {
  return String.raw`
    (() => {
      const state = { runs: [], approvals: [], projects: [], details: null, workspace: null, plan: [], planMeta: null, tab: "changes", query: "", refreshTimer: null };
      const $ = (id) => document.getElementById(id);
      const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[char]);
      const short = (value, length = 78) => value && value.length > length ? value.slice(0, length - 1) + "…" : value || "Untitled task";
      const label = (value) => String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      const time = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "Pending";
      const statusClass = (value) => ["completed", "running", "failed", "queued"].includes(value) ? value : "queued";

      async function fetchJson(url) {
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      }

      function renderRuns() {
        const query = state.query.trim().toLowerCase();
        const visible = state.runs.filter((run) => !query || [run.task, run.projectName, run.workflowId, run.status].some((value) => String(value || "").toLowerCase().includes(query))).slice(0, 12);
        $("run-list").innerHTML = visible.map((run) => '<button class="run-row ' + (state.details?.run?.id === run.id ? 'selected' : '') + '" data-run="' + esc(run.id) + '"><span class="run-state ' + statusClass(run.status) + '"></span><span><strong>' + esc(short(run.task, 42)) + '</strong><small>' + esc(run.projectName) + ' · ' + esc(label(run.status)) + '</small></span></button>').join("") || '<div class="rail-loading">' + (query ? 'No tasks match “' + esc(state.query) + '”.' : 'No workflow runs yet.') + '</div>';
        document.querySelectorAll("[data-run]").forEach((button) => button.addEventListener("click", () => selectRun(button.dataset.run)));
      }

      function stageStatus(stage, index, tasks) {
        const status = stage.status || "queued";
        const completedBefore = tasks.slice(0, index).every((task) => task.status === "completed");
        return status === "completed" ? "completed" : status === "running" ? "running" : status === "failed" ? "failed" : completedBefore ? "queued" : "pending";
      }

      function renderTask() {
        const details = state.details;
        if (!details?.run) return renderEmpty();
        const run = details.run;
        const tasks = details.tasks || [];
        $("project-switcher").value = run.projectRootUri || $("project-switcher").value;
        $("run-crumb").textContent = run.id.slice(0, 8).toUpperCase();
        $("run-short").textContent = run.id.slice(0, 8).toUpperCase();
        $("task-status").textContent = label(run.status);
        $("task-status").className = "status-token " + statusClass(run.status);
        $("task-title").textContent = run.task || "Untitled task";
        $("task-summary").textContent = label(run.workflowId) + " · " + (run.projectRootUri || run.projectName);
        $("open-run").href = "/run?id=" + encodeURIComponent(run.id);
        $("evidence-json").href = "/api/run?id=" + encodeURIComponent(run.id);
        $("command-project").value = run.projectRootUri || "";
        $("command-workflow").value = run.workflowId || "build-feature";
        $("accept-run").value = run.id;
        $("command-return").value = "/studio?run=" + encodeURIComponent(run.id);
        $("accept-return").value = "/studio?run=" + encodeURIComponent(run.id);
        const runApprovals = state.approvals.filter((approval) => approval.runId === run.id);
        const approvalBanner = $("approval-banner");
        approvalBanner.hidden = runApprovals.length === 0;
        if (runApprovals.length) {
          $("approval-summary").textContent = runApprovals.length === 1
            ? label(runApprovals[0].actionType) + ": " + short(runApprovals[0].target || runApprovals[0].rationale, 92)
            : runApprovals.length + " actions are waiting for your decision.";
          $("inline-approval-actions").innerHTML = runApprovals.map((approval) => '<form method="post" action="/api/approval-action"><input type="hidden" name="returnTo" value="/studio?run=' + esc(run.id) + '"><input type="hidden" name="approvalId" value="' + esc(approval.id) + '"><input type="hidden" name="actorRole" value="operator"><button name="decision" value="approved">Approve</button><button name="decision" value="rejected">Reject</button></form>').join("");
        }

        $("stage-strip").innerHTML = tasks.map((task, index) => {
          const status = stageStatus(task, index, tasks);
          return '<div class="stage ' + status + '"><span class="stage-node">' + (status === "completed" ? '✓' : index + 1) + '</span><strong>' + esc(label(task.stageId)) + '</strong><small>' + esc(label(status)) + '</small></div>';
        }).join("") || '<div class="empty-state">The workflow has not created stage tasks yet.</div>';

        const stageArtifacts = new Map((details.artifacts || []).filter((artifact) => artifact.kind === "stage_output" && artifact.content?.stageId).map((artifact) => [artifact.content.stageId, artifact.content]));
        $("activity-feed").innerHTML = tasks.map((task, index) => {
          const status = stageStatus(task, index, tasks);
          const stageOutput = stageArtifacts.get(task.stageId);
          const output = task.error || stageOutput?.summary || task.output || task.executorSnapshot?.operation || (status === "running" ? "Working on this stage now…" : status === "completed" ? "Stage completed and evidence recorded." : "Waiting for the prior stage.");
          return '<article class="activity-item ' + status + '"><span class="activity-node">' + (status === "completed" ? '✓' : status === "failed" ? '!' : index + 1) + '</span><div><div class="activity-meta"><strong>' + esc(label(task.agentId)) + '</strong><time>' + esc(time(task.completedAt || task.startedAt || task.createdAt)) + '</time></div><p>' + esc(short(String(output), 220)) + '</p><a href="/run?id=' + encodeURIComponent(run.id) + '">' + esc(label(task.stageId)) + ' evidence <span>›</span></a></div></article>';
        }).join("") || '<div class="empty-state">No agent activity has been recorded yet.</div>';
        loadWorkspace(run.projectRootUri);
        renderEvidence();
        renderRuns();
      }

      function artifactBody(artifact) {
        const content = artifact?.content;
        if (typeof content === "string") return content;
        if (artifact?.kind === "command_output" && content) {
          const result = content.exitCode === 0 ? "passed" : "failed";
          return "$ " + (content.commandLine || "command") + "\n" + result + " · exit " + content.exitCode + " · " + (content.durationMs || 0) + "ms\n\n" + (content.stdout || content.stderr || "No command output.");
        }
        if (artifact?.kind === "file_write" && content) {
          return ["file: " + (content.relativePath || "unknown"), "bytes: " + (content.bytesWritten || 0), "previous: " + (content.previousHash || "new file"), "current: " + (content.nextHash || "unknown")].join("\n");
        }
        if (artifact?.kind === "stage_output" && content) {
          const findings = Array.isArray(content.findings) ? content.findings.map((item) => "• " + item).join("\n") : "";
          return [content.summary, findings, content.nextAction ? "\nNext: " + content.nextAction : ""].filter(Boolean).join("\n\n");
        }
        return JSON.stringify(content ?? {}, null, 2);
      }

      function stageOutputFor(task, artifacts) {
        const artifact = artifacts.find((item) => item.kind === "stage_output" && item.content?.stageId === task.stageId);
        return artifact?.content?.summary || "";
      }

      function codeBlock(title, body, tone = "neutral") {
        const lines = String(body || "No evidence recorded yet.").split("\n").slice(0, 180);
        return '<section class="evidence-block"><header><span class="file-glyph">&lt;/&gt;</span><strong>' + esc(title) + '</strong></header><pre class="evidence-code">' + lines.map((line, index) => '<span class="code-line ' + tone + '"><i>' + (index + 1) + '</i><code>' + esc(line) + '</code></span>').join("") + '</pre></section>';
      }

      function renderEvidence() {
        const details = state.details || {};
        const artifacts = details.artifacts || [];
        const receipts = details.receipts || [];
        const tasks = details.tasks || [];
        let html = "";
        if (state.tab === "changes") {
          const changed = artifacts.filter((item) => item.kind === "file_write");
          html = changed.map((item) => codeBlock(item.content?.relativePath || item.uri || "File write", artifactBody(item), "change")).join("");
          $("evidence-title").textContent = changed.length ? "Recorded changes" : "No files changed";
        } else if (state.tab === "tests") {
          const tests = tasks.filter((item) => /test|verify|validation|check/i.test((item.stageId || "") + " " + (item.agentId || "")));
          const commands = artifacts.filter((item) => item.kind === "command_output" && /test|lint|build|check|verify/i.test(item.content?.commandLine || ""));
          html = commands.map((item) => codeBlock(item.content?.commandLine || "Verification command", artifactBody(item), item.content?.exitCode === 0 ? "success" : "failure")).join("") || tests.map((item) => codeBlock(label(item.stageId) + " · " + label(item.status), item.error || stageOutputFor(item, artifacts) || "Verification task recorded without inline output.", item.status === "failed" ? "failure" : "success")).join("");
          $("evidence-title").textContent = "Verification evidence";
        } else if (state.tab === "artifacts") {
          html = artifacts.map((item) => codeBlock((item.kind ? label(item.kind) + " · " : "") + (item.uri || "Artifact"), artifactBody(item))).join("");
          $("evidence-title").textContent = "Workflow artifacts";
        } else if (state.tab === "receipts") {
          html = receipts.map((item) => '<article class="receipt-row"><span class="receipt-icon">✓</span><div><strong>' + esc(label(item.actionType || "Action")) + '</strong><p>' + esc(item.summary || "Receipt recorded") + '</p><small>' + esc(item.agentId || "workflow") + '</small></div></article>').join("");
          $("evidence-title").textContent = "Audit receipts";
        } else if (state.tab === "files") {
          const workspace = state.workspace;
          html = workspace ? '<div class="file-browser">' + workspace.files.map((item) => '<button type="button" data-file="' + esc(item.kind === "file" ? item.name : "") + '"><span>' + (item.kind === "directory" ? "▸" : "·") + '</span>' + esc(item.name) + '</button>').join("") + '</div>' + (workspace.file ? codeBlock(workspace.file.path, workspace.file.content) : '<div class="empty-state evidence-empty">Select a top-level file to inspect it.</div>') : '<div class="empty-state">Loading project files…</div>';
          $("evidence-title").textContent = "Project files";
        } else {
          const commands = artifacts.filter((item) => item.kind === "command_output");
          html = commands.map((item) => codeBlock(item.content?.commandLine || "Command", artifactBody(item), item.content?.exitCode === 0 ? "success" : "failure")).join("");
          $("evidence-title").textContent = "Run terminal";
        }
        $("evidence-content").innerHTML = html || '<div class="empty-state evidence-empty">No ' + esc(state.tab) + ' evidence has been recorded for this run yet.</div>';
        document.querySelectorAll("[data-file]").forEach((button) => button.addEventListener("click", () => button.dataset.file && loadWorkspace(state.details?.run?.projectRootUri, button.dataset.file)));
        const changedFiles = artifacts.filter((item) => item.kind === "file_write").length;
        $("review-count").textContent = changedFiles + " changed file" + (changedFiles === 1 ? "" : "s");
        $("review-status").textContent = receipts.length + " governed action" + (receipts.length === 1 ? "" : "s") + " recorded";
      }

      function renderEmpty() {
        $("run-short").textContent = "READY";
        $("task-status").textContent = "No active run";
        $("task-title").textContent = "Start the next piece of work";
        $("task-summary").textContent = "Describe an outcome and Agent Workflow will create a governed execution plan.";
        $("stage-strip").innerHTML = "";
        $("activity-feed").innerHTML = '<button class="empty-action" type="button">Start a task</button>';
        document.querySelector(".empty-action")?.addEventListener("click", openDialog);
        renderEvidence();
      }

      async function selectRun(runId) {
        history.replaceState(null, "", "/studio?run=" + encodeURIComponent(runId));
        $("task-workspace").classList.add("is-loading");
        try {
          state.details = await fetchJson("/api/run?id=" + encodeURIComponent(runId));
          renderTask();
        } catch (error) {
          $("activity-feed").innerHTML = '<div class="error-state">Could not load this run. ' + esc(error.message) + '</div>';
        } finally {
          $("task-workspace").classList.remove("is-loading");
        }
      }

      async function loadWorkspace(project, file = "") {
        if (!project) return;
        try {
          state.workspace = await fetchJson("/api/studio-workspace?project=" + encodeURIComponent(project) + (file ? "&file=" + encodeURIComponent(file) : ""));
          if (state.tab === "changes" && state.workspace.diff) {
            const content = $("evidence-content");
            content.innerHTML = codeBlock("git diff", state.workspace.diff, "change") + content.innerHTML;
            $("evidence-title").textContent = "Working tree diff";
          } else if (state.tab === "files") renderEvidence();
        } catch (_) { state.workspace = null; }
      }

      async function runAction(action) {
        const run = state.details?.run;
        if (!run) return;
        const response = await fetch("/api/studio-run-action", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ action, runId: run.id, project: run.projectRootUri || "" }) });
        if (!response.ok) throw new Error(await response.text());
        await refresh(false);
      }

      async function refresh(selectInitial = true) {
        try {
          const [runs, approvals, projects] = await Promise.all([fetchJson("/api/runs"), fetchJson("/api/approvals?status=open"), fetchJson("/api/projects")]);
          state.runs = runs;
          state.approvals = approvals;
          state.projects = projects;
          const options = projects.map((project) => '<option value="' + esc(project.rootUri || project.projectRootUri) + '">' + esc(project.name || project.projectName || project.rootUri || project.projectRootUri) + '</option>').join("");
          if (options) { $("project-switcher").innerHTML = options; $("dialog-project").innerHTML = options; }
          if (approvals.length) { $("approval-count").hidden = false; $("approval-count").textContent = approvals.length; }
          const params = new URLSearchParams(location.search);
          const requested = params.get("run") || params.get("actionRun");
          const notice = params.get("notice") || params.get("error");
          if (notice) { $("studio-notice").hidden = false; $("studio-notice").classList.toggle("error", params.has("error")); $("studio-notice").textContent = notice; }
          const initial = (selectInitial ? runs.find((run) => run.id === requested) : runs.find((run) => run.id === state.details?.run?.id)) || runs.find((run) => run.status === "running" || run.status === "queued") || runs[0];
          if (initial) await selectRun(initial.id); else { renderRuns(); renderEmpty(); }
        } catch (error) {
          $("task-title").textContent = "Studio could not connect";
          $("task-summary").textContent = error.message;
          $("activity-feed").innerHTML = '<div class="error-state">Check the local dashboard runtime and reload this page.</div>';
        }
      }
      const load = refresh;

      function openDialog() { $("new-task-dialog").showModal(); }
      let routeTimer;
      async function previewRoute() {
        const task = $("dialog-task").value.trim();
        const routing = $("dialog-routing").value;
        const preview = $("routing-preview");
        if (routing !== "auto" || task.length < 8) { preview.hidden = true; state.planMeta = null; return; }
        preview.hidden = false;
        preview.innerHTML = '<span class="routing-pulse"></span><span><strong>Finding the right workflow…</strong><small>Using the local orchestration contract.</small></span>';
        try {
          const route = await fetchJson("/api/studio-route?project=" + encodeURIComponent($("dialog-project").value) + "&task=" + encodeURIComponent(task));
          state.plan = route.stages || [];
          state.planMeta = route;
          const budget = route.latencyBudgetMs ? Math.round(route.latencyBudgetMs / 1000) + "s budget" : "";
          const ratio = route.targetDirectRatio ? "target ≤" + route.targetDirectRatio + "× direct" : "";
          const profile = [label(route.executionProfile), label(route.complexity), budget, ratio].filter(Boolean).join(" · ");
          preview.innerHTML = '<span class="routing-mark">→</span><span><strong>' + esc(label(route.archetype) + " · " + state.plan.length + " stages") + '</strong><small class="routing-metrics">' + esc(profile) + '</small><small>' + esc((route.constructionRationale || []).slice(1, 3).join(" ") || route.reason) + '</small></span>';
          renderPlan();
        } catch (error) {
          preview.innerHTML = '<span class="routing-mark">!</span><span><strong>Could not preview routing</strong><small>' + esc(error.message) + '</small></span>';
        }
      }
      function renderPlan() {
        $("plan-editor").hidden = !state.plan.length || $("dialog-routing").value !== "auto";
        const parallel = state.plan.filter((stage) => stage.parallelGroup).length;
        $("plan-summary").textContent = state.plan.length + " agents" + (parallel ? " · " + parallel + " parallel" : "") + " · editable";
        $("plan-stages").value = state.plan.map((stage) => stage.id).join(",");
        $("plan-stage-list").innerHTML = state.plan.map((stage, index) => '<article class="plan-stage"><span>' + (index + 1) + '</span><div><strong>' + esc(label(stage.id)) + '</strong><small>' + esc(label(stage.agent)) + ' · ' + esc(stage.modelTier) + ' · ' + stage.contextTokens + ' tokens' + (stage.approvalRequired ? ' · approval' : '') + '</small></div><button type="button" data-plan-up="' + index + '">↑</button><button type="button" data-plan-down="' + index + '">↓</button><button type="button" data-plan-remove="' + index + '" ' + (stage.removable ? '' : 'disabled') + '>×</button></article>').join("");
        document.querySelectorAll("[data-plan-up]").forEach((button) => button.onclick = () => movePlan(Number(button.dataset.planUp), -1));
        document.querySelectorAll("[data-plan-down]").forEach((button) => button.onclick = () => movePlan(Number(button.dataset.planDown), 1));
        document.querySelectorAll("[data-plan-remove]").forEach((button) => button.onclick = () => { state.plan.splice(Number(button.dataset.planRemove), 1); renderPlan(); });
      }
      function movePlan(index, direction) { const next = index + direction; if (next < 0 || next >= state.plan.length) return; [state.plan[index], state.plan[next]] = [state.plan[next], state.plan[index]]; renderPlan(); }
      $("new-task").addEventListener("click", openDialog);
      $("new-task-compact").addEventListener("click", openDialog);
      document.querySelector(".dialog-close").addEventListener("click", () => $("new-task-dialog").close());
      document.querySelector(".dialog-cancel").addEventListener("click", () => $("new-task-dialog").close());
      $("dialog-task").addEventListener("input", () => { clearTimeout(routeTimer); routeTimer = setTimeout(previewRoute, 280); });
      $("dialog-routing").addEventListener("change", previewRoute);
      $("dialog-project").addEventListener("change", previewRoute);
      $("project-switcher").addEventListener("change", (event) => { const run = state.runs.find((item) => item.projectRootUri === event.target.value); if (run) selectRun(run.id); else { $("dialog-project").value = event.target.value; openDialog(); } });
      document.querySelectorAll("[data-run-action]").forEach((button) => button.addEventListener("click", async () => { try { await runAction(button.dataset.runAction); } catch (error) { $("studio-notice").hidden = false; $("studio-notice").classList.add("error"); $("studio-notice").textContent = error.message; } }));
      $("request-changes").addEventListener("click", () => { $("command-task").focus(); $("command-task").value = "Revise this work: "; });
      $("task-search").addEventListener("input", (event) => { state.query = event.target.value; renderRuns(); });
      document.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("task-search").focus(); $("task-search").select(); }
        if (event.key === "Escape" && document.activeElement === $("task-search")) { $("task-search").value = ""; state.query = ""; renderRuns(); $("task-search").blur(); }
      });
      document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
        state.tab = button.dataset.tab;
        document.querySelectorAll("[data-tab]").forEach((tab) => { tab.classList.toggle("active", tab === button); tab.setAttribute("aria-selected", String(tab === button)); });
        renderEvidence();
      }));
      load();
      if (window.EventSource) { const events = new EventSource("/api/studio-events"); events.addEventListener("refresh", () => { clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(() => refresh(false), 180); }); }
      else setInterval(() => refresh(false), 5000);
    })();
  `;
}

function studioCss(): string {
  return `
    :root { color-scheme: dark; --bg: #0b0e10; --rail: #101417; --surface: #12171a; --surface-2: #171d21; --line: #293136; --line-soft: #20272b; --text: #f1f3ef; --muted: #89939a; --faint: #626c73; --lime: #84f06c; --amber: #f2b84b; --red: #f06b6b; --top: 52px; --rail-width: 234px; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-width: 320px; min-height: 100%; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select, textarea { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    button:focus-visible, a:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--lime); outline-offset: 2px; }
    .studio-icon { width: 17px; height: 17px; flex: 0 0 auto; }
    .studio-shell { min-height: 100vh; }
    .studio-topbar { position: fixed; inset: 0 0 auto 0; z-index: 20; height: var(--top); display: grid; grid-template-columns: var(--rail-width) minmax(0, 1fr) 242px auto; align-items: center; border-bottom: 1px solid var(--line); background: rgba(11,14,16,.97); }
    .studio-brand { height: 100%; display: flex; align-items: center; gap: 11px; padding: 0 18px; color: var(--text); text-decoration: none; border-right: 1px solid var(--line); }
    .studio-brand strong { font-size: 14px; letter-spacing: -.015em; white-space: nowrap; }
    .brand-mark { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid #b7c0c5; border-radius: 3px; font: 700 10px/1 ui-monospace, monospace; }
    .studio-crumbs { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 0 24px; color: var(--muted); font-size: 12px; }
    .studio-crumbs b { overflow: hidden; color: #c8ceca; text-overflow: ellipsis; white-space: nowrap; }
    .studio-crumbs select { max-width: 190px; border: 0; background: transparent; color: #c8ceca; font-size: 12px; }
    .studio-search { height: 32px; display: flex; align-items: center; gap: 8px; color: var(--muted); border: 1px solid var(--line); padding: 0 9px; font-size: 12px; }
    .studio-search:focus-within { border-color: #65737b; }
    .studio-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 11px; }
    .studio-search input::placeholder { color: var(--muted); }
    .studio-search input::-webkit-search-cancel-button { filter: invert(1); opacity: .5; }
    .studio-search kbd { color: var(--faint); font: 11px ui-monospace, monospace; }
    .topbar-link { margin: 0 16px; color: var(--muted); font-size: 12px; text-decoration: none; }
    .topbar-link:hover { color: var(--text); }
    .studio-rail { position: fixed; inset: var(--top) auto 0 0; z-index: 10; width: var(--rail-width); display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--rail); padding: 20px 10px 12px; }
    .studio-rail nav { display: grid; gap: 3px; }
    .rail-link { min-height: 39px; display: flex; align-items: center; gap: 11px; padding: 0 12px; border-left: 2px solid transparent; color: #aab2b7; font-size: 13px; text-decoration: none; }
    .rail-link:hover, .rail-link.active { background: #1a2024; color: var(--text); }
    .rail-link.active { border-left-color: var(--lime); }
    .rail-link i { margin-left: auto; min-width: 19px; padding: 2px 5px; border: 1px solid #8b682e; color: var(--amber); font: normal 10px ui-monospace, monospace; text-align: center; }
    .rail-section { min-height: 0; margin-top: 28px; display: flex; flex: 1; flex-direction: column; }
    .rail-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 9px; color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .rail-heading button { display: grid; place-items: center; border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 3px; }
    .rail-heading .studio-icon { width: 14px; height: 14px; }
    .run-list { overflow-y: auto; }
    .run-row { width: 100%; min-height: 55px; display: grid; grid-template-columns: 8px minmax(0,1fr); gap: 9px; align-items: start; padding: 9px 10px; border: 0; border-left: 2px solid transparent; background: transparent; color: var(--text); text-align: left; cursor: pointer; }
    .run-row:hover, .run-row.selected { background: #181e22; }
    .run-row.selected { border-left-color: #4b575e; }
    .run-row strong, .run-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-row strong { font-size: 11px; line-height: 1.4; font-weight: 600; }
    .run-row small { margin-top: 3px; color: var(--faint); font-size: 10px; }
    .run-state { width: 6px; height: 6px; margin-top: 5px; border-radius: 50%; background: #657078; }
    .run-state.running { background: var(--lime); box-shadow: 0 0 0 3px rgba(132,240,108,.08); }
    .run-state.completed { background: #5a9f58; }
    .run-state.failed { background: var(--red); }
    .run-state.queued { border: 1px solid #9ba5ab; background: transparent; }
    .rail-loading { padding: 18px 10px; color: var(--faint); font-size: 11px; line-height: 1.5; }
    .new-task-button { min-height: 38px; display: flex; justify-content: center; align-items: center; gap: 8px; border: 1px solid #3a454b; background: #181e22; color: var(--text); font-size: 12px; font-weight: 650; cursor: pointer; }
    .new-task-button:hover { border-color: #58666e; background: #1d2529; }
    .rail-footer { display: grid; grid-template-columns: 8px 1fr auto; gap: 7px; align-items: center; padding: 15px 8px 2px; color: var(--muted); font-size: 10px; }
    .rail-footer b { color: #69756f; font-weight: 500; }
    .health-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--lime); }
    .task-workspace { min-height: 100vh; margin-left: var(--rail-width); padding-top: var(--top); display: grid; grid-template-columns: minmax(440px, 54%) minmax(420px, 46%); opacity: 1; transition: opacity .15s ease; }
    .task-workspace.is-loading { opacity: .7; }
    .task-pane { min-width: 0; height: calc(100vh - var(--top)); display: grid; grid-template-rows: minmax(0,1fr) auto; border-right: 1px solid var(--line); }
    .task-scroll { min-height: 0; overflow: auto; padding: 27px 26px 22px; }
    .studio-notice { margin: 0 0 14px; border-left: 2px solid var(--lime); background: rgba(132,240,108,.08); padding: 9px 11px; color: #bdeab5; font-size: 10px; }
    .studio-notice.error { border-left-color: var(--red); background: rgba(240,107,107,.08); color: #efaaaa; }
    .task-kicker { display: flex; align-items: center; gap: 8px; color: var(--muted); font: 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .task-kicker > span:first-child { border: 1px solid #3c474d; padding: 4px 6px; }
    .status-token { border: 1px solid #465158; padding: 4px 7px; color: #b2bbc0; }
    .status-token.running { border-color: #54844c; color: var(--lime); }
    .status-token.completed { border-color: #426a43; color: #8ed486; }
    .status-token.failed { border-color: #804747; color: #f28b8b; }
    .approval-banner { margin: 14px 0 0; min-height: 48px; display: grid; grid-template-columns: 18px minmax(0,1fr) auto; gap: 10px; align-items: center; border: 1px solid #7c612f; border-left: 2px solid var(--amber); background: rgba(242,184,75,.07); padding: 8px 10px; color: var(--amber); }
    .approval-banner[hidden] { display: none; }
    .approval-banner > span strong, .approval-banner > span small { display: block; }
    .approval-banner > span strong { font-size: 10px; }
    .approval-banner > span small { margin-top: 3px; overflow: hidden; color: #b5a47f; font: 9px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .approval-banner > .studio-icon:last-child { width: 12px; }
    #inline-approval-actions form { display: flex; gap: 5px; }
    #inline-approval-actions button { border: 1px solid #8b682e; background: transparent; color: var(--amber); padding: 5px 8px; font-size: 9px; cursor: pointer; }
    .task-scroll h1 { max-width: 720px; margin: 18px 0 8px; display: -webkit-box; overflow: hidden; font-size: clamp(24px, 2.4vw, 36px); line-height: 1.12; letter-spacing: -.035em; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
    .task-summary { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .stage-strip { margin: 30px 0 31px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(92px,1fr); overflow-x: auto; }
    .stage { position: relative; min-width: 0; display: grid; gap: 5px; padding-right: 8px; }
    .stage::before { content: ""; position: absolute; top: 11px; left: 24px; right: 0; height: 1px; background: #384148; }
    .stage:last-child::before { display: none; }
    .stage.completed::before { background: #5f9f57; }
    .stage-node { position: relative; z-index: 1; width: 23px; height: 23px; display: grid; place-items: center; border: 1px solid #59656c; border-radius: 50%; background: var(--bg); color: #879198; font: 10px ui-monospace, monospace; }
    .stage.completed .stage-node { border-color: var(--lime); background: var(--lime); color: #10200d; font-weight: 800; }
    .stage.running .stage-node { border: 2px solid var(--lime); box-shadow: inset 0 0 0 4px var(--bg); background: var(--lime); color: transparent; }
    .stage.failed .stage-node { border-color: var(--red); color: var(--red); }
    .stage strong { overflow: hidden; padding-top: 3px; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .stage small { color: var(--faint); font-size: 10px; }
    .stage.running small { color: var(--lime); }
    .activity-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 11px; border-bottom: 1px solid var(--line); }
    .run-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin: -16px 0 24px; }
    .run-toolbar button { border: 1px solid #39444a; background: #151b1e; color: #aeb6ba; padding: 6px 9px; font-size: 9px; cursor: pointer; }
    .run-toolbar button:hover { border-color: var(--lime); color: var(--text); }
    .activity-header h2 { margin: 0; font-size: 12px; }
    .activity-header a { display: flex; align-items: center; gap: 3px; color: var(--muted); font-size: 10px; text-decoration: none; }
    .activity-header .studio-icon { width: 12px; }
    .activity-feed { padding-top: 4px; }
    .activity-item { position: relative; display: grid; grid-template-columns: 24px 1fr; gap: 13px; padding: 16px 0; }
    .activity-item:not(:last-child)::before { content: ""; position: absolute; left: 11px; top: 38px; bottom: -4px; width: 1px; background: #323b40; }
    .activity-item.completed:not(:last-child)::before { background: #52794d; }
    .activity-node { position: relative; z-index: 1; width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid #59656c; border-radius: 50%; background: var(--bg); color: #7f8a90; font: 10px ui-monospace, monospace; }
    .activity-item.completed .activity-node { border-color: var(--lime); background: var(--lime); color: #10200d; font-weight: 800; }
    .activity-item.running .activity-node { border-color: var(--lime); color: var(--lime); }
    .activity-item.failed .activity-node { border-color: var(--red); color: var(--red); }
    .activity-meta { display: flex; align-items: baseline; gap: 10px; }
    .activity-meta strong { font-size: 11px; }
    .activity-meta time { color: var(--faint); font: 9px ui-monospace, monospace; }
    .activity-item p { max-width: 700px; margin: 5px 0 8px; color: #adb5ba; font-size: 11px; line-height: 1.55; white-space: pre-wrap; }
    .activity-item a { color: #8d979d; font: 10px ui-monospace, monospace; text-decoration: none; }
    .activity-item a:hover { color: var(--lime); }
    .command-composer { border-top: 1px solid var(--line); background: #0f1315; padding: 10px 22px 12px; }
    .command-composer > label { display: block; margin: 0 0 7px 2px; color: #c4cbc7; font-size: 10px; font-weight: 650; }
    .command-field { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; border: 1px solid #465158; background: #12171a; padding: 7px 8px 7px 12px; }
    .command-field > .studio-icon { width: 13px; color: var(--muted); }
    .command-field textarea { width: 100%; min-height: 36px; resize: none; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 11px; line-height: 1.5; }
    .command-field textarea::placeholder { color: #667178; }
    .command-field button { width: 34px; height: 34px; display: grid; place-items: center; border: 0; background: var(--lime); color: #10200d; cursor: pointer; }
    .command-field button:hover { background: #a0f58e; }
    .command-composer > p { margin: 6px 2px 0; color: var(--faint); font-size: 9px; }
    .evidence-pane { min-width: 0; height: calc(100vh - var(--top)); display: grid; grid-template-rows: 53px 48px minmax(0,1fr) 66px; background: #0e1214; }
    .evidence-tabs { display: flex; align-items: end; gap: 20px; overflow-x: auto; border-bottom: 1px solid var(--line); padding: 0 17px; }
    .evidence-tabs button { position: relative; height: 100%; border: 0; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; }
    .evidence-tabs button.active { color: var(--text); }
    .evidence-tabs button.active::after { content: ""; position: absolute; inset: auto 0 -1px 0; height: 2px; background: var(--lime); }
    .evidence-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 0 14px; color: #c7cdca; font: 10px ui-monospace, monospace; }
    .evidence-toolbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .evidence-toolbar a { flex: 0 0 auto; border: 1px solid #3e494f; padding: 6px 8px; color: #adb5ba; text-decoration: none; }
    .evidence-toolbar a:hover { color: var(--text); border-color: #68747b; }
    .evidence-content { min-height: 0; overflow: auto; }
    .evidence-block { border-bottom: 1px solid var(--line); }
    .evidence-block header { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: #151a1d; color: #cbd1cd; font: 10px ui-monospace, monospace; }
    .evidence-block header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-glyph { color: var(--lime); }
    .evidence-code { margin: 0; padding: 8px 0; overflow: visible; background: #0d1113; color: #b6bec3; font: 10px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .code-line { min-height: 16px; display: grid; grid-template-columns: 39px minmax(0,1fr); padding-right: 12px; }
    .code-line i { padding-right: 9px; border-right: 1px solid #242b2f; color: #525d64; font-style: normal; text-align: right; user-select: none; }
    .code-line code { padding-left: 11px; font: inherit; }
    .code-line.change:nth-child(7n+2) { border-left: 2px solid #3c7540; background: rgba(71,129,72,.16); }
    .code-line.success { border-left: 2px solid #3c7540; }
    .code-line.failure { border-left: 2px solid #8b4545; background: rgba(128,55,55,.12); }
    .receipt-row { display: grid; grid-template-columns: 24px 1fr; gap: 11px; padding: 14px; border-bottom: 1px solid var(--line-soft); }
    .receipt-icon { width: 21px; height: 21px; display: grid; place-items: center; border: 1px solid #4f7c4c; border-radius: 50%; color: var(--lime); font-size: 10px; }
    .receipt-row strong { font-size: 11px; }
    .receipt-row p { margin: 4px 0; color: #a7b0b5; font-size: 10px; line-height: 1.45; }
    .receipt-row small { color: var(--faint); font: 9px ui-monospace, monospace; }
    .file-browser { display: grid; grid-template-columns: repeat(auto-fill,minmax(145px,1fr)); gap: 1px; padding: 1px; background: var(--line); }
    .file-browser button { display: flex; gap: 8px; min-width: 0; border: 0; background: #121719; color: #abb4b8; padding: 9px; font: 10px ui-monospace, monospace; text-align: left; cursor: pointer; overflow: hidden; }
    .file-browser button:hover { background: #1a2226; color: var(--lime); }
    .review-bar { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 9px; align-items: center; border-top: 1px solid var(--line); padding: 10px 12px; background: #121719; }
    .review-bar > div strong, .review-bar > div span { display: block; }
    .review-bar > div strong { font-size: 10px; }
    .review-bar > div span { margin-top: 3px; color: var(--faint); font-size: 9px; }
    .review-bar form { margin: 0; }
    .review-bar button { min-height: 35px; border: 1px solid #3d484e; padding: 0 12px; font-size: 10px; font-weight: 650; cursor: pointer; }
    .review-secondary { background: #171d20; color: var(--text); }
    .review-primary { display: flex; align-items: center; gap: 7px; border-color: var(--lime) !important; background: var(--lime); color: #10200d; }
    .review-primary:hover { background: #a0f58e; }
    .empty-state, .error-state { padding: 38px 22px; color: var(--faint); font-size: 11px; line-height: 1.5; }
    .error-state { color: #e18b8b; }
    .evidence-empty { min-height: 180px; display: grid; place-items: center; text-align: center; }
    .empty-action { border: 1px solid var(--lime); background: transparent; color: var(--lime); padding: 9px 12px; cursor: pointer; }
    dialog { width: min(560px, calc(100vw - 28px)); padding: 0; border: 1px solid #47535a; background: #121719; color: var(--text); box-shadow: 0 28px 90px rgba(0,0,0,.58); }
    dialog::backdrop { background: rgba(0,0,0,.72); }
    .new-task-form { display: grid; gap: 16px; padding: 22px; }
    .dialog-heading { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
    .dialog-heading h2 { margin: 0 0 5px; font-size: 18px; }
    .dialog-heading p { margin: 0; color: var(--muted); font-size: 11px; }
    .dialog-close { width: 30px; height: 30px; border: 0; background: transparent; color: var(--muted); font-size: 22px; cursor: pointer; }
    .new-task-form > label { display: grid; gap: 7px; color: #b8c0c4; font-size: 10px; font-weight: 650; }
    .new-task-form > label small { color: var(--faint); font-size: 9px; font-weight: 400; line-height: 1.45; }
    .new-task-form input, .new-task-form select, .new-task-form textarea { width: 100%; border: 1px solid #3f4a50; border-radius: 0; background: #0e1214; color: var(--text); padding: 10px 11px; font-size: 12px; }
    .new-task-form textarea { resize: vertical; line-height: 1.5; }
    .routing-preview { display: grid; grid-template-columns: 24px minmax(0,1fr); gap: 10px; align-items: start; border-left: 2px solid var(--lime); background: rgba(132,240,108,.06); padding: 10px 11px; }
    .routing-preview[hidden] { display: none; }
    .routing-preview strong, .routing-preview small { display: block; }
    .routing-preview strong { color: #cceec5; font-size: 10px; }
    .routing-preview small { margin-top: 4px; color: #839087; font-size: 9px; line-height: 1.4; }
    .routing-preview .routing-metrics { color: var(--lime); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .routing-mark { color: var(--lime); font: 16px ui-monospace, monospace; }
    .routing-pulse { width: 8px; height: 8px; margin: 4px; border-radius: 50%; background: var(--lime); animation: routing-pulse 1s ease-in-out infinite alternate; }
    .plan-editor { max-height: 280px; overflow: auto; border: 1px solid var(--line); }
    .plan-editor > header { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; background: #171d20; padding: 9px 10px; font-size: 10px; }
    .plan-editor > header span { color: var(--faint); }
    .plan-stage { display: grid; grid-template-columns: 22px minmax(0,1fr) 25px 25px 25px; gap: 5px; align-items: center; border-top: 1px solid var(--line-soft); padding: 7px 8px; }
    .plan-stage > span { color: var(--lime); font: 10px ui-monospace, monospace; }
    .plan-stage strong, .plan-stage small { display: block; }
    .plan-stage strong { font-size: 10px; }
    .plan-stage small { margin-top: 3px; color: var(--faint); font-size: 8px; }
    .plan-stage button { height: 24px; border: 1px solid #39444a; background: transparent; color: #9ba5aa; cursor: pointer; }
    .plan-stage button:disabled { opacity: .25; cursor: not-allowed; }
    @keyframes routing-pulse { to { opacity: .35; transform: scale(.75); } }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
    .dialog-actions button { min-height: 37px; padding: 0 13px; border: 1px solid #465158; cursor: pointer; font-size: 11px; font-weight: 650; }
    .dialog-cancel { background: transparent; color: #b7c0c5; }
    .dialog-start { display: flex; align-items: center; gap: 7px; border-color: var(--lime) !important; background: var(--lime); color: #10200d; }
    @media (max-width: 1050px) {
      :root { --rail-width: 192px; }
      .studio-topbar { grid-template-columns: var(--rail-width) 1fr auto; }
      .studio-search { display: none; }
      .task-workspace { grid-template-columns: 1fr; }
      .task-pane { height: auto; min-height: calc(100vh - var(--top)); border-right: 0; }
      .evidence-pane { height: 72vh; border-top: 1px solid var(--line); }
    }
    @media (max-width: 700px) {
      :root { --rail-width: 0px; }
      .studio-topbar { grid-template-columns: 1fr auto; }
      .studio-brand { border-right: 0; }
      .studio-crumbs { display: none; }
      .studio-rail { position: static; width: 100%; padding: calc(var(--top) + 8px) 10px 8px; border-right: 0; border-bottom: 1px solid var(--line); }
      .studio-rail nav { grid-template-columns: repeat(4,1fr); }
      .rail-link { justify-content: center; padding: 0 6px; border-left: 0; border-bottom: 2px solid transparent; }
      .rail-link.active { border-bottom-color: var(--lime); }
      .rail-link span { display: none; }
      .rail-section, .new-task-button, .rail-footer { display: none; }
      .task-workspace { margin-left: 0; padding-top: 0; }
      .task-scroll { padding: 24px 17px; }
      .stage-strip { overflow-x: auto; grid-template-columns: repeat(4, minmax(100px,1fr)); }
      .evidence-tabs { gap: 17px; overflow-x: auto; }
      .review-bar { grid-template-columns: 1fr 1fr; }
      .review-bar > div { grid-column: 1 / -1; }
      .review-bar button { width: 100%; }
      .command-composer { padding-inline: 12px; }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  `;
}

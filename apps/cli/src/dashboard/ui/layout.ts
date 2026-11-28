import { formatDashboardDateTimeText } from "../../lib/builders-runs.js";
import { type DashboardIconName, dashboardIcon } from "../icons.js";
import { serializeInlineScriptJson } from "../security.js";
import { dashboardCss } from "../styles.js";
import { themeBootstrapScript } from "../dark-theme.js";
import escapeHtmlText from "escape-html";
import { deploymentStatusWidget } from '../deployment-status.js';

export function dashboardNav(active: "dashboard" | "studio" | "queue" | "approvals" | "approval-rules" | "projects" | "agents" | "discovery" | "runs" | "activity" | "evaluations" | "workflow-graph" | "learning" | "learning-diagnostics" | "daemon-control" | "training-proposals" | "feedback-inbox" | "model-improvement" | "candidate-comparisons" | "context-gateway" | "roadmap" | "governance" | "roles" | "artifact-lifecycle" | "backup-report" | "server-readiness" | "fleet-model-usage" | "bundles" | "providers" | "model-catalog" | "info"): string {
  // Five everyday pages stay at the top; every other page stays reachable under "More".
  const primary = [
    ["dashboard", "/", "Home", "grid"],
    ["queue", "/queue", "Queue", "list"],
    ["approvals", "/approvals", "Approvals", "shield"],
    ["runs", "/runs", "Runs", "activity"],
    ["projects", "/projects", "Projects", "file"]
  ] as const satisfies ReadonlyArray<readonly [Parameters<typeof dashboardNav>[0], string, string, DashboardIconName]>;
  const groups = [
    { label: "Work", items: [["activity", "/activity", "Activity"]] },
    { label: "Projects", items: [["agents", "/agents", "Agents"], ["discovery", "/discovery", "Discovery"], ["workflow-graph", "/workflow-graph", "Graph"], ["artifact-lifecycle", "/artifact-lifecycle", "Artifacts"]] },
    { label: "Learning", items: [["learning", "/learning", "Learning overview"], ["learning-diagnostics", "/learning?view=diagnostics", "Diagnostics"], ["daemon-control", "/learning?view=settings", "Daemon settings"], ["training-proposals", "/training-proposals", "Training proposals"], ["evaluations", "/evaluations", "Evaluations"], ["feedback-inbox", "/feedback-inbox", "Feedback"], ["model-improvement", "/model-improvement", "Model improvements"], ["candidate-comparisons", "/candidate-comparisons", "Comparisons"], ["context-gateway", "/context-gateway", "Context efficiency"], ["roadmap", "/roadmap", "Roadmap"]] },
    { label: "Settings", items: [["info", "/settings", "Settings"], ["governance", "/governance", "Governance"], ["approval-rules", "/approval-rules", "Trusted commands"], ["roles", "/roles", "Roles"], ["backup-report", "/backup-report", "Backup"], ["server-readiness", "/server-readiness", "System readiness"], ["fleet-model-usage", "/fleet-model-usage", "Fleet model usage"], ["bundles", "/bundles", "Workflow bundles"], ["providers", "/providers", "Providers"], ["model-catalog", "/model-catalog", "Model catalog"]] }
  ] as const satisfies ReadonlyArray<{ label: string; items: ReadonlyArray<readonly [Parameters<typeof dashboardNav>[0], string, string]> }>;
  const moreActive = groups.some((group) => group.items.some(([id]) => id === active));
  return `<a class="skip-link" href="#main-content">Skip to content</a><script>(()=>{const icon=document.createElement('link');icon.rel='icon';icon.type='image/png';icon.href='/assets/agent-workflow-favicon.png';document.head.append(icon);const key='agentflow.dashboard.theme';${themeBootstrapScript}document.documentElement.dataset.theme=theme;window.agentflowToggleTheme=()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{window.localStorage.setItem(key,next)}catch{}document.querySelectorAll('[data-theme-toggle]').forEach((button)=>{button.textContent=next==='dark'?'Light':'Dark';button.setAttribute('aria-pressed',String(next==='dark'));button.setAttribute('aria-label',next==='dark'?'Use light theme':'Use dark theme')})};window.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('[data-theme-toggle]').forEach((button)=>{button.textContent=theme==='dark'?'Light':'Dark';button.setAttribute('aria-pressed',String(theme==='dark'));button.setAttribute('aria-label',theme==='dark'?'Use light theme':'Use dark theme')})})})()</script><nav class="side-nav human-nav" aria-label="Dashboard navigation">
    <div class="nav-brand"><a class="nav-brand-link" href="/" aria-label="Agent Workflow home"><img src="/assets/agent-workflow-mark.png" alt="" width="34" height="34"><strong>Agent Workflow</strong></a><div class="nav-brand-actions"><button class="theme-toggle" data-theme-toggle type="button" aria-pressed="false" aria-label="Use dark theme" onclick="window.agentflowToggleTheme?.()">Dark</button><button class="nav-menu-button" type="button" aria-expanded="false" aria-controls="dashboard-menu" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));document.getElementById('dashboard-menu')?.classList.toggle('open',!open)">${dashboardIcon("list")}<span>Menu</span></button></div></div>
    <div id="dashboard-menu" class="dashboard-menu">
      ${primary.map(([id, href, label, icon]) => `<a class="primary-nav-link ${active === id ? "active" : ""}" ${active === id ? 'aria-current="page"' : ""} href="${href}">${iconLabel(icon, label)}${id === "approvals" ? '<span class="nav-badge" data-nav-badge="approvals" hidden></span>' : ""}</a>`).join("")}
      <a class="primary-nav-link nav-studio-link ${active === "studio" ? "active" : ""}" ${active === "studio" ? 'aria-current="page"' : ""} href="/studio">${iconLabel("sparkles", "Studio")}<small>Task workspace</small></a>
      <div class="nav-cluster nav-more ${moreActive ? "active-group" : ""}"><div class="primary-nav-row"><button type="button" class="primary-nav-link nav-more-toggle" aria-expanded="${moreActive ? "true" : "false"}" aria-controls="dashboard-more" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));this.closest('.nav-cluster')?.classList.toggle('expanded',!open)">${iconLabel("layers", "More")}${dashboardIcon("chevrons")}</button></div><div id="dashboard-more" class="nav-children">${groups.map((group) => `<span class="nav-more-heading">${escapeHtml(group.label)}</span>${group.items.map(([id, href, label]) => `<a class="${active === id ? "active" : ""}" ${active === id ? 'aria-current="page"' : ""} href="${href}">${escapeHtml(label)}</a>`).join("")}`).join("")}</div></div>
    </div>
    <script>fetch('/api/nav-counts',{headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).then(counts=>{const n=counts&&Number(counts.pendingApprovals);const badge=document.querySelector('[data-nav-badge="approvals"]');if(!badge||!n)return;badge.textContent=n>99?'99+':String(n);badge.setAttribute('aria-label',n+' pending approval'+(n===1?'':'s'));badge.hidden=false}).catch(()=>{});</script>
  ${deploymentStatusWidget()}</nav>`;
}

export function dashboardPagePath(pathname: string, params?: URLSearchParams): string {
  const query = params?.toString() ?? "";
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function dashboardReturnInput(pathname: string, params?: URLSearchParams): string {
  const pathValue = dashboardPagePath(pathname, params);
  const safePath = safeDashboardReturnPath(pathValue) ?? pathname;
  return `<input type="hidden" name="returnTo" value="${escapeHtml(safePath)}">`;
}

export function escapeHtml(value: string): string {
  return escapeHtmlText(value);
}

export function iconForMetric(label: string): DashboardIconName {
  const normalized = label.toLowerCase();
  if (/fail|error|critical|warning|missing|blocked|attention/u.test(normalized)) return "warning";
  if (/success|healthy|ready|complete|pass|online|matched|trusted/u.test(normalized)) return "check";
  if (/run|queue|task|worker|active/u.test(normalized)) return "activity";
  if (/project|source|file|indexed|artifact|archive|backup/u.test(normalized)) return "file";
  if (/provider|model|route|routing|tier|catalog/u.test(normalized)) return "route";
  if (/approval|role|govern|auth|trust|policy/u.test(normalized)) return "shield";
  if (/server|service|storage|database|redis|minio|sharedHost|sync/u.test(normalized)) return "server";
  if (/learning|feedback|eval|proposal|optimizer|comparison/u.test(normalized)) return "brain";
  return "gauge";
}

export function iconLabel(iconName: DashboardIconName, label: string): string {
  return `${dashboardIcon(iconName)}<span>${escapeHtml(label)}</span>`;
}

/** The one metric card: small uppercase label, large value, short detail. */
export function metricCard(label: string, value: string | number, detail: string, iconName: DashboardIconName = iconForMetric(label), className = ""): string {
  return `<div class="metric${className ? ` ${escapeHtml(className)}` : ""}"><strong>${dashboardIcon(iconName)}<span>${escapeHtml(label)}</span></strong><span>${escapeHtml(String(value))}</span><small>${escapeHtml(detail)}</small></div>`;
}

export function renderDashboardActionHistory(): string {
  return `<section id="dashboard-action-history" class="panel action-history" hidden>
    <div class="section-heading">
      <div>
        <h2>Recent Dashboard Actions</h2>
        <span class="muted">Browser-local history for this dashboard.</span>
      </div>
      <button type="button" class="secondary compact-button" onclick="window.localStorage.removeItem('agentflow.dashboard.actions'); document.getElementById('dashboard-action-history').hidden = true;">Clear</button>
    </div>
    <ul></ul>
  </section>
  <script>
    (() => {
      try {
        const normalizeActionMessage = (value) => {
          const message = String(value || "Action completed");
          const missing = /spawn\\s+([^\\s]+)\\s+ENOENT/i.exec(message);
          if (missing) return "Missing " + missing[1] + " on PATH";
          return message.replace(/ENOENT/g, "missing executable");
        };
        const panel = document.getElementById("dashboard-action-history");
        const list = panel?.querySelector("ul");
        const actions = JSON.parse(window.localStorage.getItem("agentflow.dashboard.actions") || "[]");
        if (!panel || !list || !Array.isArray(actions) || !actions.length) return;
        const now = Date.now();
        const freshActions = actions.filter((item) => {
          const at = Date.parse(String(item?.at || ""));
          if (!Number.isFinite(at)) return false;
          const maxAgeMs = item?.level === "error" ? 30 * 60 * 1000 : 10 * 60 * 1000;
          return now - at <= maxAgeMs;
        }).slice(0, 5);
        window.localStorage.setItem("agentflow.dashboard.actions", JSON.stringify(freshActions));
        if (!freshActions.length) return;
        list.innerHTML = freshActions.map((item) => {
          const level = item.level === "error" ? "error" : "success";
          const date = item.at ? new Date(item.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "unknown time";
          const message = normalizeActionMessage(item.message)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const path = String(item.path || "/")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          const marker = level === "error" ? "!" : "OK";
          return '<li class="' + level + '"><strong><span aria-hidden="true">' + marker + '</span>' + message + '</strong><span>' + path + ' · ' + date + '</span></li>';
        }).join("");
        panel.hidden = false;
      } catch {}
    })();
  </script>`;
}

/** A not-found or error page inside the normal dashboard layout. */
export function renderDashboardStatusPage(status: 404 | 500, title: string, message: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Agent Workflow</title>
  <style>${dashboardCss()}</style>
</head>
<body>${dashboardNav("dashboard")}<main id="main-content"><section class="panel status-page" data-http-status="${status}"><p class="muted">Error ${status}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><div class="actions"><a class="button" href="/">Home</a><a class="button secondary" href="/runs">Runs</a><a class="button secondary" href="/queue">Queue</a></div></section></main></body>
</html>`;
}

export function renderDashboardDateTime(value: string | null | undefined, fallback = "n/a"): string {
  if (!value) {
    return escapeHtml(fallback);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return escapeHtml(value);
  }
  const label = formatDashboardDateTimeText(value);
  return `<time datetime="${escapeHtml(parsed.toISOString())}" title="${escapeHtml(value)}">${escapeHtml(label)}</time>`;
}

export function renderDashboardFlash(params: URLSearchParams): string {
  return renderDashboardFlashValues({
    notice: params.get("notice") ?? undefined,
    error: params.get("error") ?? undefined,
    actionRun: params.get("actionRun") ?? undefined
  });
}

export function renderDashboardFlashValues(input: {notice?:string;error?:string;actionRun?:string}): string {
  const {notice, error, actionRun} = input;
  if (!notice && !error) return "";
  const message = error ?? notice ?? "";
  const runLink = actionRun ? `<a class="button secondary" href="/run?id=${encodeURIComponent(actionRun)}">Open Run</a>` : "";
  const historyEntry = {
    level: error ? "error" : "success",
    message,
    path: "",
    at: ""
  };
  return `<section class="panel flash-panel ${error ? "error" : "success"}">
    <div>
      <strong>${dashboardIcon(error ? "warning" : "check")}${error ? "Action needs attention" : "Action complete"}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
    ${runLink}
  </section>
  <script>
    (() => {
      try {
        const key = "agentflow.dashboard.actions";
        const entry = ${serializeInlineScriptJson(historyEntry)};
        entry.path = window.location.pathname;
        entry.at = new Date().toISOString();
        const current = JSON.parse(window.localStorage.getItem(key) || "[]");
        const currentList = Array.isArray(current) ? current : [];
        const isDuplicate = currentList[0]?.level === entry.level && currentList[0]?.message === entry.message && currentList[0]?.path === entry.path;
        const now = Date.now();
        const isFresh = (item) => {
          const at = Date.parse(String(item?.at || ""));
          if (!Number.isFinite(at)) return false;
          const maxAgeMs = item?.level === "error" ? 30 * 60 * 1000 : 10 * 60 * 1000;
          return now - at <= maxAgeMs;
        };
        const next = (isDuplicate ? currentList : [entry, ...currentList]).filter(isFresh).slice(0, 5);
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {}
    })();
  </script>`;
}

export function safeDashboardReturnPath(value: string): string | null {
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.origin !== "http://localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return null;
    }
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("/api/")) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

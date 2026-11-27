import { escapeHtml, dashboardNav, safeDashboardReturnPath } from "./layout.js";
import type { DashboardFollowUpResult } from "../../lib/cli-types.js";
import { truncateText } from "../../lib/builders-shared.js";
import { dashboardCss } from "../styles.js";
import http from "node:http";

export function dashboardActionReturnPath(request: http.IncomingMessage, form: URLSearchParams, fallbackPath: string): string | null {
  const explicit = form.get("returnTo")?.trim();
  const explicitPath = explicit ? safeDashboardReturnPath(explicit) : null;
  if (explicitPath) return explicitPath;

  const referer = request.headers.referer;
  const refererPath = typeof referer === "string" ? safeDashboardReturnPath(referer) : null;
  if (refererPath) return refererPath;

  return safeDashboardReturnPath(fallbackPath);
}

export function dashboardUrlFromRequest(request: http.IncomingMessage): string {
  const host = request.headers.host || "127.0.0.1";
  return `http://${host}`;
}

export function renderDashboardLoadingPage(title: string, nav: Parameters<typeof dashboardNav>[0]): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · loading</title>
  <noscript><meta http-equiv="refresh" content="2"></noscript>
  <style>${dashboardCss()}</style>
</head>
<body>${dashboardNav(nav)}<main id="main-content"><div class="topbar"><div><a href="/">Dashboard</a><h1>${escapeHtml(title)}</h1></div></div><section class="panel loading-page" data-dashboard-loading><p class="loading-line" role="status" aria-live="polite"><span class="loading-dot" aria-hidden="true"></span><span data-loading-text>Running live checks for this page. It opens by itself when they finish.</span></p><p class="muted">The first visit after the dashboard starts checks providers and local services; later visits use the saved result and refresh it in the background.</p></section></main>
<script>(()=>{const key="agentflow.loading:"+location.pathname+location.search;let tries=0;try{tries=Number(sessionStorage.getItem(key)||"0")+1;sessionStorage.setItem(key,String(tries))}catch{}if(tries>40){try{sessionStorage.removeItem(key)}catch{}document.querySelector("[data-loading-text]").textContent="This page is still loading. Refresh to check again.";return}setTimeout(()=>location.reload(),750)})();</script>
</body>
</html>`;
}

export function parseDashboardRunScope(value: string): "project" | "all-projects" {
  return value === "all-projects" || value === "all" ? "all-projects" : "project";
}

export function parseDashboardRunStatusFilter(value: string): string {
  return ["all", "active", "failed", "blocked", "completed", "queued", "leased", "running", "cancelled"].includes(value) ? value : "all";
}

export async function readFormBody(request: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function readJsonBody(request: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(`JSON request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

export function renderActionResultSummary(output: string): string {
  const summaryRows = output.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    /^(Approved|Executed|Skipped|Approval requests|Requeued|Affected runs|Queued stages):\s/u.test(line)
  ).slice(0, 6);
  if (!summaryRows.length) {
    return "";
  }
  return `<div class="meta-grid compact">${summaryRows.map((line) => {
    const [label = "Result", ...rest] = line.split(":");
    return `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(rest.join(":").trim())}</div>`;
  }).join("")}</div>`;
}

export function renderDashboardActionResult(result: DashboardFollowUpResult): string {
  const actionLinks = `
    <div class="actions">
      <a class="button" href="/approvals?status=pending">Pending Approvals</a>
      <a class="button secondary" href="/approvals?status=approved">Approved</a>
      <a class="button secondary" href="/approvals?status=executed">Executed</a>
      <a class="button secondary" href="/queue">Queue</a>
      <a class="button secondary" href="/">Dashboard</a>
    </div>
  `;
  const body = result.ok
    ? `<section class="panel action-result success"><h1>${escapeHtml(result.title)}</h1>${renderActionResultSummary(result.output)}<pre>${escapeHtml(result.output)}</pre>${result.runId ? `<p><a class="button" href="/run?id=${encodeURIComponent(result.runId)}">Open run</a></p>` : ""}${actionLinks}</section>`
    : `<section class="panel action-result failed"><h1>Action failed</h1><pre>${escapeHtml(result.error)}</pre>${actionLinks}</section>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard Action</title>
  <style>${dashboardCss()}</style>
</head>
<body>${dashboardNav("dashboard")}<main id="main-content"><p><a href="/">Dashboard</a></p>${body}</main></body>
</html>`;
}

export function respondDashboardAction(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  form: URLSearchParams,
  result: DashboardFollowUpResult,
  fallbackPath: string
): void {
  const returnPath = result.ok && result.redirectToRun && result.runId
    ? `/run?id=${encodeURIComponent(result.runId)}`
    : dashboardActionReturnPath(request, form, fallbackPath);
  if (!returnPath) {
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  const target = new URL(returnPath, "http://localhost");
  target.searchParams.delete("notice");
  target.searchParams.delete("error");
  target.searchParams.delete("actionRun");
  if (result.ok) {
    target.searchParams.set("notice", truncateText(result.title || "Action completed", 180));
    if (result.runId) target.searchParams.set("actionRun", result.runId);
  } else {
    target.searchParams.set("error", truncateText(result.error || "Action failed", 240));
  }
  response.writeHead(303, { location: `${target.pathname}${target.search}${target.hash}` });
  response.end();
}

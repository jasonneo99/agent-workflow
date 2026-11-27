import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, metricCard } from "../../ui/layout.js";
import { type FleetUsageReceipt } from "../../../../../../packages/fleet-model-gateway/src/index.js";
import { dashboardCss } from "../../styles.js";
import type { DashboardFleetUsageReport } from "../../../commands/daemon-types.js";

export async function readBoundedDashboardResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Summary response exceeded the configured limit.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

export function renderFleetModelUsageHtml(report: DashboardFleetUsageReport): string {
  const rows = report.receipts.slice(-100).reverse().map((receipt: FleetUsageReceipt) => `<tr>
    <td>${escapeHtml(receipt.observedAt)}</td><td>${escapeHtml(receipt.clientId)}</td><td>${escapeHtml(receipt.projectId ?? "unattributed")}</td>
    <td>${escapeHtml(receipt.provider)}</td><td>${escapeHtml(receipt.model ?? "unknown")}</td><td>${formatNumber(receipt.inputTokens)}</td>
    <td>${formatNumber(receipt.cachedInputTokens)}</td><td>${formatNumber(receipt.reasoningTokens)}</td><td>${formatNumber(receipt.outputTokens)}</td>
    <td>${formatNumber(receipt.totalTokens)}</td><td><span class="status ${receipt.status === "completed" ? "completed" : "failed"}">${escapeHtml(receipt.status)}</span></td>
  </tr>`).join("") || `<tr><td colspan="11">No gateway usage receipts have been observed yet.</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet Model Usage</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("fleet-model-usage")}<main id="main-content"><div class="topbar"><div><a href="/settings">Settings</a><h1>Fleet Model Usage</h1><p class="page-intro">Metadata-only usage observed through the authenticated fleet gateway.</p></div><a class="button secondary" href="/api/fleet-model-usage">JSON</a></div>
  <section class="callout ${report.dashboardSource === "local-fallback" ? "failed" : "completed"}"><strong>Data source</strong><p>${escapeHtml(report.dashboardSource)}${report.dashboardNotice ? ` · ${escapeHtml(report.dashboardNotice)}` : ""}</p></section>
  <section class="metrics">${metricCard("Requests", report.totals.requests, `${report.totals.failures} failed`)}${metricCard("Total Tokens", report.totals.totalTokens, `${report.clients.length} clients`)}${metricCard("Input Tokens", report.totals.inputTokens, `${report.totals.cachedInputTokens} cached`)}${metricCard("Output Tokens", report.totals.outputTokens, `${report.totals.reasoningTokens} reasoning`)}${metricCard("Estimated Cost", `$${report.totals.estimatedCostUsd.toFixed(4)}`, "configured pricing; billing is authoritative")}</section>
  <section class="panel"><h2>Recent Requests</h2><p class="muted">Prompts, responses, credentials, and raw request bodies are never stored. Calls that bypass the gateway are not included.</p><div class="table-wrap"><table><thead><tr><th>Observed</th><th>Client</th><th>Project</th><th>Provider</th><th>Model</th><th>Input</th><th>Cached</th><th>Reasoning</th><th>Output</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>
  <section class="panel"><h2>Run the Gateway</h2><p><code>npm run model-gateway</code></p><p>Configure credentials only through the environment. See <code>docs/fleet-model-gateway.md</code> for fleet setup and reconciliation guidance.</p></section></main></body></html>`;
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dashboardCss } from "./styles.js";

test("dashboard defaults to light and retains a selectable dark theme", async () => {
  const css = dashboardCss();
  const source = (
    await Promise.all(
      [
        "../index.ts",
        "../commands/system.ts",
        "../commands/bundle.ts",
        "../commands/project.ts",
        "../commands/storage.ts",
        "../commands/runs.ts",
        "../commands/approvals.ts",
        "../commands/learning.ts",
        "../commands/local-llm.ts",
        "../commands/server.ts",
        "../commands/context-extra.ts",
        "../commands/daemon.ts",
        "../lib/builders-shared.ts",
        "../lib/builders-server.ts",
      ].map(async (p) => {
        try {
          return await readFile(new URL(p, import.meta.url), "utf8");
        } catch {
          return "";
        }
      }),
    )
  ).join("\n");

  assert.match(css, /html:not\(\[data-theme="dark"\]\) \{ color-scheme: light;/u);
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.ops-pulse-panel/u);
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.nav-disclosure[^}]+background: transparent/u);
  assert.match(css, /html:not\(\[data-theme="dark"\]\) \.queue-card-callout\.bad small/u);
  assert.match(css, /html:not\(\[data-theme="dark"\]\) button\.danger/u);
  assert.match(css, /\.queue-worker-form/u);
  assert.match(css, /\.readiness-group/u);
  assert.match(css, /\.readiness-jump-nav/u);
  assert.match(css, /\.snapshot-metrics/u);
  assert.match(css, /\.theme-toggle/u);
  assert.match(source, /agentflow\.dashboard\.theme/u);
  assert.match(source, /data-theme-toggle/u);
  assert.match(source, /renderReadinessGroup/u);
  assert.match(source, /Inspection scope and advanced filters/u);
  assert.match(source, /Provider coverage/u);
  assert.match(source, /provider\.providerId === "muse"/u);
  assert.match(source, /metric-grid snapshot-metrics/u);
  assert.match(source, /metricCard\("Latest", latest \? formatDashboardDateTimeText/u);
  assert.doesNotMatch(source, /metricCard\([^\n]*renderDashboardDateTime\(/u);
  assert.match(source, /window\.agentflowToggleTheme/u);
  assert.match(source, /<label>Batch limit<input name="workerLimit"/u);
  assert.match(source, /<label>Concurrency<input name="workerConcurrency"/u);
});

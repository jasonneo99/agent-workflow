import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();
const css = await readFile(new URL("./dashboard/styles.ts", import.meta.url), "utf8");

test("metric labels keep the label size; only the value is large", () => {
  assert.match(css, /\.metric > span \{ font-size: 24px;/u);
  assert.match(css, /\.metric strong span \{ font: inherit; \}/u);
  assert.doesNotMatch(css, /\.metric span \{ font-size/u);
});

test("Queue and the run command center use the shared metric card", () => {
  assert.match(source, /<div class="metric-grid" data-queue-live-region="counts">\s*\$\{metricCard\("Active Runs"/u);
  assert.match(source, /<h2 class="queue-controls-heading">Process queued work<\/h2>/u);
  assert.match(source, /<div class="metric-grid run-command-metrics">\s*\$\{metricCard\("Stages complete"/u);
});

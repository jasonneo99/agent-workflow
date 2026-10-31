import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [daemonSource, stylesSource] = await Promise.all([
  readFile(new URL("./commands/daemon.ts", import.meta.url), "utf8"),
  readFile(new URL("./dashboard/styles.ts", import.meta.url), "utf8")
]);

test("candidate comparisons render accessible quality, latency, and tradeoff graphs", () => {
  assert.match(daemonSource, /aria-label="Baseline and candidate \$\{metric\} by suite"/u);
  assert.match(daemonSource, /aria-label="Quality gain against latency change"/u);
  assert.match(daemonSource, /Quality by suite[\s\S]+Latency by suite[\s\S]+Quality–speed tradeoff/u);
  assert.match(stylesSource, /\.chart-grid[\s\S]+\.comparison-chart[\s\S]+@media \(max-width: 820px\)[\s\S]+\.chart-grid \{ grid-template-columns: 1fr/u);
});

test("candidate comparisons expose fleet history with hour day week and month slicing", () => {
  assert.match(daemonSource, /Fleet model history/u);
  assert.match(daemonSource, /aria-label="All models \$\{metric\} over time"/u);
  assert.match(daemonSource, /Time bucket[\s\S]+minute[\s\S]+hour[\s\S]+day[\s\S]+week[\s\S]+month/u);
  assert.match(daemonSource, /History range[\s\S]+1 hour[\s\S]+24 hours[\s\S]+6 months[\s\S]+12 months[\s\S]+All retained/u);
  assert.match(daemonSource, /Model history date range[\s\S]+datetime-local[\s\S]+Apply range/u);
  assert.match(daemonSource, /chart-grid model-history-grid[\s\S]+Quality over time[\s\S]+Speed over time/u);
  assert.match(stylesSource, /\.model-history-grid \{ grid-template-columns: minmax\(0, 1fr\)/u);
  assert.match(daemonSource, /metric-grid candidate-summary-grid/u);
  assert.match(stylesSource, /\.candidate-summary-grid[\s\S]+repeat\(8,[\s\S]+white-space: nowrap/u);
  assert.match(daemonSource, /const ticks = Array\.from\(\{ length: 5 \}/u);
  assert.match(stylesSource, /\.model-legend/u);
});

test("project suggestions expose governed decisions, counts, alerts, and daemon timing", () => {
  assert.match(daemonSource, /\/api\/project-roadmap-suggestion/u);
  assert.match(daemonSource, /Add to roadmap[\s\S]+Defer[\s\S]+Dismiss/u);
  assert.match(daemonSource, /new high-priority suggestion/u);
  assert.match(daemonSource, /Suggestion Pipeline Health[\s\S]+Per-project budget/u);
  assert.match(daemonSource, /suggestionCounts[\s\S]+suggestions<\/span>/u);
});

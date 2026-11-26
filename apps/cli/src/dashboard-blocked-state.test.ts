import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./commands/daemon.ts", import.meta.url), "utf8");
const css = await readFile(new URL("./dashboard/styles.ts", import.meta.url), "utf8");

test("run health and throughput show Blocked as its own state", () => {
  const donut = source.slice(source.indexOf("function renderOpsStatusChart"), source.indexOf("function renderOpsThroughputChart"));
  assert.match(donut, /runStateCounts\(runs\)/u);
  assert.match(donut, /key\("blocked", "Blocked", blocked, "\/runs\?status=blocked"\)/u);
  const throughput = source.slice(source.indexOf("function renderOpsThroughputChart"), source.indexOf("function renderPostMergeEvidencePanel"));
  assert.match(throughput, /<i class="blocked" style="--share:/u);
  assert.match(throughput, /<span><i class="blocked"><\/i>Blocked<\/span>/u);
  assert.match(css, /\.ops-legend i\.blocked[^{]*\{ background: var\(--ops-amber\)/u);
  assert.match(css, /var\(--ops-amber\) var\(--failed\) var\(--blocked/u);
});

test("the queue counts blocked runs next to failed runs", () => {
  assert.match(source, /<strong>Failed Runs<\/strong>[^\n]*\n\s*<div><strong>Blocked Runs<\/strong>\$\{formatNumber\(blocked\.length\)\}/u);
});

test("the human intervention counter links to the list it counts", () => {
  assert.match(source, /renderOpsMetric\("Human intervention",[^\n]*"amber", "#human-intervention"\)/u);
  assert.match(source, /<section class="ops-panel ops-approvals-panel" id="human-intervention">/u);
});

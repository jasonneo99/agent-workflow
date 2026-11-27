import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();
const homeStart = source.search(/function renderDashboardHtml\(/u);
const home = source.slice(homeStart, source.indexOf('<section class="ops-panel start-work" id="start-work">', homeStart));

test("home opens with Needs you, Running now and Failed or blocked before the KPIs and charts", () => {
  const needs = home.indexOf('nowPanel("now-needs-you", "Needs you"');
  const running = home.indexOf('nowPanel("now-running", "Running now"');
  const troubled = home.indexOf('nowPanel("now-troubled", "Failed or blocked"');
  const pulse = home.indexOf('<section class="ops-pulse-panel">');
  const charts = home.indexOf('<div class="ops-chart-grid">');
  assert.ok(needs > 0 && needs < running && running < troubled && troubled < pulse && pulse < charts);
});

test("each first-screen row links to the run or the item that needs action", () => {
  assert.match(home, /class="ops-now-row" href="\$\{escapeHtml\(href\)\}"/u);
  assert.match(home, /runningNow = activeRuns\.slice\(0, 6\)\.map\(\(run\) => nowRow\(`\/run\?id=\$\{run\.id\}`/u);
  assert.match(home, /run\.status === "failed" \|\| run\.status === "blocked"/u);
  assert.match(home, /humanInterventions\.slice\(0, 6\)\.map\(\(item\) => nowRow\(item\.href/u);
});

test("the decorative pulse wave is gone from home", () => {
  assert.doesNotMatch(source, /renderOpsPulseLine|ops-neural-line" aria-hidden/u);
});

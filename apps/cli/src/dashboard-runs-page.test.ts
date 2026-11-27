import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();
const page = source.slice(source.indexOf("const RUNS_PAGE_STATUS_FILTERS"), source.indexOf("  function renderRunsHtml("));
const render = source.slice(source.indexOf("  function renderRunsHtml("));

test("runs page has status chips for every state, including Blocked", () => {
  assert.match(page, /\["all", "All"\], \["failed", "Failed"\], \["blocked", "Blocked"\], \["queued", "Queued"\], \["running", "Running"\], \["completed", "Completed"\]/u);
  assert.match(render.slice(0, 9000), /<nav class="status-chips" aria-label="Filter runs by status">/u);
  assert.match(page, /if \(filter === "running"\) return status === "running" \|\| status === "leased";/u);
  assert.match(page, /if \(normalized === "active"\) return "active";/u);
});

test("each run is one compact row: short id with copy, project name, task once", () => {
  const row = render.slice(0, 4000);
  assert.match(row, /<code>\$\{escapeHtml\(run\.id\.slice\(0, 8\)\)\}<\/code><\/a><button type="button" class="secondary copy-run-id" data-copy=/u);
  assert.match(row, /<td title="\$\{escapeHtml\(run\.projectRootUri\)\}">\$\{escapeHtml\(run\.projectName\)\}<\/td>/u);
  assert.doesNotMatch(row, /Original request|presentation\.description/u);
});

test("chip links keep the run-set and related-run scope", () => {
  assert.match(render.slice(0, 2000), /for \(const key of \["runSet", "relatedTo"\]\)/u);
});

test("the task column drops a prefix that repeats the workflow column", () => {
  assert.match(source, /withoutWorkflowPrefix\(presentation\.title, run\.workflowId\)/u);
  assert.match(source, /names\.includes\(prefix\) \? title\.slice\(index \+ 2\) : title/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./commands/daemon.ts", import.meta.url), "utf8");

test("slow pages answer with the layout first and finish their probes into the cache", () => {
  for (const [title, nav] of [["Providers", "providers"], ["Model catalog", "model-catalog"], ["Evaluations", "evaluations"], ["Settings", "info"], ["Discovery", "discovery"], ["Workflow bundles", "bundles"]]) {
    assert.match(source, new RegExp(`loadReportOrLoadingPage\\(response, \\{ title: "${title}", nav: "${nav}" \\}`, "u"), title);
  }
  const helper = source.slice(source.indexOf("async function loadReportOrLoadingPage"), source.indexOf("function renderDashboardLoadingPage"));
  assert.match(helper, /Promise\.race\(\[pending,/u);
  assert.match(helper, /pending\.catch\(\(\) => undefined\)/u);
  assert.match(source, /const DASHBOARD_LOADING_WAIT_MS = 400;/u);
});

test("the loading page keeps navigation, announces its state and stops retrying", () => {
  const page = source.slice(source.indexOf("function renderDashboardLoadingPage"), source.indexOf("async function loadQueueCardSnapshot"));
  assert.match(page, /\$\{dashboardNav\(nav\)\}<main id="main-content">/u);
  assert.match(page, /role="status" aria-live="polite"/u);
  assert.match(page, /if\(tries>40\)/u);
  assert.match(page, /<noscript><meta http-equiv="refresh" content="2"><\/noscript>/u);
});

test("bundle changes clear cached bundle pages; discovery paging reuses one scan", () => {
  assert.match(source, /request\.method === "POST" && requestUrl\.pathname\.startsWith\("\/api\/bundle"\)\) \{\s*for \(const key of \[\.\.\.dashboardReportCache\.keys\(\)\]\) if \(key\.startsWith\("bundles:"\)\)/u);
  assert.match(source, /discoveryParams\.delete\("page"\);\s*discoveryParams\.delete\("q"\);/u);
});

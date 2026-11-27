import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();

test("unknown paths get a 404 page inside the layout instead of the home page", () => {
  const home = source.indexOf("const [runs, throughput, workflows, worker, supervisor");
  const guard = source.lastIndexOf('if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html")', home);
  assert.ok(guard > 0 && home - guard < 600, "the 404 guard sits directly before the home page");
  assert.match(source.slice(guard, home), /writeHead\(404[\s\S]*renderDashboardStatusPage\(404, "Page not found"/u);
  assert.match(source.slice(guard - 400, guard), /startsWith\("\/api\/"\)[\s\S]*Unknown API path/u);
});

test("a malformed or unknown run id is a 404 page, not a server error", () => {
  const run = source.slice(source.indexOf('if (requestUrl.pathname === "/run") {'));
  assert.match(run.slice(0, 1200), /\[0-9a-f\]\{8\}-[\s\S]*renderDashboardStatusPage\(404, "Run not found"/u);
});

test("the status page renders the dashboard navigation and recovery links", () => {
  const start = source.indexOf("function renderDashboardStatusPage");
  const page = source.slice(start, source.indexOf("\n}\n", start) + 3);
  assert.match(page, /dashboardNav\("dashboard"\)/u);
  assert.match(page, /<main id="main-content">/u);
  assert.match(page, /href="\/runs">Runs/u);
});

test("page requests that fail get the layout; API and asset failures stay plain text", () => {
  const handler = source.slice(source.indexOf("function finishDashboardPageError"));
  assert.match(handler.slice(0, 900), /!pathname\.startsWith\("\/api\/"\) && !pathname\.startsWith\("\/assets\/"\)/u);
  assert.match(source, /catch \(error\) \{\s*console\.error\("Dashboard request failed:"[^\n]*\n\s*finishDashboardPageError\(request, response\);/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardSource } from "./dashboard/test-source.js";

const source = dashboardSource();
const navStart = source.indexOf("function dashboardNav(");
const nav = source.slice(navStart, source.indexOf("</nav>`;", navStart));

test("the navigation keeps five everyday pages at the top", () => {
  const primary = nav.slice(nav.indexOf("const primary = ["), nav.indexOf("] as const", nav.indexOf("const primary = [")));
  const labels = [...primary.matchAll(/\["[^"]+", "([^"]+)", "([^"]+)"/gu)].map((match) => match[2]);
  assert.deepEqual(labels, ["Home", "Queue", "Approvals", "Runs", "Projects"]);
});

test("every page that was in the menu is still reachable, under More if not at the top", () => {
  const pages = ["/studio", "/queue", "/approvals", "/runs", "/activity", "/projects", "/agents", "/discovery", "/workflow-graph", "/artifact-lifecycle",
    "/learning", "/learning?view=diagnostics", "/learning?view=settings", "/training-proposals", "/evaluations", "/feedback-inbox", "/model-improvement",
    "/candidate-comparisons", "/context-gateway", "/roadmap", "/settings", "/governance", "/approval-rules", "/roles", "/backup-report", "/server-readiness",
    "/fleet-model-usage", "/bundles", "/providers", "/model-catalog"];
  for (const page of pages) assert.ok(nav.includes(`"${page}"`), `${page} is missing from the navigation`);
  assert.match(nav, /iconLabel\("layers", "More"\)/u);
  assert.match(nav, /aria-controls="dashboard-more"/u);
});

test("Studio has its own labelled entry and Approvals shows a pending badge", () => {
  assert.match(nav, /class="primary-nav-link nav-studio-link[^`]*href="\/studio">\$\{iconLabel\("sparkles", "Studio"\)\}<small>Task workspace<\/small>/u);
  assert.match(nav, /data-nav-badge="approvals" hidden/u);
  assert.match(source, /fetch\('\/api\/nav-counts'/u);
  assert.match(source, /requestUrl\.pathname === "\/api\/nav-counts"[\s\S]{0,300}listActionApprovals\(\{ status: "pending", limit: 100 \}\)/u);
});

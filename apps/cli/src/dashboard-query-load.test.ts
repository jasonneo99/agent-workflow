import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("workflow graph polling coalesces server loads and rejects overlapping browser polls", () => {
  assert.match(source, /workflow-graph:\$\{requestUrl\.searchParams\.toString\(\)\}[\s\S]+loadDashboardWorkflowGraph\(requestUrl\.searchParams\)[\s\S]+2_000/u);
  assert.match(source, /let pollInFlight = false/u);
  assert.match(source, /if \(paused \|\| document\.hidden \|\| pollInFlight\) return;[\s\S]+pollInFlight = true/u);
  assert.match(source, /finally \{[\s\S]+pollInFlight = false/u);
});

test("dashboard home coalesces expensive run and queue reads", () => {
  assert.match(source, /loadCachedDashboardReport\("dashboard-home:runs:25", \(\) => listWorkflowRuns\(25\), 2_000\)/u);
  assert.match(source, /loadCachedDashboardReport\("dashboard-home:queue:100", \(\) => listWorkflowQueue\(100\), 2_000\)/u);
});

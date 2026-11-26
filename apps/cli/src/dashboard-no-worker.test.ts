import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatRunEta } from "./lib/builders-runs.js";
import { estimateRunEta, withWorkerAvailability } from "./dashboard/run-eta.js";

const source = await readFile(new URL("./commands/daemon.ts", import.meta.url), "utf8");

test("the ETA label says no worker is running", () => {
  const run = { id: "r", workflowId: "w", projectRootUri: "/p", status: "queued", startedAt: new Date().toISOString(), finishedAt: null };
  assert.equal(formatRunEta(withWorkerAvailability(estimateRunEta({ run, tasks: [{ status: "queued" }], historicalRuns: [] }), false)), "Waiting — no worker is running");
});

test("a leased or running run still counts as progressing without a heartbeat", () => {
  const helper = source.slice(source.indexOf("function dashboardRunCanProgress"));
  assert.match(helper.slice(0, 400), /workAvailable \|\| run\.status === "leased" \|\| run\.status === "running" \|\| tasks\.some/u);
});

test("every dashboard ETA surface applies worker availability", () => {
  assert.match(source, /renderRunsHtml\(runs, requestUrl\.searchParams, workAvailable\)/u);
  assert.match(source, /eta: withWorkerAvailability\(estimateRunEta\(\{ run: details\.run, tasks: details\.tasks, historicalRuns \}\), dashboardRunCanProgress\(workAvailable, details\.run, details\.tasks\)\)/u);
  assert.match(source, /workerAvailable: canProgress/u);
  assert.match(source, /payload\.eta\.state === 'waiting'\s*\? 'Waiting — no worker is running'/u);
  assert.match(source, /estimateQueueItemEta\(item, historicalRuns, workAvailable\)/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { queueLifecyclePresentation } from "./queue-lifecycle.js";

test("queue presentation calls work running only with an actual leased task", () => {
  assert.deepEqual(queueLifecyclePresentation({ runStatus: "running", queuedTasks: 0, runningTasks: 1 }), {
    key: "running", label: "running", active: true, explanation: "At least one task has a current execution lease."
  });
  assert.equal(queueLifecyclePresentation({ runStatus: "running", queuedTasks: 1, runningTasks: 0 }).key, "waiting");
  assert.equal(queueLifecyclePresentation({ runStatus: "running", queuedTasks: 0, runningTasks: 0 }).key, "stale");
});

test("terminal evidence outranks task-count projection", () => {
  assert.equal(queueLifecyclePresentation({ runStatus: "blocked", queuedTasks: 1, runningTasks: 0 }).key, "blocked");
  assert.equal(queueLifecyclePresentation({ runStatus: "failed", queuedTasks: 0, runningTasks: 1 }).key, "failed");
  assert.equal(queueLifecyclePresentation({ runStatus: "completed", queuedTasks: 0, runningTasks: 0 }).active, false);
});

test("queue cards and active totals use task-backed presentation", () => {
  const source = readFileSync(new URL("../commands/daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("function renderQueueHtml");
  const end = source.indexOf("function renderReadinessGroup", start);
  const queueView = source.slice(start, end);
  assert.match(queueView, /queueLifecyclePresentation\(item\)/u);
  assert.match(queueView, /queue-status-\$\{escapeHtml\(lifecycle\.key\)\}/u);
  assert.match(queueView, /Lifecycle needs reconciliation/u);
});

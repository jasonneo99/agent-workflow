import assert from "node:assert/strict";
import test from "node:test";
import { queueSnapshotSignature, queueWatcherScript } from "./queue-watcher.js";

test("queue signature changes when active progress changes", () => {
  const queued = [{ runId: "run-1", runStatus: "running", completedTasks: 0, queuedTasks: 1, runningTasks: 1, failedTasks: 0 }];
  const progressed = [{ ...queued[0], completedTasks: 1, queuedTasks: 0 }];
  assert.notEqual(queueSnapshotSignature(queued), queueSnapshotSignature(progressed));
});

test("web worker polls the queue without executing it", () => {
  const script = queueWatcherScript();
  assert.match(script, /fetch\("\/api\/queue"/);
  assert.doesNotMatch(script, /run-worker|queue-action/);
  assert.match(script, /active > 0 \? 2000 : 10000/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { NO_WORKER_REASON, aggregateRunEtas, estimateRunEta, withWorkerAvailability } from "./run-eta.js";

const now = Date.parse("2026-09-25T12:10:00.000Z");
const run = { id: "active", workflowId: "build-feature", projectRootUri: "/project", status: "running", startedAt: "2026-09-25T12:00:00.000Z", finishedAt: null };

test("run ETA uses project workflow history and current progress", () => {
  const eta = estimateRunEta({
    run,
    tasks: [{ status: "completed" }, { status: "running" }, { status: "queued" }, { status: "queued" }],
    historicalRuns: [
      { ...run, id: "one", status: "completed", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:40:00.000Z" },
      { ...run, id: "two", status: "completed", startedAt: "2026-09-23T10:00:00.000Z", finishedAt: "2026-09-23T11:00:00.000Z" },
      { ...run, id: "three", status: "completed", startedAt: "2026-09-22T10:00:00.000Z", finishedAt: "2026-09-22T10:50:00.000Z" }
    ],
    now
  });
  assert.equal(eta.state, "estimated");
  assert.equal(eta.source, "historical-workflow");
  assert.equal(eta.confidence, "medium");
  assert.equal(eta.sampleCount, 3);
  assert.ok((eta.remainingMs ?? 0) > 0);
  assert.ok(eta.estimatedCompletionAt);
});

test("run ETA falls back to current completed-stage pace without history", () => {
  const eta = estimateRunEta({ run, tasks: [{ status: "completed" }, { status: "running" }], historicalRuns: [], now });
  assert.equal(eta.state, "estimated");
  assert.equal(eta.source, "current-run-pace");
  assert.equal(eta.confidence, "low");
  assert.equal(eta.remainingMs, 10 * 60 * 1000);
});

test("run ETA stays truthful for new, blocked, and completed runs", () => {
  assert.equal(estimateRunEta({ run, tasks: [{ status: "running" }], historicalRuns: [], now }).state, "learning");
  assert.equal(estimateRunEta({ run: { ...run, status: "blocked" }, tasks: [{ status: "blocked" }], historicalRuns: [], now }).state, "paused");
  assert.equal(estimateRunEta({ run: { ...run, status: "completed" }, tasks: [{ status: "completed" }], historicalRuns: [], now }).state, "complete");
});

test("aggregate ETA follows the slowest parallel run and pauses truthfully", () => {
  const first = estimateRunEta({ run, tasks: [{ status: "completed" }, { status: "running" }], historicalRuns: [], now });
  const second = { ...first, estimatedCompletionAt: new Date(now + 900_000).toISOString(), remainingMs: 900_000 };
  const aggregate = aggregateRunEtas([{ runId: "one", eta: first }, { runId: "two", eta: second }], now);
  assert.equal(aggregate.remainingMs, 900_000);
  assert.equal(aggregate.runs.length, 2);
  const paused = aggregateRunEtas([{ runId: "blocked", eta: estimateRunEta({ run: { ...run, status: "blocked" }, tasks: [], historicalRuns: [], now }) }], now);
  assert.equal(paused.state, "paused");
});

test("no ETA is promised while no worker is running", () => {
  const queued = { ...run, status: "queued" };
  const history = [{ ...run, id: "done", status: "completed", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: "2026-09-24T10:00:01.000Z" }];
  const estimated = estimateRunEta({ run: queued, tasks: [{ status: "queued" }], historicalRuns: history, now });
  assert.equal(estimated.state, "estimated");
  const waiting = withWorkerAvailability(estimated, false);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.remainingMs, null);
  assert.equal(waiting.estimatedCompletionAt, null);
  assert.equal(waiting.reason, NO_WORKER_REASON);
  assert.equal(withWorkerAvailability(estimated, true), estimated);
  const complete = estimateRunEta({ run: { ...run, status: "completed" }, tasks: [{ status: "completed" }], historicalRuns: [], now });
  assert.equal(withWorkerAvailability(complete, false).state, "complete");
  assert.equal(aggregateRunEtas([{ runId: "a", eta: waiting }, { runId: "b", eta: estimated }], now).state, "waiting");
});

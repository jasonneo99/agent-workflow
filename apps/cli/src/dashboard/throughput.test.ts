import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyThroughputBuckets } from "./throughput.js";

test("weekly throughput includes all seven calendar days and zero-fills missing activity", () => {
  const now = new Date(2026, 8, 24, 12);
  const buckets = buildWeeklyThroughputBuckets([
    { startedAt: new Date(2026, 8, 24, 8).toISOString(), status: "completed" },
    { startedAt: new Date(2026, 8, 22, 8).toISOString(), status: "failed" },
    { startedAt: new Date(2026, 8, 10, 8).toISOString(), status: "completed" }
  ], now);

  assert.equal(buckets.length, 7);
  assert.deepEqual(buckets.map((bucket) => bucket.key), [
    "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"
  ]);
  assert.deepEqual(buckets.map(({ completed, failed, active }) => ({ completed, failed, active })), [
    { completed: 0, failed: 0, active: 0 },
    { completed: 0, failed: 0, active: 0 },
    { completed: 0, failed: 0, active: 0 },
    { completed: 0, failed: 0, active: 0 },
    { completed: 0, failed: 1, active: 0 },
    { completed: 0, failed: 0, active: 0 },
    { completed: 1, failed: 0, active: 0 }
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { QueueCardSnapshotCache } from "./queue-card-snapshot.js";

test("coalesces cold reads and returns one authoritative snapshot", async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => 1_000);
  const load = () => { calls += 1; return new Promise<string>((resolve) => { release = resolve; }); };
  const first = cache.get("all", load);
  const second = cache.get("all", load);
  assert.equal(calls, 1);
  release("fresh");
  assert.equal((await first).value, "fresh");
  assert.equal((await second).value, "fresh");
});

test("returns bounded stale data immediately and exposes its age while refreshing", async () => {
  let now = 0;
  let value = "first";
  let release!: (value: string) => void;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => now);
  await cache.get("all", async () => value);
  now = 900;
  const prior = await cache.get("all", () => new Promise<string>((resolve) => { release = resolve; }), true);
  assert.deepEqual(prior, { value: "first", capturedAt: 0, ageMs: 900, refreshing: true });
  release("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cache.get("all", async () => "unused")).value, "second");
});

test("does not serve a snapshot beyond the hard stale bound", async () => {
  let now = 0;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => now);
  await cache.get("all", async () => "first");
  now = 30_001;
  const next = await cache.get("all", async () => "second");
  assert.equal(next.value, "second");
  assert.equal(next.refreshing, false);
});

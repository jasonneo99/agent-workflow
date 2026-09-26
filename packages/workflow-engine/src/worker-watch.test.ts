import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerWatchLoop } from "./worker-watch.js";
import type { WorkerResult } from "./worker-types.js";

const empty = (): WorkerResult => ({ claimed: 0, completed: 0, failed: 0, providerFailures: [], providerIds: [], quarantinedProviderIds: [] });

test("watch worker replenishes an idle slot when another stage unlocks work", async () => {
  let stopped = false;
  let longRunning = true;
  let unlockedClaimed = false;
  let calls = 0;
  await runWorkerWatchLoop({
    limitPerTick: 2,
    intervalMs: 5,
    concurrency: 2,
    shouldStop: () => stopped,
    onTick: (result) => {
      assert.equal(result.claimed, 2);
      assert.equal(result.completed, 2);
      stopped = true;
    }
  }, async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 35));
      longRunning = false;
      return { ...empty(), claimed: 1, completed: 1 };
    }
    if (!longRunning && !unlockedClaimed) {
      unlockedClaimed = true;
      return { ...empty(), claimed: 1, completed: 1 };
    }
    return empty();
  });
  assert.equal(unlockedClaimed, true);
});

test("watch worker waits on the runtime event subscriber between idle ticks", async () => {
  let stopped = false;
  let waits = 0;
  await runWorkerWatchLoop({
    limitPerTick: 1,
    intervalMs: 2_000,
    shouldStop: () => stopped,
    onTick: () => undefined,
    waitForWake: async (timeoutMs) => {
      assert.equal(timeoutMs, 2_000);
      waits += 1;
      stopped = true;
      return "event";
    }
  }, async () => empty());
  assert.equal(waits, 1);
});

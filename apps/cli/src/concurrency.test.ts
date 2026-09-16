import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrency.js";

test("bounded mapping preserves order and never exceeds its concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { compareRegression, summarize } from "./index.js";

test("summarize calculates bounded percentile evidence", () => {
  assert.deepEqual(summarize([1, 2, 3, 4, 100]), { count: 5, p50: 3, p95: 100, average: 22, min: 1, max: 100 });
});

test("regression comparison fails closed and enforces its budget", () => {
  assert.equal(compareRegression({ baselineP95: 100, candidateP95: 109, budgetPercent: 10 }).passed, true);
  assert.equal(compareRegression({ baselineP95: 100, candidateP95: 111, budgetPercent: 10 }).passed, false);
  assert.equal(compareRegression({ baselineP95: 0, candidateP95: 1, budgetPercent: 10 }).passed, false);
});

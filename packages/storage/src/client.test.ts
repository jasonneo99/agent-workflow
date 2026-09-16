import assert from "node:assert/strict";
import test from "node:test";
import { boundedPoolSize } from "./client.js";

test("database pool size is bounded and has a conservative default", () => {
  assert.equal(boundedPoolSize(undefined), 10);
  assert.equal(boundedPoolSize("0"), 1);
  assert.equal(boundedPoolSize("8"), 8);
  assert.equal(boundedPoolSize("1000"), 20);
});

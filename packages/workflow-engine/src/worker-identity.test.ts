import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerIdentity } from "./worker-identity.js";

test("restarted workers retain lane labels but never reuse lease ownership", () => {
  const first = createWorkerIdentity(" example-lane ");
  const second = createWorkerIdentity("example-lane");
  assert.equal(first.workerLabel, "example-lane");
  assert.equal(second.workerLabel, first.workerLabel);
  assert.notEqual(first.workerId, second.workerId);
  assert.match(first.workerId, /^example-lane@[a-f0-9-]{36}$/);
});

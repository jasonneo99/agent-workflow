import assert from "node:assert/strict";
import test from "node:test";
import { actionIdempotencyKey } from "./executor.js";

test("action idempotency keys are stable for the same normalized action", () => {
  const base = {
    taskId: "task-1",
    stageId: "verify",
    agentId: "test-engineer",
    actionType: "local_command",
    target: "npm   test",
    payload: "npm   test",
    normalizePayload: true
  };

  assert.equal(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, target: "npm test", payload: "npm test" })
  );
});

test("action idempotency keys change when the payload changes", () => {
  const base = {
    taskId: "task-1",
    stageId: "document",
    agentId: "docs-maintainer",
    actionType: "file_write",
    target: ".agent-workflow/notes/summary.md",
    payload: "first version"
  };

  assert.notEqual(
    actionIdempotencyKey(base),
    actionIdempotencyKey({ ...base, payload: "second version" })
  );
});

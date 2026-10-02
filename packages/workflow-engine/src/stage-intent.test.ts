import test from "node:test";
import assert from "node:assert/strict";
import { acquiredStageIntent } from "./stage-intent.js";
test("only successful matching acquisition results prove stage ownership", () => {
  const intent = { projectId: "/tmp/example project", owner: "implementation", fencingToken: "3" };
  const output = `npm output\n${JSON.stringify(intent, null, 2)}\n`;
  const command = "npm run reliability -- intent acquire --project '/tmp/example project' --owner implementation --ttl 900";
  assert.deepEqual(acquiredStageIntent(command, output, 0, false), intent);
  assert.equal(acquiredStageIntent(command, output, 1, false), null);
  assert.equal(acquiredStageIntent(command, output, 0, true), null);
  assert.equal(acquiredStageIntent(command.replace("acquire", "list"), output, 0, false), null);
  assert.equal(acquiredStageIntent(command.replace("implementation", "other"), output, 0, false), null);
  assert.equal(acquiredStageIntent(command, "truncated", 0, false), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { restrictLearningDaemonLimit, restrictLearningDaemonMode } from "./learning-daemon-policy.js";

test("explicit observe mode caps every project at read-only observation", () => {
  assert.equal(restrictLearningDaemonMode("observe", "apply-approved"), "observe");
  assert.equal(restrictLearningDaemonMode("observe", "propose"), "observe");
});

test("project policy may make a requested daemon mode more restrictive", () => {
  assert.equal(restrictLearningDaemonMode("apply-approved", "observe"), "observe");
  assert.equal(restrictLearningDaemonMode("apply-approved", "propose"), "propose");
  assert.equal(restrictLearningDaemonMode("apply-approved", "apply-approved"), "apply-approved");
});

test("the command limit is a hard upper bound across projects", () => {
  assert.equal(restrictLearningDaemonLimit(25, 50), 25);
  assert.equal(restrictLearningDaemonLimit(50, 10), 10);
  assert.equal(restrictLearningDaemonLimit(0, 0), 1);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("approval autopilot replays a blocked run after its final required action executes", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /runApprovalAutopilot[\s\S]+details\.run\?\.status === "blocked"[\s\S]+!unresolved[\s\S]+retryFailedWorkflowRun\(approval\.runId\)/u);
});

test("approval autopilot does not create a second replacement after inline approval recovery", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /result\.runId !== approval\.runId[\s\S]+resumedRuns\.add\(approval\.runId\)[\s\S]+!resumedRuns\.has\(approval\.runId\)/u);
});

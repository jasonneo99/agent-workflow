import assert from "node:assert/strict";
import test from "node:test";
import { runSummaryFailureLines } from "./lib/builders-runs.js";

test("run summaries list blocked and failed stages when no failure text was recorded", () => {
  const stageResults = [
    { stageId: "implement", agentId: "implementation-agent", status: "blocked", attempts: 1 },
    { stageId: "verify", agentId: "auto-test-runner", status: "cancelled", attempts: 0 }
  ];
  assert.deepEqual(runSummaryFailureLines({ failures: [], stageResults }), ["- implement (implementation-agent) blocked; see Recommended next action"]);
  assert.deepEqual(runSummaryFailureLines({ failures: ["verify failed"], stageResults }), ["- verify failed"]);
  assert.deepEqual(runSummaryFailureLines({ failures: [], stageResults: [{ stageId: "answer", agentId: "project-answerer", status: "completed", attempts: 1 }] }), ["- None"]);
});

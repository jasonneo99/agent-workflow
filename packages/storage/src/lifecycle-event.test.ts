import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleResultSnapshot, runLifecycleEvent, replayRunLifecycleEvents } from "./lifecycle-event.js";
import { workflowRunStatuses } from "./run-state-machine.js";

test("run event identity and payload are stable for every state, including cancellation", () => {
  for (const to of workflowRunStatuses) {
    const input = { runId: "synthetic-run", stateVersion: "9007199254740993", from: "running" as const,
      to, occurredAt: "2026-01-01T00:00:00Z", reason: "State changed" };
    const event = runLifecycleEvent(input);
    assert.deepEqual(runLifecycleEvent(input), event);
    assert.equal(event.sequence, input.stateVersion);
    assert.equal(event.state, to);
    assert.equal(event.result?.acceptance ?? null, to === "completed" ? "unverified" : null);
  }
});

test("invalid replay requests fail closed before accessing storage", async () => {
  for (const afterSequence of ["-1", "1.5", "", " 1"]) {
    await assert.rejects(replayRunLifecycleEvents({ projectRootUri: "/synthetic", runId: "unused", afterSequence }), /Invalid/u);
  }
  for (const limit of [0, 101, NaN, 1.5]) {
    await assert.rejects(replayRunLifecycleEvents({ projectRootUri: "/synthetic", runId: "unused", limit }), /Invalid/u);
  }
});

test("completion carries supplied frozen evidence without implying acceptance", () => {
  const result = { runId: "synthetic-run", acceptance: "unverified" as const,
    artifacts: [{ uri: "db://synthetic/result", kind: "stage_output", contentSha256: "a".repeat(64) }],
    truncated: false, obligations: ["Verify receipt chain"] };
  const input = { runId: result.runId, stateVersion: "1", from: "running" as const,
    to: "completed" as const, occurredAt: "2026-01-01T00:00:00Z", reason: "Result ready", result };
  assert.deepEqual(runLifecycleEvent(input).result, result);
  assert.equal(runLifecycleEvent({ ...input, to: "blocked" }).result, null);
});

test("structured results bound reported deliverables and never elevate artifact claims", () => {
  const result = lifecycleResultSnapshot("synthetic", [
    { uri: "db://synthetic/output", kind: "stage_output", content: { summary: "Implemented", openObligations: ["Run live validation", 42], acceptance: "accepted", secret: "not exported" } },
    { uri: "db://synthetic/evidence", kind: "acceptance_preflight", content: { passed: true } }
  ]);
  assert.equal(result.acceptance, "unverified");
  assert.deepEqual(result.deliverables, [{ artifactUri: "db://synthetic/output", summary: "Implemented", status: "reported" }]);
  assert.deepEqual(result.verification, [{ artifactUri: "db://synthetic/evidence", kind: "acceptance_preflight", status: "unverified" }]);
  assert.ok(result.obligations?.includes("Artifact-reported: Run live validation"));
  assert.equal(JSON.stringify(result).includes("not exported"), false);
  const bounded = lifecycleResultSnapshot("synthetic", Array.from({length:51},(_,i)=>({uri:`db://synthetic/${i}`,kind:"stage_output",content:null})));
  assert.equal(bounded.artifacts?.length,50);
  assert.equal(bounded.deliverables?.length,50);
  assert.equal(bounded.truncated,true);
});

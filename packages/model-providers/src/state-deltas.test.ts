import assert from "node:assert/strict";
import test from "node:test";
import {
  commandDelta,
  commandFailureDelta,
  fileReadDelta,
  foldStateDeltas,
  renderDeltaLog,
  renderFactSet,
  type StateDelta
} from "./state-deltas.js";

function provenance() {
  return { stageId: "s1", agentId: "a1", actionType: "file_read", taskId: "t1" };
}

function delta(partial: Partial<StateDelta> & { key: string }): StateDelta {
  return {
    op: "assert",
    fact: "fact",
    provenance: provenance(),
    assertedAt: "2026-09-22T09:00:00.000Z",
    ...partial
  };
}

test("fold: assert adds facts keyed by stable identity", () => {
  const facts = foldStateDeltas([
    delta({ key: "file:src/a.ts", fact: "read 120 bytes" }),
    delta({ key: "repo.clean", fact: "true" })
  ]);
  assert.equal(facts.size, 2);
  assert.equal(facts.get("file:src/a.ts")?.fact, "read 120 bytes");
});

test("fold: later assert on the same key replaces the fact", () => {
  const facts = foldStateDeltas([
    delta({ key: "repo.clean", fact: "true", assertedAt: "2026-09-22T09:00:00.000Z" }),
    delta({ key: "repo.clean", fact: "false", assertedAt: "2026-09-22T09:01:00.000Z" })
  ]);
  assert.equal(facts.get("repo.clean")?.fact, "false");
  assert.equal(facts.get("repo.clean")?.assertedAt, "2026-09-22T09:00:00.000Z");
  assert.equal(facts.get("repo.clean")?.updatedAt, "2026-09-22T09:01:00.000Z");
});

test("fold: update records the previous fact for ~ rendering", () => {
  const facts = foldStateDeltas([
    delta({ key: "confidence", fact: "0.61" }),
    delta({ key: "confidence", op: "update", fact: "0.93" })
  ]);
  const record = facts.get("confidence");
  assert.equal(record?.fact, "0.93");
  assert.equal(record?.previousFact, "0.61");
  assert.match(renderFactSet(facts), /~ confidence: 0\.61 -> 0\.93/);
});

test("fold: retract removes the fact; retracting a missing key is a no-op", () => {
  const facts = foldStateDeltas([
    delta({ key: "stale", fact: "old" }),
    delta({ key: "stale", op: "retract", fact: "" }),
    delta({ key: "never-there", op: "retract", fact: "" })
  ]);
  assert.equal(facts.has("stale"), false);
  assert.equal(facts.size, 0);
});

test("fold: confidence is clamped to 0..1 and defaults to 1", () => {
  const facts = foldStateDeltas([
    delta({ key: "a", confidence: 2 }),
    delta({ key: "b", confidence: -1 }),
    delta({ key: "c" })
  ]);
  assert.equal(facts.get("a")?.confidence, 1);
  assert.equal(facts.get("b")?.confidence, 0);
  assert.equal(facts.get("c")?.confidence, 1);
});

test("fold: blank keys are skipped", () => {
  const facts = foldStateDeltas([delta({ key: "   " })]);
  assert.equal(facts.size, 0);
});

test("renderFactSet: empty set renders the empty marker", () => {
  assert.equal(renderFactSet(new Map()), "STATE (empty)");
});

test("renderFactSet: low-confidence facts carry their confidence", () => {
  const facts = foldStateDeltas([delta({ key: "guess", fact: "maybe x", confidence: 0.4 })]);
  assert.match(renderFactSet(facts), /\[conf 0\.40\]/);
});

test("renderDeltaLog: shows ops with markers including retractions", () => {
  const log = renderDeltaLog([
    delta({ key: "a", fact: "one" }),
    delta({ key: "b", op: "update", fact: "two" }),
    delta({ key: "c", op: "retract", fact: "" })
  ]);
  assert.match(log, /^\+ a: one/m);
  assert.match(log, /^~ b: two/m);
  assert.match(log, /^- c:/m);
});

test("fileReadDelta: success delta carries bytes and short sha", () => {
  const d = fileReadDelta({
    path: "src/auth/token.ts",
    bytesRead: 4820,
    truncated: false,
    sha256: "abcdef1234567890",
    provenance: provenance()
  });
  assert.equal(d.op, "assert");
  assert.equal(d.key, "file:src/auth/token.ts");
  assert.match(d.fact, /read 4820 bytes/);
  assert.match(d.fact, /sha256:abcdef123456/);
});

test("fileReadDelta: denial delta records the reason, never blocks", () => {
  const d = fileReadDelta({ path: ".env", error: "blocked by read policy", provenance: provenance() });
  assert.equal(d.op, "assert");
  assert.match(d.fact, /read denied: blocked by read policy/);
});

test("commandDelta: exit code is captured in the fact", () => {
  const d = commandDelta({ command: "cargo test", exitCode: 1, outputPreview: "FAILED", provenance: provenance() });
  assert.match(d.fact, /exit=1/);
  assert.match(d.fact, /FAILED/);
});

test("commandFailureDelta: retry framing and truncated output in the fact", () => {
  const d = commandFailureDelta({
    commandLine: "npm run typecheck",
    exitCode: 2,
    timedOut: false,
    truncatedOutput: "error TS2835: Relative import paths need explicit file extensions",
    retryRound: 1,
    retriesRemaining: 1,
    provenance: provenance()
  });
  assert.equal(d.op, "assert");
  assert.match(d.fact, /Verify retry 1 \(1 retry left\)/);
  assert.match(d.fact, /exited with code 2/);
  assert.match(d.fact, /TS2835/);
  const plural = commandFailureDelta({
    commandLine: "npm run typecheck",
    exitCode: 1,
    timedOut: true,
    truncatedOutput: "",
    retryRound: 1,
    retriesRemaining: 2,
    provenance: provenance()
  });
  assert.match(plural.fact, /2 retries left/);
  assert.match(plural.fact, /timed out/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { compileAirHeader } from "./air.js";

test("compileAirHeader: renders the canonical nine-field block", () => {
  const header = compileAirHeader({
    goal: "fix failing authentication tests",
    state: [
      { key: "repo.clean", fact: "true" },
      { key: "branch", fact: "feature/auth" }
    ],
    known: ["failure=token-expiration"],
    need: "locate implementation",
    plan: ["inspect", "diagnose", "patch", "test"],
    active: "inspect",
    budget: { tokens: "medium", timeSeconds: 120 },
    policy: { write: "yes", network: "no" }
  });
  const lines = header.split("\n");
  assert.equal(lines.length, 9);
  assert.match(header, /^GOAL      fix failing authentication tests$/m);
  assert.match(header, /^STATE     repo\.clean=true branch=feature\/auth$/m);
  assert.match(header, /^KNOWN     failure=token-expiration$/m);
  assert.match(header, /^NEED      locate implementation$/m);
  assert.match(header, /^PLAN      inspect -> diagnose -> patch -> test$/m);
  assert.match(header, /^ACTIVE    inspect$/m);
  assert.match(header, /^RESULTS   -$/m);
  assert.match(header, /^BUDGET    tokens=medium time=120s$/m);
  assert.match(header, /^POLICY    write=yes network=no$/m);
});

test("compileAirHeader: missing fields render as dashes", () => {
  const header = compileAirHeader({ goal: "x" });
  assert.match(header, /^STATE     -$/m);
  assert.match(header, /^KNOWN     -$/m);
  assert.match(header, /^BUDGET    -$/m);
  assert.match(header, /^POLICY    -$/m);
});

test("compileAirHeader: values are collapsed to single lines", () => {
  const header = compileAirHeader({ goal: "line one\nline two" });
  assert.match(header, /^GOAL      line one line two$/m);
  assert.equal(header.split("\n").length, 9);
});

test("compileAirHeader: oversized headers are truncated with a marker", () => {
  const header = compileAirHeader(
    {
      goal: "x",
      state: Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, fact: "v".repeat(100) }))
    },
    500
  );
  assert.ok(header.length <= 520);
  assert.match(header, /\.\.\. \(header truncated\)$/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dev-agentflow.mjs", import.meta.url), "utf8");

test("supervisor bounds child restart storms and exposes the breaker", () => {
  assert.match(source, /AGENTFLOW_SUPERVISOR_RESTART_LIMIT/u);
  assert.match(source, /AGENTFLOW_SUPERVISOR_RESTART_WINDOW_MS/u);
  assert.match(source, /AGENTFLOW_SUPERVISOR_RESTART_COOLDOWN_MS/u);
  assert.match(source, /function recordChildExit/u);
  assert.match(source, /function canStartChild/u);
  assert.match(source, /if \(!canStartChild\(name\)\) return false/u);
  assert.match(source, /held\.length \|\| journalDegraded \? "degraded" : "running"/u);
  assert.match(source, /restartBreakers: activeRestartBreakers/u);
  assert.match(source, /restart_breaker_opened/u);
  assert.match(source, /restart_recovery_attempted/u);
  assert.match(source, /restart_breaker_recovered/u);
  assert.match(source, /await flushSupervisorEvents\(\)/u);
  assert.match(source, /supervisorEventJournal/u);
});

test("Queue Partner has one missing-child recovery gate", () => {
  const checks = source.match(/if \(queuePartnerEnabled && !children\.has\("queue-partner"\)\)/gu) ?? [];
  assert.equal(checks.length, 1);
});

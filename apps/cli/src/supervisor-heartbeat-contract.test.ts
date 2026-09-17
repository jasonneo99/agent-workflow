import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../scripts/dev-agentflow.mjs", import.meta.url), "utf8");

test("supervisor prunes registry heartbeats only when their worker process is gone", () => {
  assert.match(source, /async function pruneDeadWorkerHeartbeatRegistry\(\)/u);
  assert.match(source, /command\.includes\(rootDir\)[\s\S]+apps\\\/cli\\\/src\\\/index/u);
  assert.match(source, /if \(!ownsLiveWorker\) await fs\.unlink\(heartbeatPath\)/u);
});

test("heartbeat pruning runs at startup and during supervision", () => {
  const calls = source.match(/await pruneDeadWorkerHeartbeatRegistry\(\)/gu) ?? [];
  assert.ok(calls.length >= 2);
});

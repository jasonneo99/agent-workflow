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

test("supervisor keeps Queue Partner running with capacity for its seven-item stretch target", () => {
  assert.match(source, /AGENTFLOW_WORKER_CONCURRENCY \?\? "7"/u);
  assert.match(source, /AGENTFLOW_WORKER_PER_PROJECT_CONCURRENCY \?\? "7"/u);
  assert.match(source, /AGENTFLOW_QUEUE_PARTNER !== "0"/u);
  assert.match(source, /AGENTFLOW_QUEUE_PARTNER_INTERVAL_MS \?\? "5000"/u);
  assert.match(source, /function startQueuePartner\(\)/u);
  assert.match(source, /"queue-coordinator"[\s\S]+"--all-queued-projects"[\s\S]+"--execute"[\s\S]+"--watch"/u);
  assert.match(source, /if \(queuePartnerEnabled && !children\.has\("queue-partner"\)\)/u);
  assert.match(source, /queuePartnerManaged/u);
});

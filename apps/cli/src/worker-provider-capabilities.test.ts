import assert from "node:assert/strict";
import test from "node:test";
import { probeWorkerProviderExecution, WORKER_PROVIDER_IDS } from "./worker-provider-capabilities.js";

test("worker capability discovery covers every supported execution provider", () => {
  assert.deepEqual(WORKER_PROVIDER_IDS, ["mock", "local", "byo", "bedrock", "codex-cli", "openai", "anthropic", "muse", "openai-compatible", "kiro"]);
});

test("worker provider admission requires a real bounded inference result", async () => {
  const healthy = await probeWorkerProviderExecution("codex-cli", {
    id: "codex-cli",
    async executeStage() { return { summary: "ready", artifact: {} }; }
  });
  const rejected = await probeWorkerProviderExecution("codex-cli", {
    id: "codex-cli",
    async executeStage() { throw new Error("authentication rejected"); }
  });
  assert.equal(healthy.ready, true);
  assert.equal(rejected.ready, false);
  assert.match(rejected.reason, /authentication rejected/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_PROVIDER_IDS } from "./worker-provider-capabilities.js";

test("worker capability discovery covers every supported execution provider", () => {
  assert.deepEqual(WORKER_PROVIDER_IDS, ["mock", "local", "byo", "bedrock", "codex-cli", "openai", "anthropic", "openai-compatible", "kiro"]);
});

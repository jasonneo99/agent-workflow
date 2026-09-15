import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFleetUsageReceipts } from "../../fleet-model-gateway/src/index.js";
import type { StageExecutionInput } from "../../model-providers/src/types.js";
import { recordDirectProviderUsage } from "./fleet-usage.js";

test("direct provider attempts enter the fleet ledger once without prompt bodies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-direct-usage-"));
  const ledger = path.join(directory, "usage.jsonl");
  const previous = process.env.AGENTFLOW_FLEET_USAGE_LEDGER;
  process.env.AGENTFLOW_FLEET_USAGE_LEDGER = ledger;
  try {
    const stage = { runId: "run", taskId: "task", workflowId: "build-feature", stageId: "plan", projectConfig: { project: { name: "private-project" } } } as StageExecutionInput;
    const attempts = [{ provider: "anthropic", model: "claude", attempt: 0, attemptId: "attempt", outcome: "completed" as const }];
    const input = { stage, attempts, output: { summary: "secret output", artifact: { model: "claude" }, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }, latencyMs: 20 };
    assert.equal(await recordDirectProviderUsage(input), 1);
    assert.equal(await recordDirectProviderUsage(input), 0);
    const receipts = await readFleetUsageReceipts(ledger);
    assert.equal(receipts.length, 1);
    assert.deepEqual({ provider: receipts[0]?.provider, input: receipts[0]?.inputTokens, output: receipts[0]?.outputTokens }, { provider: "anthropic", input: 10, output: 4 });
    assert.doesNotMatch(JSON.stringify(receipts), /secret output|private-project/);
  } finally {
    if (previous === undefined) delete process.env.AGENTFLOW_FLEET_USAGE_LEDGER;
    else process.env.AGENTFLOW_FLEET_USAGE_LEDGER = previous;
  }
});

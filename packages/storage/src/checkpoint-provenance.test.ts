import assert from "node:assert/strict";
import test from "node:test";
import { validateRecoveryCheckpoint } from "./checkpoint-provenance.js";

test("historical checkpoint requires exact completion receipt and rejects missing, altered and inherited outputs", async () => {
  const artifact = { summary: "Synthetic plan", plan: ["verify"] };
  const client = (metadata?: Record<string, unknown>) => ({ query: async () => ({ rows: metadata ? [{ metadata }] : [] }) }) as unknown as Parameters<typeof validateRecoveryCheckpoint>[0];
  const input = { runId: "source", taskId: "task", stageId: "plan", artifact };
  await validateRecoveryCheckpoint(client(artifact), input);
  await assert.rejects(validateRecoveryCheckpoint(client(), input), /completion receipt/);
  await assert.rejects(validateRecoveryCheckpoint(client({ ...artifact, plan: [] }), input), /completion receipt/);
  for (const invalid of [null, { ...artifact, skipped: true }, { ...artifact, checkpointPreservedFromRunId: "ancestor" }]) {
    await assert.rejects(validateRecoveryCheckpoint(client(artifact), { ...input, artifact: invalid }), /original completed-stage/);
  }
});

test("gated historical checkpoints still require structured acceptance, not just a completion receipt", async () => {
  const artifact = { summary: "Synthetic verification" };
  const client = { query: async (sql: string) => ({ rows: sql.includes("action_receipts")
    ? [{ metadata: artifact }] : [{ projectId: "project", task: "task", metadata: {} }] }) } as unknown as Parameters<typeof validateRecoveryCheckpoint>[0];
  await assert.rejects(validateRecoveryCheckpoint(client, { runId: "source", taskId: "task", stageId: "verify", artifact }), /historical acceptance/);
});

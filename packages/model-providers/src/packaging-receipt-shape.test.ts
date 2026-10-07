import assert from "node:assert/strict";
import test from "node:test";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { CodexCliProvider, type CodexCliRunner } from "./codex-cli.js";
import { acceptanceDigest, storedAcceptanceDecision } from "../../storage/src/acceptance.js";
import type { StageExecutionInput, StructuredAcceptanceContract } from "./types.js";

test("one correction preserves authoritative context and rejects malformed extraction fallback", async () => {
  const malformed = fixture() as any; for (const gate of gates) malformed.deliverables[0].receipts[gate] = { ...reference };
  const calls: Parameters<CodexCliRunner["execute"]>[0][] = [];
  const adapter = new CodexCliProvider({ async authStatus() { return "Logged in using ChatGPT"; }, async execute(call) { calls.push(call); return { model: "synthetic-model", output: `Response: ${JSON.stringify({ outcome: "completed", summary: "Synthetic response", acceptanceContract: calls.length === 1 ? malformed : fixture() })}` }; } });
  const stage = input(); const snapshot = structuredClone(stage.acceptanceContract);
  const output = await adapter.executeStage(stage); assert.equal(calls.length, 2); assert.deepEqual(output.artifact.acceptanceContract, fixture()); assert.deepEqual(stage.acceptanceContract, snapshot);
  assert.deepEqual(calls[1].schema, calls[0].schema); assert.ok(calls[1].prompt.startsWith(calls[0].prompt)); assert.match(calls[1].prompt, /one attempt.*arrays of typed references/s);
  calls.length = 0; const rejecting = new CodexCliProvider({ async authStatus() { return "Logged in using ChatGPT"; }, async execute(call) { calls.push(call); return { model: "synthetic-model", output: `Response: ${JSON.stringify({ outcome: "completed", acceptanceContract: malformed })}` }; } }); await assert.rejects(() => rejecting.executeStage(input()), /acceptance schema/i); assert.equal(calls.length, 2);
});

test("stale subject and observation references remain blocked on repeated evaluation", async () => {
  for (const change of [{ subjectHash: "stale-subject" }, { observedAt: "2025-01-01T00:00:00.000Z" }]) { const proposal = fixture(); proposal.deliverables[0].receipts.packaging![0] = { ...reference, ...change }; const first = await decision(proposal); assert.equal(first.mode, "structured"); assert.notEqual(first.reason, null); assert.deepEqual(await decision(proposal), first); }
});
const gates = ["implementation", "verification", "packaging", "supervision"] as const;
const content = { commandLine: "synthetic-packaging-check", exitCode: 0, timedOut: false, subjectHash: "synthetic-subject" };
const observedAt = "2026-01-01T00:00:00.000Z";
const reference = { artifactUri: "db://synthetic/command", runId: "synthetic-run", taskId: "synthetic-task", stageId: "verify", kind: "command_output" as const, contentHash: acceptanceDigest(content), observedAt, subjectHash: "synthetic-subject" };
function fixture(): StructuredAcceptanceContract {
  return { version: 1, contractId: "synthetic-contract", projectId: "synthetic-project", originRunId: "synthetic-run", taskHash: acceptanceDigest("Synthetic packaging task"), subjectHash: "synthetic-subject", deliverables: [{ id: "delivery", description: "Synthetic delivery", requiredGates: [...gates], status: "verified", receipts: Object.fromEntries(gates.map(gate => [gate, [{ ...reference }]])), gaps: [] }] };
}
function input(): StageExecutionInput {
  return { runId: "synthetic-run", taskId: "synthetic-package-task", projectConfig: projectConfigSchema.parse({ project: { name: "synthetic-project" } }), workflowId: "build-feature", workflowTask: "Synthetic packaging task", stageId: "package", agentId: "release-manager", agentName: "Release Manager", agentPrompt: "Preserve supplied evidence.", stageGoal: "Package synthetic evidence.", compiledBrief: "Isolated synthetic fixture", priorReceipts: [], acceptanceContract: fixture() } as StageExecutionInput;
}
function provider(proposal: unknown) {
  return new CodexCliProvider({
    async authStatus() { return "Logged in using ChatGPT access token"; },
    async execute(call) {
      const schema = call.schema as any;
      const receipts = schema.properties.acceptanceContract.properties.deliverables.items.anyOf[0].properties.receipts.properties;
      for (const gate of gates) assert.equal(receipts[gate].type, "array");
      return { model: "synthetic-model", output: JSON.stringify({ outcome: "completed", blockedReason: "", summary: "Packaged synthetic workflow evidence while preserving all supplied references.", findings: ["Supplied evidence preserved"], nextAction: "Independent verification", requestedCommands: [], requestedFileReads: [], requestedFileSearches: [], requestedFileWrites: [], acceptanceContract: proposal }) };
    }
  });
}
function client() {
  return { async query(sql: string) {
    return { rows: sql.includes("select uri from artifacts") ? [{ uri: reference.artifactUri }] : sql.includes("from workflow_runs where")
      ? [{ projectId: "synthetic-project", task: "Synthetic packaging task", metadata: { acceptanceContract: fixture() } }]
      : [{ runId: reference.runId, taskId: reference.taskId, stageId: reference.stageId, projectId: "synthetic-project", kind: "command_output", content, observedAt }] };
  } } as unknown as Parameters<typeof storedAcceptanceDecision>[0];
}
async function decision(proposal: unknown) {
  return storedAcceptanceDecision(client(), "synthetic-run", "packaging", { acceptanceContract: proposal });
}

test("valid provider response preserves exact arrays and passes worker storage gate", async () => {
  const proposal = fixture();
  const output = await provider(proposal).executeStage(input());
  assert.deepEqual(output.artifact.acceptanceContract, proposal);
  assert.deepEqual(proposal, fixture());
  assert.equal((await decision(output.artifact.acceptanceContract)).reason, null);
});

test("singleton receipts reproduce the worker packaging evidence blocker", async () => {
  const malformed = fixture() as any;
  for (const gate of gates) malformed.deliverables[0].receipts[gate] = { ...reference };
  const result = await decision(malformed);
  assert.equal(result.mode, "structured");
  assert.equal(result.reason, "Deliverable delivery lacks packaging evidence.");
});

test("missing tampered and foreign packaging receipts still block", async () => {
  for (const variation of ["missing", "tampered", "foreign"]) {
    const proposal = fixture();
    if (variation === "missing") proposal.deliverables[0].receipts.packaging = [];
    else proposal.deliverables[0].receipts.packaging![0] = { ...reference, ...(variation === "tampered" ? { contentHash: "tampered" } : { runId: "foreign-run" }) };
    const result = await decision(proposal);
    assert.equal(result.mode, "structured");
    assert.notEqual(result.reason, null, variation);
  }
});

test("provider decoder rejects singleton receipt objects before completion", async () => {
  const malformed = fixture() as any;
  for (const gate of gates) malformed.deliverables[0].receipts[gate] = { ...reference };
  await assert.rejects(() => provider(malformed).executeStage(input()), /receipt|array|acceptance|schema/i);
});

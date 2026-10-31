import assert from "node:assert/strict";
import test from "node:test";
import { commandAcceptanceReference, commandEvidencePacket, COMMAND_EVIDENCE_CONTENT_MAX_BYTES, COMMAND_EVIDENCE_PACKET_MAX_BYTES } from "./command-evidence.js";
import { acceptanceDigest } from "./acceptance.js";
import { buildStagePrompt } from "../../model-providers/src/prompts.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";

test("acceptance references preserve stored identity, hash and timestamp without inventing missing provenance", () => {
  const row = { uri: "db://synthetic/command", runId: "run", taskId: "task", stageId: "verify", createdAt: "2026-01-01T00:00:00.000Z", content: { subjectHash: "source", exitCode: 0, timedOut: false } };
  const reference = commandAcceptanceReference(row)!;
  assert.equal(reference.contentHash, acceptanceDigest(row.content));
  assert.equal(reference.observedAt, row.createdAt);
  assert.equal(reference.runId, row.runId);
  assert.deepEqual(JSON.parse(commandEvidencePacket([row]))[0].acceptanceReference, reference);
  assert.equal(commandAcceptanceReference({ ...row, content: {} }), undefined);
  assert.equal(commandAcceptanceReference({ ...row, taskId: null }), undefined);
  assert.equal(commandAcceptanceReference({ ...row, createdAt: "invalid" }), undefined);
});

test("command evidence retains result tails and failure states within fixed bounds", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ uri: `db://synthetic/${i}`, content: {
    commandLine: "npm test", exitCode: i === 19 ? 1 : 0, timedOut: false,
    stdout: "noise".repeat(2000) + "tests 788; database removed=true", stderr: "failure detail"
  } }));
  const packet = JSON.parse(commandEvidencePacket(rows));
  assert.equal(packet.length, 12);
  assert.equal(packet[0].artifactUri, "db://synthetic/8");
  assert.equal(packet[11].exitCode, 1);
  assert.ok(packet[11].stdoutTail.endsWith("database removed=true"));
  assert.ok(packet.every((item: {stdoutTail: string}) => item.stdoutTail.length <= 650));
});

function ownedCommand(overrides: Record<string, unknown> = {}) {
  return {
    uri: "db://workflow_runs/example-run/command_output/example-receipt",
    runId: "example-run", taskId: "example-task", stageId: "verify",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: {
      commandLine: "npm test -- " + "fixture.test.ts ".repeat(50),
      cwd: "/synthetic/project", exitCode: 0, timedOut: false, subjectHash: "source",
      requestedByTaskId: "example-task", requestedByStageId: "verify",
      stdout: "fixture-created\n" + "noise\n".repeat(2000)
        + "MIDDLE_EVIDENCE: isolated=true\n" + "noise\n".repeat(2000) + "fixture-removed\n",
      stderr: "complete diagnostic",
      ...overrides
    }
  };
}

test("owned stored payloads retain long commands, middle evidence and exact receipt hashes", () => {
  const row = ownedCommand();
  const observation = JSON.parse(commandEvidencePacket([row]))[0];
  assert.equal(observation.command, row.content.commandLine);
  assert.equal(observation.commandTruncated, false);
  assert.equal(observation.storedContentComplete, true);
  assert.deepEqual(observation.storedContent, row.content);
  assert.equal(observation.contentHash, acceptanceDigest(observation.storedContent));
  assert.equal(observation.acceptanceReference.contentHash, observation.contentHash);
  assert.match(observation.storedContent.stdout, /fixture-created/);
  assert.match(observation.storedContent.stdout, /MIDDLE_EVIDENCE: isolated=true/);
  assert.match(observation.storedContent.stdout, /fixture-removed/);
});

test("oversized stored output stays an explicit preview without losing failure evidence", () => {
  const row = ownedCommand({ stdout: "x".repeat(COMMAND_EVIDENCE_CONTENT_MAX_BYTES) + "FINAL_FAILURE", exitCode: 1 });
  const observation = JSON.parse(commandEvidencePacket([row]))[0];
  assert.equal(observation.storedContentComplete, false);
  assert.equal(observation.omissionReason, "stored-content-limit");
  assert.equal(observation.storedContent, undefined);
  assert.equal(observation.exitCode, 1);
  assert.ok(observation.stdoutTail.endsWith("FINAL_FAILURE"));
  assert.equal(observation.contentHash, acceptanceDigest(row.content));
});

test("aggregate evidence has a byte bound and retains newest complete observations", () => {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const row = ownedCommand({ stdout: "x".repeat(40_000) + `middle-${i}` });
    return { ...row, uri: `db://workflow_runs/example-run/command_output/receipt-${i}` };
  });
  const serialized = commandEvidencePacket(rows);
  const observations = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= COMMAND_EVIDENCE_PACKET_MAX_BYTES);
  assert.equal(observations.length, 12);
  assert.equal(observations[11].storedContentComplete, true);
  assert.equal(observations[0].storedContentComplete, false);
  assert.equal(observations[0].omissionReason, "packet-budget");
  assert.deepEqual(observations[11].storedContent, rows[11]!.content);
});

test("foreign or missing command ownership cannot expose a complete stored body", () => {
  const row = ownedCommand();
  for (const candidate of [
    { ...row, runId: "different-run" },
    { ...row, taskId: "different-task" },
    { ...row, stageId: "different-stage" },
    { ...row, createdAt: "invalid" },
    { ...row, content: { ...row.content, requestedByTaskId: undefined } }
  ]) {
    const observation = JSON.parse(commandEvidencePacket([candidate]))[0];
    assert.equal(observation.storedContentComplete, false);
    assert.equal(observation.omissionReason, "unverified-command-ownership");
    assert.equal(observation.storedContent, undefined);
  }
});

test("multibyte evidence and malformed metadata cannot escape the packet byte bound", () => {
  const row = ownedCommand({ stdout: "界".repeat(30_000) });
  const observation = JSON.parse(commandEvidencePacket([row]))[0];
  assert.equal(observation.storedContentComplete, false);
  assert.equal(observation.omissionReason, "stored-content-limit");
  const oversized = Array.from({ length: 12 }, () => ({
    ...row, uri: "界".repeat(100_000), runId: "r".repeat(100_000)
  }));
  const serialized = commandEvidencePacket(oversized);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= COMMAND_EVIDENCE_PACKET_MAX_BYTES);
  assert.ok(JSON.parse(serialized).every((item: Record<string, unknown>) =>
    item.metadataTruncated === true && item.storedContentComplete === false));
});

test("reused evidence is stable and does not assert complete execution stream capture", () => {
  const row = ownedCommand({ stdout: "head\n...[middle truncated]...\ntail" });
  const original = JSON.stringify(row);
  const first = commandEvidencePacket([row]);
  assert.equal(commandEvidencePacket([row]), first);
  assert.equal(JSON.stringify(row), original);
  const observation = JSON.parse(first)[0];
  assert.equal(observation.storedContentComplete, true);
  assert.equal(observation.executionOutputCompleteness, "not-attested");
  assert.match(observation.storedContent.stdout, /middle truncated/);
});

test("the actual provider prompt carries complete command evidence beyond summary and tail limits", () => {
  const row = ownedCommand();
  const summary = commandEvidencePacket([row]);
  const prompt = buildStagePrompt({
    runId: row.runId, taskId: row.taskId, workflowId: "build-feature",
    workflowTask: "Verify bounded synthetic evidence.", stageId: row.stageId,
    stageGoal: "Review the retained results.", agentId: "test-engineer",
    agentName: "Test", agentPrompt: "Treat retained output as evidence.",
    compiledBrief: "", projectConfig: projectConfigSchema.parse({ project: { name: "synthetic-project" } }),
    priorReceipts: [{ agentId: "test-engineer", actionType: "command_evidence_packet", summary }]
  });
  const commandSection = prompt.split("Command evidence (")[1]!.split("Replay ancestor evidence")[0]!;
  assert.ok(commandSection.includes(summary), "The dedicated provider section preserves the exact complete packet");
  assert.ok(commandSection.includes("MIDDLE_EVIDENCE: isolated=true"));
  assert.ok(commandSection.includes(row.content.commandLine));
  assert.ok(commandSection.includes(acceptanceDigest(row.content)));
});

import assert from "node:assert/strict";
import test from "node:test";
import { commandAcceptanceReference, commandEvidencePacket } from "./command-evidence.js";
import { acceptanceDigest } from "./acceptance.js";

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

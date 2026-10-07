import test from "node:test";
import assert from "node:assert/strict";
import { ownershipPath, receiptOwnership, type OwnershipReceipt } from "./continuation-ownership.js";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const write = (overrides: Partial<OwnershipReceipt> = {}): OwnershipReceipt => ({
  runId: "synthetic-run", taskId: "prior-stage-task", stageId: "implement",
  kind: "file_write", uri: "artifact://synthetic/write", status: "completed", operation: "file_write",
  content: { relativePath: "./src\\owned.ts", nextHash: digest,
    requestedByTaskId: "prior-stage-task", requestedByStageId: "implement" },
  receipt: { artifactUri: "artifact://synthetic/write", path: "src/owned.ts", nextHash: digest },
  ...overrides
});
const reconstruct = (rows: OwnershipReceipt[], currentHash = digest) => receiptOwnership({
  runId: "synthetic-run", rows: JSON.parse(JSON.stringify(rows)),
  currentHash: async (relative) => { assert.equal(relative, "src/owned.ts"); return currentHash; }
});

test("serialized finalized prior-stage writes survive resumed attempts without claiming unrelated files", async () => {
  const owned = await reconstruct([write(), write()]);
  assert.deepEqual([...owned], ["src/owned.ts"]);
  assert.equal(owned.has("src/user.ts"), false);
  assert.equal(owned.has("src/owned.ts/child.ts"), false);
});

test("foreign, missing, rejected, pending and mismatched evidence cannot establish ownership", async () => {
  assert.equal((await reconstruct([])).size, 0);
  for (const row of [
    write({ runId: "foreign-run" }), write({ kind: "action_rejection" }),
    write({ status: "pending" }), write({ status: "uncertain" }),
    write({ operation: "local_command" }), write({ taskId: "foreign-task" }),
    write({ stageId: "foreign-stage" }), write({ receipt: {} }),
    write({ receipt: { artifactUri: "foreign-uri", path: "src/owned.ts", nextHash: digest } }),
    write({ receipt: { artifactUri: "artifact://synthetic/write", path: "src/user.ts", nextHash: digest } }),
    write({ receipt: { artifactUri: "artifact://synthetic/write", path: "src/owned.ts", nextHash: otherDigest } })
  ]) assert.equal((await reconstruct([row])).size, 0);
});

test("stale current content and superseded hashes cannot claim a file", async () => {
  assert.equal((await reconstruct([write()], otherDigest)).size, 0);
  const latest = write({ content: { ...write().content, nextHash: otherDigest },
    receipt: { ...write().receipt, nextHash: otherDigest } });
  assert.equal((await reconstruct([latest, write()], digest)).size, 0);
  assert.deepEqual([...await reconstruct([latest, write()], otherDigest)], ["src/owned.ts"]);
});

test("ownership normalization accepts aliases but rejects traversal, absolute and directory evidence", async () => {
  assert.equal(ownershipPath("./src\\./owned.ts"), "src/owned.ts");
  for (const relative of ["", ".", "../owned.ts", "src/../owned.ts", "/owned.ts", "C:\\owned.ts", "//host/owned.ts", "src/", "src\u0000owned.ts"]) {
    assert.equal(ownershipPath(relative), null);
    assert.equal((await reconstruct([write({ content: { ...write().content, relativePath: relative } })])).size, 0);
  }
});

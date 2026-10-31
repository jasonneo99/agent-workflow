import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectStageWritePostimages, ownershipPath, receiptOwnership, type OwnershipReceipt } from "./continuation-ownership.js";

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

const priorWrites = (actions: unknown[]) => [{ artifact: { actionResults: actions } }];
const writeAction = (overrides: Record<string, unknown> = {}) => ({
  type: "file_write", path: "src/owned.ts", artifactUri: "artifact://synthetic/write", ...overrides
});

test("checkout preflight ignores narrative and proposed writes without reading files for a no-write stage", async () => {
  let receiptReads = 0;
  const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
    priorStageArtifacts: [{ artifact: { summary: "src/owned.ts was repaired", requestedFileWrites: [writeAction()],
      proposedSourcePaths: ["src/owned.ts"], actionResults: [{ type: "file_read", path: "src/owned.ts" }] } }] },
    { receipts: async () => { receiptReads++; return []; },
      currentHash: async () => { throw Error("No actual write selected a filesystem read"); } });
  assert.equal(report, null);
  assert.equal(receiptReads, 1, "Interrupted own-task writes must still be checked");
});

test("checkout preflight distinguishes matching, stale and missing local postimages", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "postimage-checkouts-"));
  const fresh = path.join(base, "fresh"), stale = path.join(base, "stale"), missing = path.join(base, "missing");
  const content = "export const revision = 2;\n";
  const hash = createHash("sha256").update(content).digest("hex");
  try {
    for (const root of [fresh, stale, missing]) await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(fresh, "src/owned.ts"), content);
    await writeFile(path.join(stale, "src/owned.ts"), "export const revision = 1;\n");
    const row = write({ content: { ...write().content, nextHash: hash }, receipt: { ...write().receipt, nextHash: hash } });
    for (const root of [fresh, stale, missing]) {
      const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: root,
        priorStageArtifacts: priorWrites([writeAction()]) }, { receipts: async () => [row],
        currentHash: async relative => createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex") });
      assert.equal(report?.matches, root === fresh);
      assert.deepEqual(report?.unverifiedPaths, root === fresh ? [] : ["src/owned.ts"]);
    }
    assert.equal(await readFile(path.join(fresh, "src/owned.ts"), "utf8"), content);
    assert.equal(await readFile(path.join(stale, "src/owned.ts"), "utf8"), "export const revision = 1;\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("checkout preflight cannot resurrect an older receipt behind an unfinalized latest write", async () => {
  const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
    priorStageArtifacts: priorWrites([writeAction()]) },
    { receipts: async () => [write({ status: "uncertain" }), write()],
      currentHash: async () => { throw Error("Unfinalized latest evidence cannot fall back to an older hash"); } });
  assert.equal(report?.matches, false);
  assert.deepEqual(report?.unverifiedPaths, ["src/owned.ts"]);
});

test("checkout preflight rejects unbound and foreign write evidence", async () => {
  for (const row of [write({ runId: "foreign-run" }), write({ taskId: "foreign-task" }), write({ receipt: {} })]) {
    const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
      priorStageArtifacts: priorWrites([writeAction()]) }, { receipts: async () => [row],
      currentHash: async () => digest });
    assert.equal(report?.matches, false);
  }
});

test("checkout preflight follows the newest finalized same-run write after a legitimate update", async () => {
  const latest = write({ content: { ...write().content, nextHash: otherDigest },
    receipt: { ...write().receipt, nextHash: otherDigest } });
  for (const current of [digest, otherDigest]) {
    const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
      priorStageArtifacts: priorWrites([writeAction()]) }, { receipts: async () => [latest, write()],
      currentHash: async () => current });
    assert.equal(report?.matches, current === otherDigest);
  }
});

test("checkout preflight normalizes aliases and includes reused writes without expanding scope", async () => {
  let reads = 0;
  const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/synthetic/checkout",
    priorStageArtifacts: priorWrites([writeAction(), writeAction({ path: "./src\\owned.ts" }),
      writeAction({ type: "file_write_reused", path: "tests/owned.test.ts" })]) }, {
    receipts: async runId => {
      assert.equal(runId, "synthetic-run");
      return [write(), write({ content: { ...write().content, relativePath: "tests/owned.test.ts" },
        receipt: { ...write().receipt, path: "tests/owned.test.ts" } }),
        write({ runId: "foreign-run", content: { ...write().content, relativePath: "src/unrelated.ts" } })];
    }, currentHash: async relative => {
      reads++; assert.ok(["src/owned.ts", "tests/owned.test.ts"].includes(relative)); return digest;
    } });
  assert.equal(reads, 2);
  assert.deepEqual(report?.requiredPaths, ["src/owned.ts", "tests/owned.test.ts"]);
  assert.deepEqual(report?.matchedPaths, report?.requiredPaths);
  assert.equal(report?.matches, true);
});

test("checkout preflight rejects malformed or excessive write scopes before footprint access", async () => {
  for (const actions of [[writeAction({ path: "../outside" })], [writeAction({ artifactUri: "" })],
    Array.from({ length: 1001 }, (_, i) => writeAction({ path: `src/file-${i}.ts` }))]) {
    const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
      priorStageArtifacts: priorWrites(actions) }, { receipts: async () => { throw Error("Rejected scope must not read"); } });
    assert.equal(report?.matches, false);
    assert.ok(report?.invalidWriteCount || report?.scopeLimitExceeded);
  }
});

test("checkout preflight discovers interrupted own-task writes without any completed stage output", async () => {
  for (const current of [digest, otherDigest]) {
    const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused", priorStageArtifacts: [] },
      { receipts: async () => [write()], currentHash: async () => current });
    assert.deepEqual(report?.requiredPaths, ["src/owned.ts"]);
    assert.equal(report?.matches, current === digest);
  }
});

test("checkout preflight retains unresolved interrupted writes rather than assuming an empty checkout", async () => {
  const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused" }, {
    receipts: async () => [write({ status: "pending" }), write()],
    currentHash: async () => { throw Error("Pending write evidence must not read or resurrect an old hash"); }
  });
  assert.equal(report?.matches, false);
  assert.deepEqual(report?.unverifiedPaths, ["src/owned.ts"]);
});

test("checkout preflight propagates unavailable storage and refuses a claimed write without a receipt", async () => {
  await assert.rejects(inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused" }, {
    receipts: async () => { throw Error("receipt storage unavailable"); }
  }), /receipt storage unavailable/);
  const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused",
    priorStageArtifacts: priorWrites([writeAction()]) }, { receipts: async () => [], currentHash: async () => digest });
  assert.equal(report?.matches, false);
  assert.deepEqual(report?.unverifiedPaths, ["src/owned.ts"]);
});

test("checkout preflight rejects malformed and oversized stored write scopes before filesystem access", async () => {
  const malformed = write({ content: { ...write().content, relativePath: "../outside" } });
  const excessive = Array.from({ length: 1001 }, (_, i) => write({
    content: { ...write().content, relativePath: `src/file-${i}.ts` }
  }));
  for (const rows of [[malformed], excessive]) {
    const report = await inspectStageWritePostimages({ runId: "synthetic-run", cwd: "/unused" }, {
      receipts: async () => rows, currentHash: async () => { throw Error("Rejected stored scope must not read files"); }
    });
    assert.equal(report?.matches, false);
    assert.ok(report?.invalidWriteCount || report?.scopeLimitExceeded);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { applyUnifiedPatch, executeAllowedFilePatch } from "./file-patcher.js";
import { sha256 } from "./file-writer.js";

const project = projectConfigSchema.parse({ project: { name: "patch-test" }, actions: { allowed_write_paths: ["src/**"], max_write_bytes: 2048 } });

test("applies exact unified-diff hunks", () => {
  const result = applyUnifiedPatch("one\ntwo\nthree\n", "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
  assert.equal(result.content, "one\nTWO\nthree\n");
  assert.equal(result.hunksApplied, 1);
});

test("rejects stale hashes without changing the target", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentflow-patch-"));
  await writeFile(path.join(cwd, "src.ts"), "old\n");
  await assert.rejects(() => executeAllowedFilePatch({ relativePath: "src.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", expectedHash: "0".repeat(64), cwd, project: projectConfigSchema.parse({ project: { name: "patch-test" }, actions: { allowed_write_paths: ["src.ts"], max_write_bytes: 2048 } }) }), /stale preimage hash/u);
  assert.equal(await readFile(path.join(cwd, "src.ts"), "utf8"), "old\n");
});

test("patches files larger than the patch-byte limit and returns hashes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentflow-patch-"));
  const original = `${"prefix\n".repeat(500)}old\n`;
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "large.ts"), original);
  const expectedHash = sha256(Buffer.from(original));
  const patch = "@@ -501 +501 @@\n-old\n+new\n";
  const result = await executeAllowedFilePatch({ relativePath: "src/large.ts", patch, expectedHash, cwd, project });
  assert.equal(result.previousHash, expectedHash);
  assert.notEqual(result.nextHash, expectedHash);
  assert.equal(result.hunksApplied, 1);
});

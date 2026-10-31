import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { selectApprovedFileMutation } from "./approved-file-mutation.js";
import { executeAllowedFileMutation } from "./file-patcher.js";
import { sha256 } from "./file-writer.js";

const patch = "@@ -1 +1 @@\n-old\n+new\n";
const expectedHash = sha256(Buffer.from("old\n"));
const request = { path: "source.txt", patch, content: null, expectedHash };
const approval = { mode: "patch", expectedHash, payloadHash: sha256(Buffer.from(patch)) };
test("patch-only approvals execute through the strict patcher", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "approved-patch-"));
  await writeFile(path.join(cwd, request.path), "old\n");
  const selected = selectApprovedFileMutation(request.path, approval, [request]);
  const project = projectConfigSchema.parse({ project: { name: "synthetic" },
    actions: { allowed_write_paths: [request.path] } });
  await executeAllowedFileMutation({ ...selected, cwd, project });
  assert.equal(await readFile(path.join(cwd, request.path), "utf8"), "new\n");
  const replay = await executeAllowedFileMutation({ ...selected, cwd, project });
  assert.equal("outcome" in replay ? replay.outcome : null, "already_satisfied");
  assert.equal(await readFile(path.join(cwd, request.path), "utf8"), "new\n");
});
test("rejects changed path, payload, mode, or preimage approval bindings", () => {
  for (const changed of [
    { ...request, path: "other.txt" }, { ...request, patch: patch + "\n" },
    { ...request, expectedHash: "0".repeat(64) },
    { ...request, content: "ambiguous replacement" },
    { path: request.path, content: patch },
  ]) assert.throws(() => selectApprovedFileMutation(request.path, approval, [changed]));
  assert.throws(() => selectApprovedFileMutation(request.path, { ...approval, mode: "replace" }, [request]));
  assert.throws(() => selectApprovedFileMutation(request.path, { ...approval, payloadHash: undefined }, [request]));
});
test("an approved patch cannot bypass the current write allowlist", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "approved-policy-"));
  await writeFile(path.join(cwd, request.path), "old\n");
  const selected = selectApprovedFileMutation(request.path, approval, [request]);
  const project = projectConfigSchema.parse({ project: { name: "synthetic" },
    actions: { allowed_write_paths: ["different.txt"] } });
  await assert.rejects(executeAllowedFileMutation({ ...selected, cwd, project }));
  assert.equal(await readFile(path.join(cwd, request.path), "utf8"), "old\n");
});
test("preserves replacement approval compatibility and exact content binding", () => {
  const write = { path: "source.txt", content: "replacement" };
  const approved = { mode: "replace", payloadHash: sha256(Buffer.from(write.content)) };
  assert.equal(selectApprovedFileMutation(write.path, approved, [write]).isPatch, false);
  assert.equal(selectApprovedFileMutation(write.path, {}, [write]).payload, write.content);
  assert.throws(() => selectApprovedFileMutation(write.path, approved, [{ ...write, content: "changed" }]));
});

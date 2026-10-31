import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { applyUnifiedPatch, executeAllowedFilePatch, reverseUnifiedPatch, oversizedReplacementPatchHint, executeAllowedFileMutation } from "./file-patcher.js";
import {executeAllowedFileRead} from './file-reader.js';
import { sha256 } from "./file-writer.js";

const project = projectConfigSchema.parse({ project: { name: "patch-test" }, actions: { allowed_write_paths: ["src/**"], max_write_bytes: 2048 } });

test("mismatch diagnostics distinguish the requested preimage from current text", () => {
  assert.throws(() => applyUnifiedPatch("actual\n", "@@ -1,1 +1,1 @@\n expected\n"), /patch expected "expected"; file contains "actual"/u);
  assert.throws(() => applyUnifiedPatch("actual\n", "@@ -1,1 +1,1 @@\n-expected\n+next\n"), /patch expected "expected"; file contains "actual"/u);
});

test("zero-length old ranges insert after their anchor, including the start", () => {
  for (const [anchor, expected] of [[0, "new\none\ntwo\n"], [1, "one\nnew\ntwo\n"], [2, "one\ntwo\nnew\n"]] as const) {
    assert.equal(applyUnifiedPatch("one\ntwo\n", `@@ -${anchor},0 +${anchor + 1},1 @@\n+new\n`).content, expected);
  }
  assert.throws(() => applyUnifiedPatch("one\n", "@@ -2,0 +3,1 @@\n+new\n"), /outside the target/);
  assert.throws(() => applyUnifiedPatch("one\n", "@@ -0,1 +1,1 @@\n-one\n+new\n"), /outside the target/);
  assert.throws(() => applyUnifiedPatch("one\n", "@@ -0,0 +1,2 @@\n+new\n"), /count mismatch/);
});

test("applies exact unified-diff hunks", () => {
  const result = applyUnifiedPatch("one\ntwo\nthree\n", "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n");
  assert.equal(result.content, "one\nTWO\nthree\n");
  assert.equal(result.hunksApplied, 1);
});

test("reverses an approved postimage back to its exact preimage", () => {
  const patch = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  assert.equal(applyUnifiedPatch("one\nTWO\nthree\n", reverseUnifiedPatch(patch)).content, "one\ntwo\nthree\n");
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
  assert.equal(result.outcome, "applied");
  assert.equal(result.expectedHash, expectedHash);
  assert.equal(result.patchHash, sha256(Buffer.from(patch)));
});

test("reports an already-satisfied exact postimage without rewriting it", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentflow-patch-satisfied-"));
  const original = "old\n";
  const approvedPatch = "@@ -1 +1 @@\n-old\n+new\n";
  await writeFile(path.join(cwd, "source.txt"), "new\n");
  const before = await readFile(path.join(cwd, "source.txt"));
  const result = await executeAllowedFilePatch({
    relativePath: "source.txt", patch: approvedPatch,
    expectedHash: sha256(Buffer.from(original)), cwd,
    project: projectConfigSchema.parse({ project: { name: "patch-test" }, actions: { allowed_write_paths: ["source.txt"] } })
  });
  assert.equal(result.outcome, "already_satisfied");
  assert.equal(result.previousHash, result.nextHash);
  assert.deepEqual(await readFile(path.join(cwd, "source.txt")), before);
});

test("rejects a mismatched or malformed patch instead of claiming already satisfied", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentflow-patch-stale-"));
  await writeFile(path.join(cwd, "source.txt"), "unrelated\n");
  const config = projectConfigSchema.parse({ project: { name: "patch-test" }, actions: { allowed_write_paths: ["source.txt"] } });
  await assert.rejects(executeAllowedFilePatch({ relativePath: "source.txt", patch: "@@ -1 +1 @@\n-old\n+new\n", expectedHash: sha256(Buffer.from("old\n")), cwd, project: config }), /stale preimage/u);
  await assert.rejects(executeAllowedFilePatch({ relativePath: "source.txt", patch: "not a patch", expectedHash: sha256(Buffer.from("unrelated\n")), cwd, project: config }), /no unified-diff hunks/u);
  assert.equal(await readFile(path.join(cwd, "source.txt"), "utf8"), "unrelated\n");
});
test('bounded read supplies full hash; tiny governed mutation safely patches a 500KB file',async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'agentflow-large-patch-'));
  const original='old\n'+'unchanged\n'.repeat(60000);
  await mkdir(path.join(cwd,'src'));await writeFile(path.join(cwd,'src/large.ts'),original);
  const config=projectConfigSchema.parse({project:{name:'synthetic'},actions:{allowed_read_paths:['src/large.ts'],allowed_write_paths:['src/large.ts'],max_read_bytes:1024,max_write_bytes:1024}}),before=JSON.stringify(config);
  const read=await executeAllowedFileRead({relativePath:'src/large.ts#L1-L2',cwd,project:config});
  assert.equal(read.truncated,false);assert.equal(read.sha256,sha256(Buffer.from(original)));
  assert.match(oversizedReplacementPatchHint('src/large.ts',original,config)!,/expectedHash/);
  const patch='@@ -1 +1 @@\n-old\n+new\n';
  const result=await executeAllowedFileMutation({request:{path:'src/large.ts',patch,expectedHash:read.sha256},payload:patch,isPatch:true,expectedHash:read.sha256,cwd,project:config});
  assert.equal(result.previousHash,read.sha256);assert.equal(result.nextHash,sha256(await readFile(path.join(cwd,'src/large.ts'))));
  assert.ok('patchBytes' in result&&result.patchBytes<1024);assert.ok(result.bytesWritten>500000);
  assert.equal(JSON.stringify(config),before,'No policy or acceptance widening');
  await assert.rejects(executeAllowedFilePatch({relativePath:'src/large.ts',patch:patch+' '.repeat(1024),expectedHash:result.nextHash,cwd,project:config}),/patch is/);
});
test('large-file patch recovery never overrides blocked scopes or shared inode aliases',async()=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'agentflow-patch-scope-'));
  await mkdir(path.join(cwd,'src'));await writeFile(path.join(cwd,'private.ts'),'old\n');
  const config=projectConfigSchema.parse({project:{name:'synthetic'},actions:{allowed_write_paths:['src/exact.ts'],max_write_bytes:64}});
  assert.equal(oversizedReplacementPatchHint('private.ts','x'.repeat(100),config),null);
  await symlink(path.join(cwd,'private.ts'),path.join(cwd,'src/exact.ts'));
  await assert.rejects(executeAllowedFilePatch({relativePath:'src/exact.ts',patch:'@@ -1 +1 @@\n-old\n+new\n',expectedHash:sha256(Buffer.from('old\n')),cwd,project:config}),/symlink alias/);
  await link(path.join(cwd,'private.ts'),path.join(cwd,'src/shared.ts'));
  await assert.rejects(executeAllowedFilePatch({relativePath:'src/shared.ts',patch:'@@ -1 +1 @@\n-old\n+new\n',expectedHash:sha256(Buffer.from('old\n')),cwd,project:projectConfigSchema.parse({...config,actions:{...config.actions,allowed_write_paths:['src/shared.ts']}})}),/unshared regular/);
  assert.equal(await readFile(path.join(cwd,'private.ts'),'utf8'),'old\n');
});

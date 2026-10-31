import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";
import { executeAllowedCommand } from "../../local-tools/src/command-executor.js";
import { ENVIRONMENT_COMMAND, runProcess, type ProcessRunner } from "./index.js";
import { createRepairCheckpoint, REPAIR_COMMIT_COMMAND, verifyRepairCheckpoint } from "./repair-checkpoint.js";

async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "repair-checkpoint-test-")));
  const git = async (...args: string[]) => {
    const result = await runProcess(["git", ...args], { cwd, timeoutMs: 5000, maxOutputChars: 20_000 });
    assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim();
  };
  await fs.mkdir(path.join(cwd, "src")); await fs.mkdir(path.join(cwd, "tests"));
  await fs.writeFile(path.join(cwd, ".gitignore"), ".agent-workflow/runtime/\n");
  await fs.writeFile(path.join(cwd, "src/index.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(cwd, "tests/check.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/index.js'; test('candidate', () => assert.equal(value, 2));\n");
  await git("init", "-b", "repair");
  await git("config", "user.name", "Example Developer"); await git("config", "user.email", "developer@example.com");
  await git("config", "commit.gpgsign", "false"); await git("config", "core.hooksPath", ".git/test-hooks");
  await git("add", "--", ".gitignore", "src", "tests"); await git("commit", "-m", "Synthetic baseline");
  const expectedParent = await git("rev-parse", "HEAD");
  await fs.writeFile(path.join(cwd, "src/index.js"), "export const value = 2;\n");
  const project = projectConfigSchema.parse({ project: { name: "synthetic-project" }, execution: {
    repair_commits: { enabled: true }, environments: { default_profile: "test", profiles: { test: {
      kind: "native", platform: `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`,
      source_paths: ["src", "tests"], readiness: [{ argv: ["node", "--version"] }],
      verification: [{ commands: ["node --test tests/check.test.js"], format: "node-test", expected_tests: 1 }]
    } } }
  }, actions: { allowed_commands: [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND, "node --version", "node --test tests/check.test.js"], allowed_write_paths: ["src/**", "tests/**"] } });
  const validate = async (runId: string, reuseRunId?: string) => {
    const result = await executeAllowedCommand({ cwd, project, commandLine: "node --test tests/check.test.js", environmentContext: { runId, reuseRunId, requireVerification: true } });
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.verificationRecipe?.status, "passed");
    return path.relative(cwd, result.environment!.receiptPath!).split(path.sep).join("/");
  };
  const validationReceipt = await validate("repair-1");
  return { cwd, project, expectedParent, runId: "repair-1", files: ["src/index.js"], validationReceipt, git, validate,
    cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}

test("candidate preview is read-only; commit uses exact source evidence and a fresh independent verifier", async () => {
  const f = await fixture(); try {
    const preview = await createRepairCheckpoint(f);
    assert.equal(preview.commit, null); assert.equal(await f.git("rev-parse", "HEAD"), f.expectedParent);
    const candidate = await createRepairCheckpoint({ ...f, execute: true });
    assert.equal(candidate.independentVerification, "pending"); assert.notEqual(candidate.commit, f.expectedParent);
    assert.equal(await f.git("rev-parse", "HEAD^"), f.expectedParent);
    assert.equal(await f.git("status", "--porcelain"), "");
    assert.equal(await f.git("show", "--format=", "--name-only", "HEAD"), "src/index.js");
    const validationReceipt = await f.validate("verify-1", "repair-1");
    const verified = await verifyRepairCheckpoint({ cwd: f.cwd, candidateReceipt: path.relative(f.cwd, candidate.receiptPath!), validationReceipt });
    assert.equal(verified.phase, "source-verified"); assert.equal(verified.commit, candidate.commit);
    assert.match(verified.acceptance, /separately governed/u);
  } finally { await f.cleanup(); }
});

test("unrelated dirty work and a staged shared index are preserved and block automatic commits", async () => {
  const f = await fixture(); try {
    await fs.writeFile(path.join(f.cwd, "unrelated.txt"), "preserve me\n");
    await assert.rejects(createRepairCheckpoint({ ...f, execute: true }), /run-owned/u);
    assert.equal(await fs.readFile(path.join(f.cwd, "unrelated.txt"), "utf8"), "preserve me\n");
    await f.git("add", "--", "unrelated.txt");
    await assert.rejects(createRepairCheckpoint({ ...f, execute: true }), /shared index/u);
    assert.equal(await f.git("diff", "--cached", "--name-only"), "unrelated.txt");
    assert.equal(await f.git("rev-parse", "HEAD"), f.expectedParent);
  } finally { await f.cleanup(); }
});

test("changed source, stale parents, cross-run evidence and missing policy cannot create candidates", async () => {
  const f = await fixture(); try {
    await assert.rejects(createRepairCheckpoint({ ...f, runId: "other", execute: true }), /another run/u);
    await assert.rejects(createRepairCheckpoint({ ...f, expectedParent: "c".repeat(40), execute: true }), /parent changed/u);
    await fs.writeFile(path.join(f.cwd, "src/index.js"), "export const value = 3;\n");
    await assert.rejects(createRepairCheckpoint({ ...f, execute: true }), /changed after validation/u);
    f.project.execution.repair_commits!.enabled = false;
    await assert.rejects(createRepairCheckpoint({ ...f, execute: true }), /not enabled/u);
    assert.equal(await f.git("rev-parse", "HEAD"), f.expectedParent);
  } finally { await f.cleanup(); }
});

test("the repair's own test receipt never substitutes for independent verification", async () => {
  const f = await fixture(); try {
    const candidate = await createRepairCheckpoint({ ...f, execute: true });
    await assert.rejects(verifyRepairCheckpoint({ cwd: f.cwd, candidateReceipt: path.relative(f.cwd, candidate.receiptPath!), validationReceipt: f.validationReceipt }), /Independent verification/u);
    await fs.writeFile(path.join(f.cwd, "src/index.js"), "// A different source revision still requires its own candidate.\nexport const value = 2;\n");
    const newer = await f.validate("verify-1", "repair-1");
    await assert.rejects(verifyRepairCheckpoint({ cwd: f.cwd, candidateReceipt: path.relative(f.cwd, candidate.receiptPath!), validationReceipt: newer }), /does not match/u);
  } finally { await f.cleanup(); }
});

test("atomic branch update preserves a concurrently advanced HEAD without rewriting history", async () => {
  const f = await fixture(); try {
    let concurrent: string | null = null;
    const runner: ProcessRunner = async (argv, options) => {
      if (argv[1] === "update-ref") {
        concurrent = await f.git("commit-tree", await f.git("rev-parse", "HEAD^{tree}"), "-p", f.expectedParent, "-m", "Concurrent owner commit");
        await f.git("update-ref", "HEAD", concurrent, f.expectedParent);
      }
      return runProcess(argv, options);
    };
    await assert.rejects(createRepairCheckpoint({ ...f, execute: true, runner }), /Git operation failed/u);
    assert.ok(concurrent); assert.equal(await f.git("rev-parse", "HEAD"), concurrent);
    assert.equal(await fs.readFile(path.join(f.cwd, "src/index.js"), "utf8"), "export const value = 2;\n");
    const directory = path.join(f.cwd, ".agent-workflow/runtime/repair-checkpoints");
    const prepared = (await fs.readdir(directory)).filter(file => file.endsWith(".prepared.json"));
    assert.equal(prepared.length, 1, "Rejected CAS retains the exact candidate object and evidence");
    const record = JSON.parse(await fs.readFile(path.join(directory, prepared[0]), "utf8"));
    assert.notEqual(record.candidate.commit, concurrent);
    assert.equal(await f.git("show", `${record.candidate.commit}:src/index.js`), "export const value = 2;");
  } finally { await f.cleanup(); }
});

test("independent verification rejects changed original receipts and forged Git tree bindings", async () => {
  const f = await fixture(); try {
    const candidate = await createRepairCheckpoint({ ...f, execute: true });
    const validationReceipt = await f.validate("verify-1", "repair-1");
    const input = { cwd: f.cwd, candidateReceipt: path.relative(f.cwd, candidate.receiptPath!), validationReceipt };
    const originalPath = path.join(f.cwd, f.validationReceipt), original = await fs.readFile(originalPath);
    await fs.chmod(originalPath, 0o600);
    await fs.writeFile(originalPath, Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(verifyRepairCheckpoint(input), /original validation receipt changed/u);
    await fs.writeFile(originalPath, original);
    await fs.chmod(candidate.receiptPath!, 0o600);
    await fs.writeFile(candidate.receiptPath!, JSON.stringify({ ...candidate, tree: "a".repeat(40) }));
    await assert.rejects(verifyRepairCheckpoint(input), /Git tree or parent binding changed/u);
  } finally { await f.cleanup(); }
});

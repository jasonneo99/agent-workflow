import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { branchVerificationReceipt, cleanupIntegratedWorktrees, createBranchWorktrees, integrateVerifiedBranches, planBranchIsolation, predictBranchOverlaps, resolveBranchRuntimePaths } from "./index.js";

const execFileAsync = promisify(execFile);

test("parallel branch planning predicts overlapping files and orders dependencies", () => {
  const items = [
    { stageId: "api", writePaths: ["packages/api"] },
    { stageId: "ui", writePaths: ["apps/web", "packages/api/types.ts"] },
    { stageId: "join", dependsOn: ["api", "ui"], writePaths: ["docs/receipt.md"] }
  ];
  assert.deepEqual(predictBranchOverlaps(items), [{ leftStageId: "api", rightStageId: "ui", paths: ["packages/api"] }]);
  const plan = planBranchIsolation("run-1", items);
  assert.equal(plan.isolated, true);
  assert.deepEqual(plan.mergeOrder, ["api", "ui", "join"]);
  assert.equal(new Set(plan.worktrees.map((item) => item.directoryName)).size, 3);
});

test("runtime worktrees stay outside the primary checkout and use bounded git commands", async () => {
  const plan = planBranchIsolation("run-1", [{ stageId: "api", writePaths: ["packages/api"] }, { stageId: "ui", writePaths: ["apps/web"] }]);
  const runtimes = resolveBranchRuntimePaths("/workspace/project", plan, "/workspace/runtime");
  assert.equal(runtimes.every((item) => item.worktreePath.startsWith("/workspace/runtime/")), true);
  assert.throws(() => resolveBranchRuntimePaths("/workspace/project", plan, "/workspace/project/.agent-workflow/worktrees"), /outside the primary/u);
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runner = async (input: { cwd: string; args: string[] }) => { calls.push(input); return { exitCode: 0, stdout: "", stderr: "" }; };
  const created = await createBranchWorktrees({ projectRoot: "/workspace/project", runtimeRoot: "/workspace/runtime", baseRevision: "abc123", plan, runner });
  assert.equal(created.length, 2);
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["worktree", "add", "-b"]);
});

test("integration and cleanup require verified branches and preserve unmerged work", async () => {
  const plan = planBranchIsolation("run-2", [{ stageId: "api", writePaths: ["packages/api"] }, { stageId: "join", dependsOn: ["api"], writePaths: ["docs/result.md"] }]);
  const receipt = (stageId: string) => branchVerificationReceipt({ runId: "run-2", stageId, baseRevision: "a", resultRevision: `${stageId}-revision`, changedPaths: ["src/file.ts"], commands: [{ command: "npm test", exitCode: 0 }], cleanedUp: false });
  const calls: string[][] = [];
  const runner = async (input: { cwd: string; args: string[] }) => {
    calls.push(input.args);
    const branchName = input.args[1] ?? "";
    const stageId = plan.worktrees.find((item) => item.branchName === branchName)?.stageId;
    return { exitCode: 0, stdout: input.args[0] === "rev-parse" ? `${stageId}-revision\n` : "", stderr: "" };
  };
  await assert.rejects(() => integrateVerifiedBranches({ projectRoot: "/workspace/project", plan, receipts: [receipt("api")], runner }), /join.*passing verification/iu);
  calls.length = 0;
  const merged = await integrateVerifiedBranches({ projectRoot: "/workspace/project", plan, receipts: [receipt("api"), receipt("join")], runner });
  assert.deepEqual(merged, ["api", "join"]);
  assert.equal(calls.filter((args) => args[0] === "merge").every((args) => !args.includes("--force")), true);
  calls.length = 0;
  const runtimes = resolveBranchRuntimePaths("/workspace/project", plan, "/workspace/runtime");
  assert.deepEqual(await cleanupIntegratedWorktrees({ projectRoot: "/workspace/project", runtimes, mergedStageIds: ["api"], runner }), ["api"]);
  assert.equal(calls.some((args) => args[0] === "branch" && args[1] === "-d"), true);
  assert.equal(calls.some((args) => args.includes("-D")), false);
});

test("branch lifecycle creates, verifies, integrates, and cleans real git worktrees", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agentflow-worktrees-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const runtimeRoot = path.join(temporaryRoot, "runtime");
  const git = async (cwd: string, args: string[]) => {
    try {
      const result = await execFileAsync("git", args, { cwd });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
    }
  };
  try {
    await execFileAsync("git", ["init", projectRoot]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.name", "Agent Workflow Test"]);
    await execFileAsync("git", ["-C", projectRoot, "config", "user.email", "test-identity"]);
    await writeFile(path.join(projectRoot, "README.md"), "base\n", "utf8");
    await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", "base"]);
    const baseRevision = (await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"])).stdout.trim();
    const plan = planBranchIsolation("real-run", [{ stageId: "api", writePaths: ["api.txt"] }, { stageId: "ui", writePaths: ["ui.txt"] }]);
    const runtimes = await createBranchWorktrees({ projectRoot, runtimeRoot, baseRevision, plan, runner: (input) => git(input.cwd, input.args) });
    for (const runtime of runtimes) {
      await writeFile(path.join(runtime.worktreePath, `${runtime.stageId}.txt`), `${runtime.stageId}\n`, "utf8");
      await execFileAsync("git", ["-C", runtime.worktreePath, "add", `${runtime.stageId}.txt`]);
      await execFileAsync("git", ["-C", runtime.worktreePath, "commit", "-m", runtime.stageId]);
    }
    const receipts = await Promise.all(runtimes.map(async (runtime) => branchVerificationReceipt({
      runId: "real-run",
      stageId: runtime.stageId,
      baseRevision,
      resultRevision: (await execFileAsync("git", ["-C", runtime.worktreePath, "rev-parse", "HEAD"])).stdout.trim(),
      changedPaths: [`${runtime.stageId}.txt`],
      commands: [{ command: "focused test", exitCode: 0 }],
      cleanedUp: false
    })));
    const merged = await integrateVerifiedBranches({ projectRoot, plan, receipts, runner: (input) => git(input.cwd, input.args) });
    assert.equal(await readFile(path.join(projectRoot, "api.txt"), "utf8"), "api\n");
    assert.equal(await readFile(path.join(projectRoot, "ui.txt"), "utf8"), "ui\n");
    assert.deepEqual(await cleanupIntegratedWorktrees({ projectRoot, runtimes, mergedStageIds: merged, runner: (input) => git(input.cwd, input.args) }), ["api", "ui"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("branch planning rejects path escapes and cyclic dependencies", () => {
  assert.throws(() => planBranchIsolation("run", [{ stageId: "a", writePaths: ["../secret"] }]), /Unsafe branch write path/u);
  assert.throws(() => planBranchIsolation("run", [{ stageId: "a", dependsOn: ["b"], writePaths: ["a"] }, { stageId: "b", dependsOn: ["a"], writePaths: ["b"] }]), /cycle/u);
});

test("branch receipts fail closed without successful verification", () => {
  const failed = branchVerificationReceipt({ runId: "run", stageId: "api", baseRevision: "a", resultRevision: "b", changedPaths: ["src/api.ts"], commands: [], cleanedUp: false });
  assert.equal(failed.passed, false);
  const passed = branchVerificationReceipt({ runId: "run", stageId: "api", baseRevision: "a", resultRevision: "b", changedPaths: ["src/api.ts"], commands: [{ command: "npm test", exitCode: 0 }], cleanedUp: true });
  assert.equal(passed.passed, true);
  assert.match(passed.receiptHash, /^[a-f0-9]{64}$/u);
  assert.equal(branchVerificationReceipt({ runId: "run", stageId: "api", baseRevision: "a", resultRevision: "a", changedPaths: [], commands: [{ command: "npm test", exitCode: 0 }], cleanedUp: false }).passed, false);
});

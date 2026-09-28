import path from "node:path";
import { createHash } from "node:crypto";

export type BranchWorkItem = {
  stageId: string;
  dependsOn?: string[];
  writePaths: string[];
};

export type BranchOverlap = {
  leftStageId: string;
  rightStageId: string;
  paths: string[];
};

export type BranchIsolationPlan = {
  isolated: boolean;
  mergeOrder: string[];
  overlaps: BranchOverlap[];
  worktrees: Array<{ stageId: string; directoryName: string; branchName: string }>;
  reason: string;
};

function normalized(value: string): string {
  const clean = value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!clean || clean === "." || clean.split("/").includes("..") || path.posix.isAbsolute(clean)) throw new Error(`Unsafe branch write path: ${value}`);
  return clean;
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function predictBranchOverlaps(items: BranchWorkItem[]): BranchOverlap[] {
  const result: BranchOverlap[] = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftItem = items[left]!;
      const rightItem = items[right]!;
      const paths = [...new Set(leftItem.writePaths.map(normalized).filter((leftPath) => rightItem.writePaths.map(normalized).some((rightPath) => overlaps(leftPath, rightPath))))].sort();
      if (paths.length) result.push({ leftStageId: leftItem.stageId, rightStageId: rightItem.stageId, paths });
    }
  }
  return result;
}

function topologicalOrder(items: BranchWorkItem[]): string[] {
  const ids = new Set(items.map((item) => item.stageId));
  if (ids.size !== items.length) throw new Error("Branch stage ids must be unique");
  const remaining = new Map(items.map((item) => [item.stageId, new Set(item.dependsOn ?? [])]));
  for (const dependencies of remaining.values()) for (const dependency of dependencies) if (!ids.has(dependency)) throw new Error(`Unknown branch dependency: ${dependency}`);
  const ordered: string[] = [];
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, dependencies]) => [...dependencies].every((dependency) => ordered.includes(dependency))).map(([id]) => id).sort();
    if (!ready.length) throw new Error("Branch dependency graph contains a cycle");
    for (const id of ready) { ordered.push(id); remaining.delete(id); }
  }
  return ordered;
}

export function planBranchIsolation(runId: string, items: BranchWorkItem[]): BranchIsolationPlan {
  for (const item of items) item.writePaths.forEach(normalized);
  const safeRunId = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  const mergeOrder = topologicalOrder(items);
  const branchOverlaps = predictBranchOverlaps(items);
  return {
    isolated: items.length > 1,
    mergeOrder,
    overlaps: branchOverlaps,
    worktrees: mergeOrder.map((stageId) => {
      const safeStageId = createHash("sha256").update(stageId).digest("hex").slice(0, 12);
      return {
        stageId,
        directoryName: `${safeRunId}-${safeStageId}`,
        branchName: `agentflow/${safeRunId}/${safeStageId}`
      };
    }),
    reason: branchOverlaps.length
      ? "Parallel branches require isolation and conflict-aware ordered integration."
      : "Parallel branches may integrate in dependency order after independent verification."
  };
}

export type GitCommandRunner = (input: { cwd: string; args: string[] }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type BranchRuntime = {
  stageId: string;
  branchName: string;
  worktreePath: string;
};

export function resolveBranchRuntimePaths(projectRoot: string, plan: BranchIsolationPlan, runtimeRoot?: string): BranchRuntime[] {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const base = path.resolve(runtimeRoot ?? path.join(path.dirname(resolvedProjectRoot), ".agent-workflow-worktrees", path.basename(resolvedProjectRoot)));
  if (base === resolvedProjectRoot || base.startsWith(`${resolvedProjectRoot}${path.sep}`)) {
    throw new Error("Branch worktree runtime root must be outside the primary project checkout");
  }
  return plan.worktrees.map((item) => ({
    stageId: item.stageId,
    branchName: item.branchName,
    worktreePath: path.join(base, item.directoryName)
  }));
}

async function runGit(runner: GitCommandRunner, cwd: string, args: string[], operation: string): Promise<void> {
  const result = await runner({ cwd, args });
  if (result.exitCode !== 0) throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
}

export async function createBranchWorktrees(input: {
  projectRoot: string;
  baseRevision: string;
  plan: BranchIsolationPlan;
  runner: GitCommandRunner;
  runtimeRoot?: string;
}): Promise<BranchRuntime[]> {
  if (!input.baseRevision.trim()) throw new Error("Branch worktree creation requires an immutable base revision");
  const runtimes = resolveBranchRuntimePaths(input.projectRoot, input.plan, input.runtimeRoot);
  const created: BranchRuntime[] = [];
  try {
    for (const runtime of runtimes) {
      await runGit(input.runner, input.projectRoot, ["worktree", "add", "-b", runtime.branchName, runtime.worktreePath, input.baseRevision], `Create worktree for ${runtime.stageId}`);
      created.push(runtime);
    }
    return runtimes;
  } catch (error) {
    for (const runtime of created.reverse()) {
      await input.runner({ cwd: input.projectRoot, args: ["worktree", "remove", runtime.worktreePath] });
      await input.runner({ cwd: input.projectRoot, args: ["branch", "-D", runtime.branchName] });
    }
    throw error;
  }
}

export async function integrateVerifiedBranches(input: {
  projectRoot: string;
  plan: BranchIsolationPlan;
  receipts: ReturnType<typeof branchVerificationReceipt>[];
  runner: GitCommandRunner;
}): Promise<string[]> {
  const receipts = new Map(input.receipts.map((receipt) => [receipt.stageId, receipt]));
  const merged: string[] = [];
  for (const stageId of input.plan.mergeOrder) {
    const runtime = input.plan.worktrees.find((item) => item.stageId === stageId);
    const receipt = receipts.get(stageId);
    if (!runtime || !receipt?.passed) throw new Error(`Branch ${stageId} cannot integrate without a passing verification receipt`);
    const revision = await input.runner({ cwd: input.projectRoot, args: ["rev-parse", runtime.branchName] });
    if (revision.exitCode !== 0 || revision.stdout.trim() !== receipt.resultRevision) {
      throw new Error(`Branch ${stageId} changed after its verification receipt`);
    }
    await runGit(input.runner, input.projectRoot, ["merge", "--no-ff", "--no-edit", runtime.branchName], `Integrate branch ${stageId}`);
    merged.push(stageId);
  }
  return merged;
}

export async function cleanupIntegratedWorktrees(input: {
  projectRoot: string;
  runtimes: BranchRuntime[];
  mergedStageIds: string[];
  runner: GitCommandRunner;
}): Promise<string[]> {
  const merged = new Set(input.mergedStageIds);
  const cleaned: string[] = [];
  for (const runtime of input.runtimes) {
    if (!merged.has(runtime.stageId)) continue;
    await runGit(input.runner, input.projectRoot, ["worktree", "remove", runtime.worktreePath], `Remove worktree for ${runtime.stageId}`);
    await runGit(input.runner, input.projectRoot, ["branch", "-d", runtime.branchName], `Delete integrated branch ${runtime.stageId}`);
    cleaned.push(runtime.stageId);
  }
  return cleaned;
}

export function branchVerificationReceipt(input: { runId: string; stageId: string; baseRevision: string; resultRevision: string; changedPaths: string[]; commands: Array<{ command: string; exitCode: number }>; cleanedUp: boolean }) {
  const changedPaths = [...new Set(input.changedPaths.map(normalized))].sort();
  const passed = input.baseRevision.trim().length > 0
    && input.resultRevision.trim().length > 0
    && input.baseRevision !== input.resultRevision
    && input.commands.length > 0
    && input.commands.every((item) => Number.isInteger(item.exitCode) && item.exitCode === 0);
  return {
    kind: "agentflow_branch_verification_receipt",
    version: 1,
    runId: input.runId,
    stageId: input.stageId,
    baseRevision: input.baseRevision,
    resultRevision: input.resultRevision,
    changedPaths,
    commands: input.commands,
    passed,
    cleanedUp: input.cleanedUp,
    receiptHash: createHash("sha256").update(JSON.stringify({ ...input, changedPaths })).digest("hex")
  };
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFilePathAllowed } from "../../local-tools/src/file-writer.js";
import { environmentDataHash, runProcess, type EnvironmentEvidence, type EnvironmentPlan, type ProcessRunner, type ProcessResult } from "./index.js";
import type { TestEvidence } from "./evidence.js";

export const REPAIR_COMMIT_COMMAND = "npm run agentflow -- repair-checkpoint *";
export function repairVerifierPolicy(project: ProjectConfig, verifier: boolean): ProjectConfig {
  return verifier && project.execution.repair_commits?.enabled
    ? { ...project, actions: { ...project.actions, allowed_write_paths: [] } } : project;
}
export interface RepairCheckpoint {
  schemaVersion: 1;
  phase: "candidate";
  runId: string;
  parent: string;
  commit: string | null;
  tree: string | null;
  files: string[];
  recipeHash: string;
  sourceHash: string;
  environmentImageId: string | null;
  environmentRuntimeHash: string;
  validationReceipt: string;
  validationReceiptHash: string;
  independentVerification: "pending";
  receiptPath: string | null;
  environmentProfile?: string;
  changeStatus?: 'changed'|'unchanged';
}
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
const validIdentity = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) && !value.includes("..");
const validatePath = (value: string) => value && !path.isAbsolute(value) && !value.includes("\\") && !value.includes("\0") &&
  !value.split("/").some(part => !part || part === "." || part === "..");
export function assertRepairCommitEnabled(project: ProjectConfig): void {
  const blocked = project.actions.blocked_commands.some(pattern => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(REPAIR_COMMIT_COMMAND));
  if (!project.execution.repair_commits?.enabled || !project.actions.allowed_commands.includes(REPAIR_COMMIT_COMMAND) || blocked) throw Error("Repair commits are not enabled by the owning project's exact capability.");
}

async function readOwnedJson(root: string, relative: string, prefix: string) {
  if (!validatePath(relative) || !relative.startsWith(prefix)) throw Error("Checkpoint evidence must be an exact owned runtime receipt.");
  const file = path.join(root, relative), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 2_000_000 || await fs.realpath(file) !== file) throw Error("Checkpoint evidence is not a bounded regular owned file.");
  const body = await fs.readFile(file);
  return { parsed: JSON.parse(body.toString("utf8")), hash: sha(body) };
}
type ValidationReceipt = { plan: EnvironmentPlan; result: ProcessResult & { environment: EnvironmentEvidence; verificationRecipe?: TestEvidence } };
async function validatedSource(root: string, receipt: ValidationReceipt): Promise<void> {
  const result = receipt.result;
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.environment.status !== "ready" ||
      result.environment.cleanup === "failed" || result.verificationRecipe?.status !== "passed" ||
      !/^[a-f0-9]{64}$/u.test(result.environment.runtimeHash ?? "") ||
      !result.verificationRecipe.cases || result.verificationRecipe.passed !== result.verificationRecipe.cases || result.verificationRecipe.skipped !== 0) {
    throw Error("A repair candidate needs executed passing tests with complete collection, zero skips and a ready environment.");
  }
  if (!receipt.plan.sourceFiles?.length || receipt.plan.sourceFiles.length > 20_000 ||
      receipt.plan.sourceHash !== result.environment.sourceHash || receipt.plan.recipeHash !== result.environment.recipeHash ||
      environmentDataHash(receipt.plan.sourceFiles) !== receipt.plan.sourceHash) throw Error("Validation receipt source/environment binding is incomplete.");
  for (const file of receipt.plan.sourceFiles) {
    if (!validatePath(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw Error("Invalid validation source path/hash.");
    const absolute = path.join(root, file.path), stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size !== file.bytes || (stat.mode & 0o111 ? 0o755 : 0o644) !== file.mode || await fs.realpath(absolute) !== absolute || sha(await fs.readFile(absolute)) !== file.sha256) {
      throw Error(`Source changed after validation: ${file.path}`);
    }
  }
}

function gitRunner(root: string, runner: ProcessRunner, env?: Record<string, string>) {
  return async (args: string[], allowFailure = false) => {
    const result = await runner(["git", ...args], { cwd: root, timeoutMs: 30_000, maxOutputChars: 1_000_000, env });
    if (result.timedOut || result.outputTruncated || (!allowFailure && result.exitCode !== 0)) throw Error(`Repair checkpoint Git operation failed: ${result.stderr || result.stdout}`);
    return result;
  };
}

export async function repairCommitBaseline(cwd: string, expectedParent?: string, allowedDirtyFiles: readonly string[] = []): Promise<string> {
  const git = gitRunner(await fs.realpath(cwd), runProcess);
  const parent = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (!validHash(parent) || (expectedParent && parent !== expectedParent)) throw Error("Repair parent changed; its baseline cannot be adopted automatically.");
  if (!expectedParent && (await repairChangedFiles(cwd)).some(file=>!allowedDirtyFiles.includes(file))) throw Error("Automatic repair commits require a clean isolated worktree or exact same-run recorded writes before implementation.");
  return parent;
}

export async function repairChangedFiles(cwd: string): Promise<string[]> {
  const git = gitRunner(await fs.realpath(cwd), runProcess);
  const entries = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean);
  if (entries.some(entry => /R|C/u.test(entry.slice(0, 2)))) throw Error("Repair commits require explicit add/delete paths instead of rename shortcuts.");
  return entries.map(entry => entry.slice(3)).sort();
}

/** Local candidate commits carry evidence, never independent acceptance, push or merge authority. */
export async function createRepairCheckpoint(input: {
  cwd: string; project: ProjectConfig; runId: string; expectedParent: string; files: string[];
  validationReceipt: string; execute?: boolean; message?: string; runner?: ProcessRunner; assertAuthority?: () => Promise<void>;
}): Promise<RepairCheckpoint> {
  assertRepairCommitEnabled(input.project);
  if (!validIdentity(input.runId) || !validHash(input.expectedParent)) throw Error("Repair checkpoint needs a valid run and exact expected parent commit.");
  const root = await fs.realpath(input.cwd), runner = input.runner ?? runProcess, git = gitRunner(root, runner);
  const files = [...new Set(input.files)].sort();
  if (!files.length || files.length > 256) throw Error("A repair commit needs 1–256 exact run-owned files.");
  for (const file of files) { if (!validatePath(file)) throw Error("Repair file path escapes the owning project."); assertFilePathAllowed(file, input.project); }
  const read = await readOwnedJson(root, input.validationReceipt, ".agent-workflow/runtime/run-environments/");
  const validation = read.parsed as ValidationReceipt;
  if (validation.result.environment.runId !== input.runId) throw Error("Validation belongs to another run; its authority cannot be copied.");
  await validatedSource(root, validation);
  const parent = (await git(["rev-parse", "HEAD"])).stdout.trim();
  if (parent !== input.expectedParent) throw Error("Repair parent changed; do not adopt a new baseline automatically.");
  if ((await git(["diff", "--cached", "--name-only", "-z"])).stdout) throw Error("The shared index has staged work; use a clean isolated repair worktree.");
  const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean);
  const changed = status.map(entry => {
    if (/^[RC ]?[RC]/u.test(entry.slice(0, 2))) throw Error("Repair checkpoints require explicit add/delete paths instead of a rename shortcut.");
    return entry.slice(3);
  }).sort();
  if (!changed.length || changed.some(file => !files.includes(file)) || files.some(file => !changed.includes(file))) throw Error("Dirty files are not exactly the run-owned commit scope; use an isolated worktree.");
  for (const file of files) {
    const included = validation.plan.sourceFiles.some(source => source.path === file);
    const declared = [...validation.plan.spec.source_paths, ...validation.plan.spec.dependency_paths].some(source => source === file || file.startsWith(`${source}/`));
    if (!included && (!declared || await fs.lstat(path.join(root, file)).then(() => true, () => false))) throw Error(`Run-owned file has no current validation binding: ${file}`);
  }
  const checkpoint: RepairCheckpoint = { schemaVersion: 1, phase: "candidate", runId: input.runId, parent, commit: null, tree: null, files,
    environmentProfile:validation.plan.profile,changeStatus:'changed',
    recipeHash: validation.plan.recipeHash, sourceHash: validation.plan.sourceHash, environmentImageId: validation.result.environment.imageId,
    environmentRuntimeHash: validation.result.environment.runtimeHash!,
    validationReceipt: input.validationReceipt, validationReceiptHash: read.hash, independentVerification: "pending", receiptPath: null };
  if (!input.execute) return checkpoint;
  await input.assertAuthority?.();
  const runtime = path.join(root, ".agent-workflow", "runtime");
  // The environment writer has already established this exact physical runtime directory.
  if (await fs.realpath(runtime) !== runtime) throw Error("Repair runtime directory is not owned.");
  const directory = path.join(runtime, "repair-checkpoints");
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== directory) throw Error("Repair checkpoint directory is not owned.");
  const operation = randomUUID(), lockPath = path.join(directory, "commit.lock");
  const lock = await fs.open(lockPath, "wx", 0o600).catch(() => { throw Error("Another repair checkpoint owns the project commit fence."); });
  const index = path.join(directory, `${operation}.index`), isolatedGit = gitRunner(root, runner, { GIT_INDEX_FILE: index });
  try {
    await validatedSource(root, validation);
    await isolatedGit(["read-tree", parent]);
    await isolatedGit(["add", "--", ...files]);
    const tree = (await isolatedGit(["write-tree"])).stdout.trim();
    if (!validHash(tree)) throw Error("Git returned an invalid candidate tree.");
    const staged = (await isolatedGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", parent, tree])).stdout.split("\0").filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify(files)) throw Error("Candidate tree changed outside the exact repair scope.");
    await input.assertAuthority?.(); await validatedSource(root, validation);
    const sign = (await git(["config", "--get", "commit.gpgsign"], true)).stdout.trim() === "true";
    const message = `${(input.message ?? "Repair candidate").replace(/[\r\n]/gu, " ").slice(0, 200)}\n\nAgentflow-Run: ${input.runId}\nEnvironment-Recipe: ${checkpoint.recipeHash}\nSource-Snapshot: ${checkpoint.sourceHash}\nValidation-Receipt: ${read.hash}\nIndependent-Verification: pending`;
    const commit = (await isolatedGit(["commit-tree", tree, "-p", parent, ...(sign ? ["-S"] : []), "-m", message])).stdout.trim();
    if (!validHash(commit)) throw Error("Git returned an invalid candidate commit.");
    checkpoint.commit = commit; checkpoint.tree = tree;
    // Preserve the candidate object even if a concurrent owner wins the branch CAS.
    await fs.writeFile(path.join(directory, `${operation}.prepared.json`), `${JSON.stringify({ schemaVersion: 1, phase: "prepared", candidate: checkpoint, recordedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    await input.assertAuthority?.();
    // Compare-and-swap preserves any concurrently advanced branch; no reset or history rewrite.
    await git(["update-ref", "-m", "agentflow repair candidate", "HEAD", commit, parent]);
    await git(["restore", "--staged", "--source", commit, "--", ...files]);
    checkpoint.receiptPath = path.join(directory, `${operation}.json`);
    await fs.writeFile(checkpoint.receiptPath, `${JSON.stringify({ ...checkpoint, recordedAt: new Date().toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o400 });
    return checkpoint;
  } finally {
    await fs.rm(index, { force: true }); await fs.rm(`${index}.lock`, { force: true });
    await lock.close(); await fs.unlink(lockPath);
  }
}

export async function createCurrentRevisionCheckpoint(input:{cwd:string;project:ProjectConfig;runId:string;taskId?:string;validationReceipt:string;assertAuthority:()=>Promise<void>}):Promise<RepairCheckpoint>{
  assertRepairCommitEnabled(input.project);const root=await fs.realpath(input.cwd);
  const read=await readOwnedJson(root,input.validationReceipt,'.agent-workflow/runtime/run-environments/'),validation=read.parsed as ValidationReceipt;
  if(validation.result.environment.runId!==input.runId)throw Error('Current-revision evidence belongs to another run');
  if(input.taskId&&validation.result.environment.taskId!==input.taskId)throw Error('Current-revision evidence belongs to another task');
  await validatedSource(root,validation);await input.assertAuthority();
  const git=gitRunner(root,runProcess);if((await git(['status','--porcelain=v1','--untracked-files=all'])).stdout)throw Error('Current-revision review requires a clean prepared checkout');
  const commit=(await git(['rev-parse','HEAD'])).stdout.trim(),tree=(await git(['rev-parse','HEAD^{tree}'])).stdout.trim(),parent=(await git(['rev-parse','HEAD^'])).stdout.trim();
  const directory=path.join(root,'.agent-workflow/runtime/repair-checkpoints');await fs.mkdir(directory,{recursive:true,mode:0o700});if(await fs.realpath(directory)!==directory)throw Error('Current-revision receipt directory is not owned');
  const receiptPath=path.join(directory,randomUUID()+'.json');
  const checkpoint:RepairCheckpoint={schemaVersion:1,phase:'candidate',runId:input.runId,parent,commit,tree,files:[],environmentProfile:validation.plan.profile,changeStatus:'unchanged',recipeHash:validation.plan.recipeHash,sourceHash:validation.plan.sourceHash,environmentImageId:validation.result.environment.imageId,environmentRuntimeHash:validation.result.environment.runtimeHash!,validationReceipt:input.validationReceipt,validationReceiptHash:read.hash,independentVerification:'pending',receiptPath};
  await input.assertAuthority();await fs.writeFile(receiptPath,JSON.stringify({...checkpoint,recordedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx',mode:0o400});return checkpoint;
}

export async function verifyRepairCheckpoint(input: { cwd: string; candidateReceipt: string; validationReceipt: string; runner?: ProcessRunner }) {
  const root = await fs.realpath(input.cwd);
  const candidate = (await readOwnedJson(root, input.candidateReceipt, ".agent-workflow/runtime/repair-checkpoints/")).parsed as RepairCheckpoint;
  const verification = (await readOwnedJson(root, input.validationReceipt, ".agent-workflow/runtime/run-environments/")).parsed as ValidationReceipt;
  if (!validHash(candidate.commit) || candidate.phase !== "candidate") throw Error("A committed repair candidate is required.");
  await validatedSource(root, verification);
  const originalReceipt = await readOwnedJson(root, candidate.validationReceipt, ".agent-workflow/runtime/run-environments/");
  if (originalReceipt.hash !== candidate.validationReceiptHash) throw Error("The candidate's original validation receipt changed.");
  const original = originalReceipt.parsed as ValidationReceipt;
  if (verification.result.environment.attemptId === original.result.environment.attemptId ||
      (verification.result.environment.runId === original.result.environment.runId && verification.result.environment.taskId === original.result.environment.taskId)) {
    throw Error("Independent verification needs a separate verifier run or task and a fresh environment instance.");
  }
  if (verification.plan.sourceHash !== candidate.sourceHash || verification.plan.recipeHash !== candidate.recipeHash ||
      verification.result.environment.imageId !== candidate.environmentImageId) throw Error("Verifier source or environment does not match the committed candidate.");
  if (verification.result.environment.runtimeHash !== candidate.environmentRuntimeHash) throw Error("Verifier native runtime/image fingerprint does not match the candidate.");
  const git = gitRunner(root, input.runner ?? runProcess);
  if ((await git(["rev-parse", "HEAD"])).stdout.trim() !== candidate.commit || (await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout) {
    throw Error("Verifier checkout must be clean at the exact candidate commit.");
  }
  if ((await git(["rev-parse", "HEAD^{tree}"])).stdout.trim() !== candidate.tree || (await git(["rev-parse", "HEAD^"])).stdout.trim() !== candidate.parent) {
    throw Error("Candidate Git tree or parent binding changed.");
  }
  return { schemaVersion: 1, phase: "source-verified", commit: candidate.commit, tree: candidate.tree, sourceHash: candidate.sourceHash,
    recipeHash: candidate.recipeHash, verifierRunId: verification.result.environment.runId, verifierTaskId: verification.result.environment.taskId,
    validationReceipt: input.validationReceipt, acceptance: "installed/native/product acceptance remains separately governed" };
}

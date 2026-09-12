import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertContextProjectPath } from "../../context-gateway/src/index.js";

export type CodegenPlan = {
  version: 1;
  id: string;
  createdAt: string;
  target: string;
  reference: string;
  referenceHash: string;
  candidateHash: string;
  specHash: string;
  provider: string;
  diff: string;
  candidateFile: string;
  status: "awaiting-review" | "promoted" | "failed";
};

export async function createCodegenPlan(input: { projectRoot: string; target: string; reference: string; referenceContent: string; candidateContent: string; spec: string; provider: string }): Promise<{ plan: CodegenPlan; planPath: string }> {
  const id = randomUUID();
  const directory = path.join(input.projectRoot, ".agent-workflow", "context-gateway", "codegen", id);
  await assertContextProjectPath(input.projectRoot, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const candidateFile = path.join(directory, "candidate.txt");
  await fs.writeFile(candidateFile, input.candidateContent, { mode: 0o600 });
  let current = "";
  try { current = await fs.readFile(path.join(input.projectRoot, input.target), "utf8"); } catch { /* new file */ }
  const plan: CodegenPlan = {
    version: 1, id, createdAt: new Date().toISOString(), target: input.target, reference: input.reference,
    referenceHash: hash(input.referenceContent), candidateHash: hash(input.candidateContent), specHash: hash(input.spec), provider: input.provider,
    diff: compactDiff(current, input.candidateContent), candidateFile: path.relative(input.projectRoot, candidateFile), status: "awaiting-review"
  };
  const planPath = path.join(directory, "plan.json");
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return { plan, planPath };
}

export async function readCodegenPlan(projectRoot: string, id: string): Promise<{ plan: CodegenPlan; candidate: string; planPath: string }> {
  if (!/^[a-f0-9-]{36}$/iu.test(id)) throw new Error("Invalid code-generation plan id.");
  const planPath = path.join(projectRoot, ".agent-workflow", "context-gateway", "codegen", id, "plan.json");
  await assertContextProjectPath(projectRoot, planPath);
  const plan = JSON.parse(await fs.readFile(planPath, "utf8")) as CodegenPlan;
  if (plan.version !== 1 || plan.id !== id || plan.status !== "awaiting-review") throw new Error("Code-generation plan is missing, invalid, or already terminal.");
  const candidatePath = path.join(projectRoot, plan.candidateFile);
  await assertContextProjectPath(projectRoot, candidatePath);
  const candidate = await fs.readFile(candidatePath, "utf8");
  if (hash(candidate) !== plan.candidateHash) throw new Error("Code-generation candidate hash changed after review was prepared.");
  return { plan, candidate, planPath };
}

export async function finishCodegenPlan(input: { planPath: string; plan: CodegenPlan; status: "promoted" | "failed"; reviewedBy: string; validation: string; rollback: string }): Promise<void> {
  await fs.writeFile(input.planPath, `${JSON.stringify({ ...input.plan, status: input.status, completedAt: new Date().toISOString(), reviewedBy: input.reviewedBy, validation: input.validation, rollback: input.rollback }, null, 2)}\n`, { mode: 0o600 });
}

export async function listCodegenPlans(projectRoot: string, limit = 50): Promise<Array<CodegenPlan & { receipt: string }>> {
  const directory = path.join(projectRoot, ".agent-workflow", "context-gateway", "codegen");
  await assertContextProjectPath(projectRoot, directory);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return []; }
  const plans: Array<CodegenPlan & { receipt: string }> = [];
  for (const name of names.sort().reverse()) {
    if (plans.length >= Math.max(1, limit) || !/^[a-f0-9-]{36}$/iu.test(name)) continue;
    const receipt = path.join(directory, name, "plan.json");
    try {
      const plan = JSON.parse(await fs.readFile(receipt, "utf8")) as CodegenPlan;
      if (plan.version === 1 && plan.id === name) plans.push({ ...plan, receipt: path.relative(projectRoot, receipt) });
    } catch { /* ignore malformed local plans */ }
  }
  return plans;
}

function compactDiff(before: string, after: string): string {
  if (before === after) return "No changes.";
  const oldLines = before.split(/\r?\n/u);
  const newLines = after.split(/\r?\n/u);
  const removed = oldLines.filter((line) => !newLines.includes(line)).slice(0, 80).map((line) => `- ${line}`);
  const added = newLines.filter((line) => !oldLines.includes(line)).slice(0, 80).map((line) => `+ ${line}`);
  return [`--- current`, `+++ candidate`, ...removed, ...added].join("\n").slice(0, 20_000);
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

import type { Command } from "commander";
import path from "node:path";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { createRepairCheckpoint, verifyRepairCheckpoint } from "../../../../packages/run-environments/src/repair-checkpoint.js";

export function registerRepairCheckpointCommand(program: Command): void {
  program.command("repair-checkpoint")
    .description("Preview or create an exact repair candidate commit, or check independent source verification")
    .requiredOption("--project <path>", "owning isolated repair project")
    .requiredOption("--evidence <path>", "exact project-relative environment test receipt")
    .option("--run <id>", "authorized repair run")
    .option("--parent <commit>", "exact expected parent commit")
    .option("--files <paths>", "comma-separated exact run-owned changed files")
    .option("--message <subject>", "candidate commit subject")
    .option("--verify <receipt>", "check this candidate receipt against a fresh independent verifier receipt")
    .option("--execute", "create the local candidate commit; omission only previews", false)
    .option("--json", "structured checkpoint evidence", false)
    .action(async (options: { project: string; evidence: string; run?: string; parent?: string; files?: string; message?: string; verify?: string; execute: boolean }) => {
      const cwd = path.resolve(options.project);
      if (options.verify) { console.log(JSON.stringify(await verifyRepairCheckpoint({ cwd, candidateReceipt: options.verify, validationReceipt: options.evidence }), null, 2)); return; }
      if (!options.run || !options.parent || !options.files) throw Error("Candidate checkpoints require --run, --parent and an exact --files list.");
      const project = await loadProjectConfig(cwd);
      console.log(JSON.stringify(await createRepairCheckpoint({ cwd, project, runId: options.run, expectedParent: options.parent,
        files: options.files.split(",").map(file => file.trim()).filter(Boolean), validationReceipt: options.evidence,
        message: options.message, execute: options.execute }), null, 2));
    });
}

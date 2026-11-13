import type { Command } from "commander";
import path from "node:path";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { assertCommandAllowed, executeAllowedCommand } from "../../../../packages/local-tools/src/command-executor.js";
import { planRunEnvironment } from "../../../../packages/run-environments/src/index.js";

export function registerEnvironmentCommands(program: Command): void {
  program.command("environments")
    .description("Preview or execute a frozen per-run container or matching native test environment")
    .requiredOption("--project <path>", "owning project root")
    .requiredOption("--run <id>", "current authorized run identity")
    .option("--profile <name>", "project-declared environment profile; otherwise resolve selectors/default")
    .option("--workflow <id>", "workflow selector")
    .option("--stage <id>", "stage selector")
    .option("--command <command>", "exact project-allowlisted command")
    .option("--reuse-run <id>", "compare the independent verifier's recipe against a prior frozen run")
    .option("--verify", "require a declared complete test collection contract", false)
    .option("--execute", "build, check readiness and execute; omission previews without contacting Docker", false)
    .option("--json", "return structured plan or execution evidence", false)
    .action(async (options: { project: string; run: string; profile?: string; workflow?: string; stage?: string;
      command?: string; reuseRun?: string; verify: boolean; execute: boolean; json: boolean }) => {
      const cwd = path.resolve(options.project), project = await loadProjectConfig(cwd);
      const environmentContext = { runId: options.run, profile: options.profile, workflowId: options.workflow,
        stageId: options.stage, reuseRunId: options.reuseRun, requireVerification: options.verify };
      if (options.command) assertCommandAllowed(options.command, project);
      if (!options.execute) {
        const plan = await planRunEnvironment({ cwd, project, context: environmentContext, commandLine: options.command });
        console.log(JSON.stringify({ preview: true, ...plan }, null, 2)); return;
      }
      if (!options.command) throw Error("Execution requires an exact --command; environment preparation never grants arbitrary command authority.");
      const result = await executeAllowedCommand({ commandLine: options.command, cwd, project, environmentContext });
      console.log(JSON.stringify({ preview: false, ...result }, null, 2));
      if (result.exitCode !== 0 || result.timedOut || result.environment?.status !== "ready" || result.verificationRecipe?.status === "failed") process.exitCode = 1;
    });
}

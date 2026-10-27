import type { Command } from "commander";
import path from "node:path";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { runContainerLifecycle, type ContainerLifecycleAction } from "../../../../packages/local-tools/src/container-lifecycle.js";

const AUTHORIZED_WRAPPER = "npm run agentflow -- containers *";

export function registerContainerCommands(program: Command): void {
  program.command("containers")
    .description("Preview or execute governed lifecycle operations for a project-owned Compose stack")
    .requiredOption("--project <path>", "project root containing .agent-workflow/project.yaml")
    .requiredOption("--action <action>", "start, stop, restart, or status")
    .option("--compose-file <path>", "project-relative Compose file", "compose.yaml")
    .option("--services <names>", "comma-separated service names")
    .option("--execute", "execute after policy and Compose safety validation", false)
    .option("--actor <name>", "requesting actor recorded in receipts", process.env.AGENTFLOW_REQUESTER ?? process.env.USER ?? "cli-user")
    .option("--json", "print JSON", false)
    .action(async (options: { project: string; action: string; composeFile: string; services?: string; execute: boolean; actor: string; json: boolean }) => {
      const action = parseAction(options.action);
      const projectRoot = path.resolve(options.project);
      const config = await loadProjectConfig(projectRoot);
      if (!config.actions.allowed_commands.includes(AUTHORIZED_WRAPPER)) {
        throw new Error(`Container lifecycle is not enabled for this project. Add the exact allowed command: ${AUTHORIZED_WRAPPER}`);
      }
      const result = await runContainerLifecycle({
        projectRoot, composeFile: options.composeFile, action,
        services: options.services?.split(",").map((item) => item.trim()).filter(Boolean),
        execute: options.execute, actor: options.actor
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.preview ? "Preview" : "Executed"}: ${result.action} ${result.services.join(", ") || "all services"}`);
        console.log(`Stack: ${result.composeProject}`);
        console.log(`Compose: ${path.relative(result.projectRoot, result.composeFile)}`);
        console.log(`Command: ${result.command.join(" ")}`);
        if (!result.preview) {
          console.log(`Exit: ${result.exitCode}`);
          console.log(`Receipt: ${path.relative(result.projectRoot, result.receiptPath!)}`);
          if (result.stdout.trim()) console.log(result.stdout.trim());
          if (result.stderr.trim()) console.error(result.stderr.trim());
          if (result.exitCode !== 0) process.exitCode = 1;
        }
      }
    });
}

function parseAction(value: string): ContainerLifecycleAction {
  if (value === "start" || value === "stop" || value === "restart" || value === "status") return value;
  throw new Error(`Unsupported container action: ${value}`);
}

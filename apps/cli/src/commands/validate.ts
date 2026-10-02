import type { Command } from "commander";
import { loadAgents, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { buildBundleManifest, compareBundleManifests, loadCommittedBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";

export function registerValidateCommand(program: Command, rootDir: string): void {
  program
    .command("validate")
    .description("Validate agent cards and workflow definitions")
    .action(async () => {
      const agents = await loadAgents(rootDir);
      const workflows = await loadWorkflows(rootDir);
      const committedManifest = await loadCommittedBundleManifest(rootDir);
      const agentIds = new Set(agents.map((agent) => agent.id));
      const errors: string[] = [];

      for (const workflow of workflows) {
        if (!agentIds.has(workflow.lead)) {
          errors.push(`workflow ${workflow.id} references missing lead agent ${workflow.lead}`);
        }
        for (const stage of workflow.stages) {
          if (!agentIds.has(stage.agent)) {
            errors.push(`workflow ${workflow.id} stage ${stage.id} references missing agent ${stage.agent}`);
          }
          for (const subagent of stage.subagents) {
            if (!agentIds.has(subagent)) {
              errors.push(`workflow ${workflow.id} stage ${stage.id} references missing subagent ${subagent}`);
            }
          }
        }
      }

      if (committedManifest) {
        const currentManifest = await buildBundleManifest(rootDir);
        errors.push(...compareBundleManifests(committedManifest, currentManifest));
      }
      if (errors.length) {
        for (const error of errors) console.error(`ERROR: ${error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Validated ${agents.length} agents and ${workflows.length} workflows.`);
      if (committedManifest) {
        console.log(`Bundle manifest ${committedManifest.bundle.version} checksum ${committedManifest.checksum.value}`);
      }
    });
}

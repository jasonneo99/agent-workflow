import path from "node:path";
import fs from "node:fs/promises";
import type { Command } from "commander";
import YAML from "yaml";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { applyApprovedSegmentedThresholds, decideSegmentedThresholdProposal, readSegmentedThresholdQueue } from "../../../../packages/context-calibration/src/index.js";
import { contextRoutingPolicySchema } from "../../../../packages/context-gateway/src/index.js";
import { findAgentWorkflowRoot } from "../../../../packages/runtime-root/src/index.js";

export function registerContextThresholdCommands(program: Command): void {
  program
    .command("context-thresholds")
    .description("Review, approve, reject, or apply evidence-backed segmented Context Gateway thresholds")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--approve <id>", "approve one proposal")
    .option("--reject <id>", "reject one proposal")
    .option("--apply", "apply approved proposals to the project-local overlay")
    .option("--ids <ids>", "comma-separated approved proposal ids to apply")
    .option("--reviewer <name>", "reviewer identity")
    .option("--note <text>", "decision note")
    .option("--json", "print JSON")
    .action(async (options: { project: string; approve?: string; reject?: string; apply?: boolean; ids?: string; reviewer?: string; note?: string; json?: boolean }) => {
      const projectRoot = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectRoot);
      if (options.approve && options.reject) throw new Error("Choose either --approve or --reject.");
      let result: unknown;
      if (options.approve || options.reject) {
        if (!options.reviewer?.trim()) throw new Error("--reviewer is required for threshold decisions.");
        result = await decideSegmentedThresholdProposal({ projectRoot, proposalId: options.approve ?? options.reject!, decision: options.approve ? "approved" : "rejected", reviewer: options.reviewer, note: options.note });
      } else if (options.apply) {
        result = await applyApprovedSegmentedThresholds({ projectRoot, proposalIds: options.ids?.split(",").map((item) => item.trim()).filter(Boolean), currentPolicy: await loadPolicy(projectRoot) });
      } else {
        result = await readSegmentedThresholdQueue(projectRoot) ?? { version: 1, proposals: [], status: "not-generated" };
      }
      console.log(options.json ? JSON.stringify(result, null, 2) : formatResult(result));
    });
}

async function loadPolicy(projectRoot: string) {
  const local = path.join(projectRoot, ".agent-workflow", "context-routing.yaml");
  try { return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(local, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(path.join(findAgentWorkflowRoot(import.meta.url), "policies", "context-routing.yaml"), "utf8")));
}

function formatResult(value: unknown): string {
  const record = value as { proposals?: Array<{ id: string; status: string; segment: Record<string, string>; changes: unknown[] }>; applied?: string[]; overlay?: string; rollback?: string };
  if (record.applied) return [`Applied ${record.applied.length} approved segmented threshold proposal(s).`, `Overlay: ${record.overlay}`, `Rollback: ${record.rollback}`].join("\n");
  return record.proposals?.length ? record.proposals.map((item) => `${item.id} ${item.status} ${Object.values(item.segment).join("/")} changes=${item.changes.length}`).join("\n") : "No segmented threshold proposals are queued.";
}

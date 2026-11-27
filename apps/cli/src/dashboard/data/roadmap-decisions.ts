import { readDashboardJsonFile } from "../../lib/builders-learning.js";
import path from "node:path";
import type { RoadmapSuggestionDecisionLog } from "../../commands/daemon-types.js";

export async function readRoadmapSuggestionDecisions(projectDir: string): Promise<RoadmapSuggestionDecisionLog> {
  const filePath = path.join(projectDir, ".agent-workflow", "learning", "roadmap-suggestion-decisions.json");
  const result = await readDashboardJsonFile<RoadmapSuggestionDecisionLog>(filePath, (value) =>
    value.kind === "agentflow_roadmap_suggestion_decisions" && Array.isArray(value.decisions)
  );
  return result.value ?? { kind: "agentflow_roadmap_suggestion_decisions", projectRootUri: projectDir, updatedAt: null, decisions: [] };
}

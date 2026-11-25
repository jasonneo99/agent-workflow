import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type RoadmapSuggestion = {
  id: string;
  title: string;
  section: string | null;
  line: number | null;
  source: "unchecked-task" | "learning-evidence";
  priority?: "high" | "medium" | "low";
  rationale?: string;
  evidence?: string[];
  recommendation?: string;
  proposalId?: string;
};

export type RoadmapLearningProposal = {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  rationale: string;
  evidence: string[];
  recommendation: string;
};

export type RoadmapSuggestionReport = {
  kind: "agentflow_roadmap_suggestions";
  projectRootUri: string;
  roadmapPath: string;
  generatedAt: string;
  status: "ready" | "empty" | "missing";
  openItems: number;
  suggestions: RoadmapSuggestion[];
  outcomes: { approved: number; deferred: number; dismissed: number };
  newHighPrioritySuggestions: string[];
  recommendation: string;
};

export async function resolveContainedProjectPath(input: {
  projectRootUri: string;
  relativePath: string;
  label?: string;
}): Promise<string> {
  const label = input.label ?? "path";
  if (path.isAbsolute(input.relativePath)) throw new Error(`${label} must be project-relative: ${input.relativePath}`);
  const projectRoot = path.resolve(input.projectRootUri);
  const resolvedPath = path.resolve(projectRoot, input.relativePath);
  if (resolvedPath !== projectRoot && !resolvedPath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`${label} must remain inside the project: ${input.relativePath}`);
  }

  const canonicalProjectRoot = await fs.realpath(projectRoot);
  let existingPath = resolvedPath;
  while (true) {
    try {
      const stat = await fs.lstat(existingPath);
      let canonicalExistingPath: string;
      try {
        canonicalExistingPath = await fs.realpath(existingPath);
      } catch (error) {
        if (stat.isSymbolicLink()) throw new Error(`${label} cannot use a dangling symbolic link: ${input.relativePath}`);
        throw error;
      }
      const canonicalTarget = path.resolve(canonicalExistingPath, path.relative(existingPath, resolvedPath));
      if (canonicalTarget !== canonicalProjectRoot && !canonicalTarget.startsWith(`${canonicalProjectRoot}${path.sep}`)) {
        throw new Error(`${label} symbolic links must remain inside the project: ${input.relativePath}`);
      }
      return canonicalTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      existingPath = parent;
    }
  }
}

export function buildRoadmapSuggestionReport(input: {
  projectRootUri: string;
  roadmapPath: string;
  markdown?: string;
  generatedAt?: string;
  limit?: number;
  evidenceProposals?: RoadmapLearningProposal[];
  decisions?: Array<{ suggestionId: string; decision: "approved" | "deferred" | "dismissed" }>;
}): RoadmapSuggestionReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const outcomeCounts = (input.decisions ?? []).reduce((counts, item) => ({ ...counts, [item.decision]: counts[item.decision] + 1 }), { approved: 0, deferred: 0, dismissed: 0 });
  if (input.markdown === undefined) {
    return {
      kind: "agentflow_roadmap_suggestions",
      projectRootUri: input.projectRootUri,
      roadmapPath: input.roadmapPath,
      generatedAt,
      status: "missing",
      openItems: 0,
      suggestions: [],
      outcomes: outcomeCounts,
      newHighPrioritySuggestions: [],
      recommendation: `Create or restore ${input.roadmapPath}, then add unchecked Markdown tasks for the daemon to examine.`
    };
  }

  const suggestions: RoadmapSuggestion[] = [];
  let section: string | null = null;
  const limit = Math.max(1, input.limit ?? 10);
  for (const [index, line] of input.markdown.split(/\r?\n/u).entries()) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (heading) section = heading[1].trim();
    const task = line.match(/^\s*[-*+]\s+\[\s\]\s+(.+?)\s*$/iu);
    if (!task) continue;
    const title = task[1].trim();
    if (!title) continue;
    suggestions.push({
      id: `roadmap-${createHash("sha256").update(`${input.roadmapPath}:${index + 1}:${title}`).digest("hex").slice(0, 12)}`,
      title,
      section,
      line: index + 1,
      source: "unchecked-task"
    });
  }

  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const existingTitles = new Set(suggestions.map((item) => normalize(item.title)));
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  const decisionById = new Map((input.decisions ?? []).map((item) => [item.suggestionId, item.decision]));
  const evidenceSuggestions = [...(input.evidenceProposals ?? [])]
    .filter((proposal) => !existingTitles.has(normalize(proposal.title)))
    .filter((proposal) => !["approved", "dismissed"].includes(decisionById.get(`roadmap-evidence-${proposal.id}`) ?? ""))
    .sort((a, b) => Number(decisionById.get(`roadmap-evidence-${a.id}`) === "deferred") - Number(decisionById.get(`roadmap-evidence-${b.id}`) === "deferred") || priorityRank[a.priority] - priorityRank[b.priority] || a.title.localeCompare(b.title))
    .map((proposal): RoadmapSuggestion => ({
      id: `roadmap-evidence-${proposal.id}`,
      proposalId: proposal.id,
      title: proposal.title,
      section: "Evidence-backed daemon proposals",
      line: null,
      source: "learning-evidence",
      priority: proposal.priority,
      rationale: proposal.rationale,
      evidence: proposal.evidence,
      recommendation: proposal.recommendation
    }));
  const selected = [...evidenceSuggestions, ...suggestions].slice(0, limit);
  return {
    kind: "agentflow_roadmap_suggestions",
    projectRootUri: input.projectRootUri,
    roadmapPath: input.roadmapPath,
    generatedAt,
    status: selected.length ? "ready" : "empty",
    openItems: suggestions.length,
    suggestions: selected,
    outcomes: outcomeCounts,
    newHighPrioritySuggestions: [],
    recommendation: selected.length
      ? `Review the ${selected.length} suggested roadmap item(s), including ${Math.min(evidenceSuggestions.length, limit)} evidence-backed daemon proposal(s), and explicitly choose one before starting work.`
      : "Add unchecked Markdown tasks (`- [ ] ...`) to the roadmap when new project work is identified."
  };
}

export function formatRoadmapSuggestionReport(report: RoadmapSuggestionReport): string {
  return [
    "# Roadmap Work Suggestions",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri}`,
    `Roadmap: ${report.roadmapPath}`,
    `Status: ${report.status}`,
    `Open items: ${report.openItems}`,
    "",
    "## Suggested Next Work",
    "",
    ...(report.suggestions.length
      ? report.suggestions.map((item) => `- [ ] ${item.title} (${item.source === "learning-evidence" ? `${item.priority ?? "unranked"} priority, learning evidence ${item.proposalId ?? item.id}` : `${item.section ?? "unsectioned"}, line ${item.line}`})`)
      : ["- No work suggested."]),
    "",
    "## Recommendation",
    "",
    report.recommendation,
    "",
    "> Suggestions are advisory. The daemon does not execute roadmap items or edit the roadmap."
  ].join("\n");
}

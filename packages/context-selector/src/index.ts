import type { AgentCard, ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";

export interface SourceSummary {
  sourceUri: string;
  tokenEstimate: number;
  summary: string;
}

export interface RankedSourceSummary extends SourceSummary {
  score: number;
  matchedTerms: string[];
  selectionReason: string;
}

export function selectRelevantSourceSummaries(input: {
  task: string;
  project: ProjectConfig;
  workflow: WorkflowDefinition;
  agents: AgentCard[];
  summaries: SourceSummary[];
  maxTokens?: number;
  maxFiles?: number;
}): RankedSourceSummary[] {
  const maxTokens = input.maxTokens ?? Math.min(3000, Math.max(1000, Math.floor(input.project.context.max_project_tokens / 3)));
  const maxFiles = input.maxFiles ?? 20;
  const queryTerms = buildQueryTerms(input);

  const ranked = input.summaries
    .map((summary) => scoreSummary(summary, queryTerms))
    .filter((summary) => summary.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.tokenEstimate !== b.tokenEstimate) {
        return a.tokenEstimate - b.tokenEstimate;
      }
      return a.sourceUri.localeCompare(b.sourceUri);
    });

  const selected: RankedSourceSummary[] = [];
  let usedTokens = 0;
  for (const summary of ranked) {
    if (selected.length >= maxFiles) {
      break;
    }
    if (usedTokens + summary.tokenEstimate > maxTokens && selected.length > 0) {
      continue;
    }
    selected.push(summary);
    usedTokens += summary.tokenEstimate;
  }

  return selected;
}

function buildQueryTerms(input: {
  task: string;
  workflow: WorkflowDefinition;
  agents: AgentCard[];
}): Set<string> {
  const corpus = [
    input.task,
    input.workflow.id,
    input.workflow.name,
    input.workflow.description,
    input.workflow.stages.map((stage) => `${stage.id} ${stage.goal} ${stage.agent} ${stage.subagents.join(" ")}`).join(" "),
    input.agents.map((agent) => `${agent.id} ${agent.display_name} ${agent.purpose} ${agent.use_when.join(" ")} ${agent.can.join(" ")}`).join(" ")
  ].join(" ");

  return new Set(tokenize(corpus));
}

function scoreSummary(summary: SourceSummary, queryTerms: Set<string>): RankedSourceSummary {
  const pathTerms = tokenize(summary.sourceUri);
  const summaryTerms = tokenize(summary.summary);
  const matchedTerms = new Set<string>();
  const pathMatches = new Set<string>();
  const summaryMatches = new Set<string>();
  let score = 0;

  for (const term of pathTerms) {
    if (queryTerms.has(term)) {
      matchedTerms.add(term);
      pathMatches.add(term);
      score += 4;
    }
  }

  for (const term of summaryTerms) {
    if (queryTerms.has(term)) {
      matchedTerms.add(term);
      summaryMatches.add(term);
      score += 1;
    }
  }

  const reasons: string[] = [];
  if (pathMatches.size) {
    reasons.push(`path matched ${formatTerms(pathMatches)}`);
  }
  if (summaryMatches.size) {
    reasons.push(`summary matched ${formatTerms(summaryMatches)}`);
  }
  if (summary.sourceUri === "AGENTS.md") {
    score += 2;
    reasons.push("project agent instructions are prioritized");
  }

  return {
    ...summary,
    score,
    matchedTerms: [...matchedTerms].sort(),
    selectionReason: reasons.length ? reasons.join("; ") : "selected by relevance score"
  };
}

function formatTerms(terms: Set<string>): string {
  const values = [...terms].sort().slice(0, 8);
  return values.join(", ");
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

const stopWords = new Set([
  "and",
  "are",
  "for",
  "from",
  "into",
  "not",
  "the",
  "this",
  "that",
  "with",
  "you",
  "your"
]);

import { MemoryGraph, type WalkHit } from "../../storage/src/memory-graph.js";

export interface GraphSelection extends RankedSourceSummary {}

/**
 * Minimum-context selection: walk the memory graph from a seed (goal or
 * task) instead of flat term-matching every source. Hits are scored by graph
 * relevance (type weight decayed by path cost, recency-boosted) with an
 * optional boost for terms overlapping the current task. Superseded (stale)
 * nodes are never selected. Returns selections within the token budget,
 * ordered by score.
 */
export function selectFromMemoryGraph(input: {
  graph: MemoryGraph;
  seedId: string;
  task?: string;
  maxTokens?: number;
  maxNodes?: number;
  maxCost?: number;
}): GraphSelection[] {
  const maxTokens = input.maxTokens ?? 2000;
  const maxNodes = input.maxNodes ?? 10;
  const taskTerms = input.task ? new Set(tokenize(input.task)) : new Set<string>();

  const scored = input.graph
    .walk(input.seedId, input.maxCost ?? 8, maxNodes * 4)
    .map((hit) => scoreGraphHit(hit, input.graph, taskTerms))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.tokenEstimate - b.tokenEstimate;
    });

  const selected: GraphSelection[] = [];
  let usedTokens = 0;
  for (const hit of scored) {
    if (selected.length >= maxNodes) break;
    if (usedTokens + hit.tokenEstimate > maxTokens && selected.length > 0) continue;
    selected.push(hit);
    usedTokens += hit.tokenEstimate;
  }
  return selected;
}

function scoreGraphHit(
  hit: WalkHit,
  graph: MemoryGraph,
  taskTerms: Set<string>
): GraphSelection {
  const base = graph.scoreHit(hit);
  const haystack = new Set(tokenize(`${hit.node.title} ${hit.node.body}`));
  const matched = [...taskTerms].filter((term) => haystack.has(term));
  const boost = taskTerms.size ? 1 + matched.length / taskTerms.size : 1;
  return {
    sourceUri: `memory://node/${hit.node.id}`,
    tokenEstimate: hit.node.tokenEstimate,
    summary: `${hit.node.title}: ${hit.node.body}`.slice(0, 500),
    score: base * boost,
    matchedTerms: matched.sort(),
    selectionReason: `graph walk from seed (${hit.path}); relevance ${base.toFixed(2)}${matched.length ? `, task terms ${matched.sort().join(", ")}` : ""}`
  };
}

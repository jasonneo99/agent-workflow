import fs from "node:fs/promises";
import path from "node:path";

type Variant = { id: string; provider: string; modelTier: string; runs: number; completed: number; averageQuality: number | null; averageLatencyMs: number | null; fallbackRate: number };
type Suite = { id: string; workflowId: string; variants: Variant[]; leader: string | null; latestAt: string };
export type ModelRoutingRecommendation = { tier: string; provider: string; wins: number; runs: number; averageQuality: number; averageLatencyMs: number | null; fallbackRate: number; status: "eligible" | "needs-evidence"; rationale: string };
export type ModelRoutingOptimizerReport = { kind: "agentflow_model_routing_optimizer"; generatedAt: string; projectRootUri: string; autoUpdateEnabled: boolean; suitesCompared: number; recommendations: ModelRoutingRecommendation[]; appliedProviders: Record<string, string>; filesWritten: string[] };
export type ModelComparisonSchedule = { kind: "agentflow_model_comparison_schedule"; enabled: boolean; due: boolean; reason: string; tier: "fast" | "standard" | "reasoning"; providers: string[]; suitePath: string; lastStartedAt: string | null; intervalMs: number };

const markerStart = "<!-- agentflow:model-routing:start -->";
const markerEnd = "<!-- agentflow:model-routing:end -->";

export async function runModelRoutingOptimizer(input: { projectDir: string; suites: Suite[]; autoUpdate: boolean }): Promise<ModelRoutingOptimizerReport> {
  const recommendations = rankComparedProviders(input.suites);
  const eligible = recommendations
    .filter((item) => item.status === "eligible")
    .filter((item, index, all) => all.findIndex((candidate) => candidate.tier === item.tier) === index);
  const appliedProviders = Object.fromEntries(eligible.map((item) => [item.tier, item.provider]));
  const learningDir = path.join(input.projectDir, ".agent-workflow", "learning");
  await fs.mkdir(learningDir, { recursive: true });
  const report: ModelRoutingOptimizerReport = { kind: "agentflow_model_routing_optimizer", generatedAt: new Date().toISOString(), projectRootUri: input.projectDir, autoUpdateEnabled: input.autoUpdate, suitesCompared: input.suites.length, recommendations, appliedProviders: input.autoUpdate ? appliedProviders : {}, filesWritten: [".agent-workflow/learning/model-routing-optimizer.json", ".agent-workflow/learning/model-routing-optimizer.md"] };
  await fs.writeFile(path.join(learningDir, "model-routing-optimizer.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "model-routing-optimizer.md"), formatModelRoutingOptimizerReport(report), "utf8");
  if (input.autoUpdate && eligible.length) {
    const tuningDir = path.join(input.projectDir, ".agent-workflow", "tuning");
    const preferencePath = path.join(tuningDir, "routing-preferences.md");
    await fs.mkdir(tuningDir, { recursive: true });
    const existing = await fs.readFile(preferencePath, "utf8").catch(() => "# Agent Workflow Routing Preference Notes\n");
    const block = [markerStart, "## Daemon Model Routing", "", `- Generated: ${report.generatedAt}`, ...eligible.map((item) => `- Preferred provider ${item.tier}: ${item.provider}`), ...eligible.map((item) => `- Evidence ${item.tier}: wins=${item.wins}, runs=${item.runs}, quality=${item.averageQuality}, fallback=${item.fallbackRate}, latencyMs=${item.averageLatencyMs ?? "n/a"}`), markerEnd].join("\n");
    const next = replaceMarkedBlock(existing, block);
    await fs.writeFile(preferencePath, `${next.trim()}\n`, "utf8");
    report.filesWritten.push(".agent-workflow/tuning/routing-preferences.md");
    await fs.writeFile(path.join(learningDir, "model-routing-optimizer.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

export async function prepareRecurringModelComparison(input: { projectDir: string; enabled: boolean; intervalMs: number; now?: Date; env?: NodeJS.ProcessEnv }): Promise<ModelComparisonSchedule> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const schedulePath = path.join(input.projectDir, ".agent-workflow", "learning", "model-comparison-schedule.json");
  const previous: { lastStartedAt?: string; lastTier?: string } = await fs.readFile(schedulePath, "utf8").then((text) => JSON.parse(text) as { lastStartedAt?: string; lastTier?: string }).catch(() => ({}));
  const tiers = ["fast", "standard", "reasoning"] as const;
  const previousIndex = tiers.indexOf(previous.lastTier as typeof tiers[number]);
  const tier = tiers[(previousIndex + 1) % tiers.length] ?? "fast";
  const providers = [env.OPENAI_API_KEY ? "openai" : null, env.ANTHROPIC_API_KEY ? "anthropic" : null].filter((item): item is string => Boolean(item));
  const lastStartedAt = typeof previous.lastStartedAt === "string" ? previous.lastStartedAt : null;
  const elapsed = lastStartedAt ? now.getTime() - Date.parse(lastStartedAt) : Infinity;
  const due = input.enabled && providers.length >= 2 && elapsed >= input.intervalMs;
  const reason = !input.enabled ? "Recurring comparisons are disabled." : providers.length < 2 ? "At least two ready hosted providers are required." : due ? "The next tier comparison is due." : "The comparison interval has not elapsed.";
  const suiteDir = path.join(input.projectDir, ".agent-workflow", "evaluations");
  const suitePath = path.join(suiteDir, `daemon-model-comparison-${tier}.yaml`);
  await fs.mkdir(path.dirname(schedulePath), { recursive: true });
  if (due) {
    await fs.mkdir(suiteDir, { recursive: true });
    const suite = {
      version: 1,
      id: `daemon-model-comparison-${tier}`,
      name: `Daemon model comparison (${tier})`,
      description: "Bounded recurring provider comparison owned by the Workflow & Model Optimizer daemon.",
      workflow: "provider-smoke",
      cases: [{ id: `${tier}-safe-repository-task`, task: `Analyze a representative ${tier} developer task. Return a concise, structured recommendation with explicit evidence and no commands or file writes.`, expectations: { status: "completed", minimum_average_quality: 0.7, maximum_fallbacks: 0 } }],
      variants: providers.map((provider) => ({ id: `${provider}-${tier}`, provider, model_tier: tier, prompt_suffix: "Preserve correctness, evidence, safety boundaries, and concise output." }))
    };
    await fs.writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
    await fs.writeFile(schedulePath, `${JSON.stringify({ kind: "agentflow_model_comparison_schedule", lastStartedAt: now.toISOString(), lastTier: tier, providers, intervalMs: input.intervalMs, suitePath }, null, 2)}\n`, "utf8");
  }
  return { kind: "agentflow_model_comparison_schedule", enabled: input.enabled, due, reason, tier, providers, suitePath, lastStartedAt, intervalMs: input.intervalMs };
}

export function rankComparedProviders(suites: Suite[]): ModelRoutingRecommendation[] {
  const groups = new Map<string, { provider: string; tier: string; wins: number; runs: number; qualityTotal: number; qualityRuns: number; latencyTotal: number; latencyRuns: number; fallbackTotal: number }>();
  for (const suite of suites) {
    const leader = suite.variants.find((variant) => variant.id === suite.leader);
    if (!leader || leader.averageQuality === null) continue;
    const key = `${leader.modelTier}:${leader.provider}`;
    const group = groups.get(key) ?? { provider: leader.provider, tier: leader.modelTier, wins: 0, runs: 0, qualityTotal: 0, qualityRuns: 0, latencyTotal: 0, latencyRuns: 0, fallbackTotal: 0 };
    group.wins += 1; group.runs += leader.runs; group.qualityTotal += leader.averageQuality * leader.runs; group.qualityRuns += leader.runs; group.fallbackTotal += leader.fallbackRate * leader.runs;
    if (leader.averageLatencyMs !== null) { group.latencyTotal += leader.averageLatencyMs * leader.runs; group.latencyRuns += leader.runs; }
    groups.set(key, group);
  }
  const candidates = [...groups.values()].map((group): ModelRoutingRecommendation => {
    const averageQuality = Number((group.qualityTotal / Math.max(1, group.qualityRuns)).toFixed(3));
    const fallbackRate = Number((group.fallbackTotal / Math.max(1, group.runs)).toFixed(3));
    const averageLatencyMs = group.latencyRuns ? Math.round(group.latencyTotal / group.latencyRuns) : null;
    const eligible = group.wins >= 1 && group.runs >= 2 && averageQuality >= 0.7 && fallbackRate <= 0.1;
    return { tier: group.tier, provider: group.provider, wins: group.wins, runs: group.runs, averageQuality, averageLatencyMs, fallbackRate, status: eligible ? "eligible" : "needs-evidence", rationale: eligible ? "Comparison leader passed minimum sample, quality, and fallback gates." : "Collect more passing comparison evidence before changing routing." };
  });
  return candidates.sort((a, b) => a.tier.localeCompare(b.tier) || Number(b.status === "eligible") - Number(a.status === "eligible") || b.wins - a.wins || b.averageQuality - a.averageQuality || a.fallbackRate - b.fallbackRate || (a.averageLatencyMs ?? Infinity) - (b.averageLatencyMs ?? Infinity));
}

export function formatModelRoutingOptimizerReport(report: ModelRoutingOptimizerReport): string {
  return ["# Model Routing Optimizer", "", `Generated: ${report.generatedAt}`, `Project: ${report.projectRootUri}`, `Automatic preference updates: ${report.autoUpdateEnabled ? "enabled" : "disabled"}`, `Comparison suites: ${report.suitesCompared}`, "", "| Tier | Provider | Status | Wins | Runs | Quality | Fallback | Latency |", "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |", ...report.recommendations.map((item) => `| ${item.tier} | ${item.provider} | ${item.status} | ${item.wins} | ${item.runs} | ${item.averageQuality} | ${item.fallbackRate} | ${item.averageLatencyMs ?? "n/a"} |`), "", report.recommendations.length ? "Routing preferences change only when the evidence gates pass; otherwise the current route remains unchanged." : "No completed provider comparison leaders are available yet."].join("\n");
}

function replaceMarkedBlock(existing: string, block: string): string {
  const start = existing.indexOf(markerStart), end = existing.indexOf(markerEnd);
  if (start >= 0 && end >= start) return `${existing.slice(0, start)}${block}${existing.slice(end + markerEnd.length)}`;
  return `${existing.trim()}\n\n${block}`;
}

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertContextProjectPath, decideContextRoute, estimateContextTokens, extractExactSlices, type ContextIntent, type ContextRoutingPolicy } from "../../context-gateway/src/index.js";

const intent = z.enum(["discovery", "summarization", "documentation", "test_inventory", "editing", "debugging", "concurrency", "security", "authorization", "migration", "public_api", "architecture", "safety_critical", "unknown"]);

export const repositoryHoldoutCorpusSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), file: z.string().min(1), question: z.string().min(1), requiredTerms: z.array(z.string().min(1)).min(1), intent })).min(6)
});

export type RepositoryHoldoutCorpus = z.infer<typeof repositoryHoldoutCorpusSchema>;
export type RepositoryCalibrationCase = {
  id: string; fileHash: string; contentHash: string; intent: ContextIntent; risk: "low" | "medium" | "high"; route: string;
  requiredTermsPresent: boolean; citationsValid: boolean; directTokens: number; routedTokens: number; addedLatencyMs: number;
};
export type RepositoryCalibrationReport = {
  version: 1; corpus: string; corpusHash: string; cases: number; qualityPassRate: number; citationPassRate: number;
  tokenSavingsPercent: number; p95AddedLatencyMs: number; routes: Record<string, number>; risks: Record<string, number>;
  regression: { baselineFound: boolean; qualityDelta: number; citationDelta: number; savingsDelta: number; latencyDeltaMs: number; passed: boolean };
  enforcementReady: boolean;
};

export async function runRepositoryCalibration(input: { projectRoot: string; corpus: RepositoryHoldoutCorpus; corpusRaw: string; policy: ContextRoutingPolicy; baseline?: RepositoryCalibrationReport | null }): Promise<{ report: RepositoryCalibrationReport; cases: RepositoryCalibrationCase[] }> {
  const corpus = repositoryHoldoutCorpusSchema.parse(input.corpus);
  const results: RepositoryCalibrationCase[] = [];
  for (const item of corpus.cases) {
    const target = path.resolve(input.projectRoot, item.file);
    await assertContextProjectPath(input.projectRoot, target);
    const started = performance.now();
    const content = await fs.readFile(target, "utf8");
    const decision = decideContextRoute({ policy: input.policy, intent: item.intent, content, question: item.question });
    const slices = extractExactSlices({ sourcePath: item.file, content, question: item.question, maxSlices: 8 });
    const routeUsesSlices = decision.route === "deterministic" || decision.route === "delegate";
    const routed = routeUsesSlices ? slices.map((slice) => slice.excerpt).join("\n") : content;
    results.push({
      id: item.id, fileHash: hash(item.file), contentHash: hash(content), intent: item.intent, risk: decision.risk, route: decision.route,
      requiredTermsPresent: item.requiredTerms.every((term) => routed.toLowerCase().includes(term.toLowerCase())),
      citationsValid: !routeUsesSlices || (slices.length > 0 && slices.every((slice) => slice.contentHash === hash(content) && slice.startLine > 0 && slice.endLine >= slice.startLine)),
      directTokens: estimateContextTokens(content), routedTokens: estimateContextTokens(routed), addedLatencyMs: Math.ceil(performance.now() - started)
    });
  }
  const direct = results.reduce((sum, item) => sum + item.directTokens, 0);
  const routed = results.reduce((sum, item) => sum + item.routedTokens, 0);
  const qualityPassRate = results.filter((item) => item.requiredTermsPresent).length / results.length;
  const citationPassRate = results.filter((item) => item.citationsValid).length / results.length;
  const tokenSavingsPercent = direct ? round((direct - routed) / direct * 100) : 0;
  const latencies = results.map((item) => item.addedLatencyMs).sort((a, b) => a - b);
  const p95AddedLatencyMs = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * .95) - 1)] ?? 0;
  const routes = count(results.map((item) => item.route));
  const risks = count(results.map((item) => item.risk));
  const baseline = input.baseline ?? null;
  const regression = {
    baselineFound: Boolean(baseline), qualityDelta: round(qualityPassRate - (baseline?.qualityPassRate ?? qualityPassRate)),
    citationDelta: round(citationPassRate - (baseline?.citationPassRate ?? citationPassRate)), savingsDelta: round(tokenSavingsPercent - (baseline?.tokenSavingsPercent ?? tokenSavingsPercent)),
    latencyDeltaMs: p95AddedLatencyMs - (baseline?.p95AddedLatencyMs ?? p95AddedLatencyMs),
    passed: !baseline || (qualityPassRate >= baseline.qualityPassRate && citationPassRate >= baseline.citationPassRate && tokenSavingsPercent >= baseline.tokenSavingsPercent - 5 && p95AddedLatencyMs <= Math.max(30_000, baseline.p95AddedLatencyMs * 1.25))
  };
  const report: RepositoryCalibrationReport = { version: 1, corpus: corpus.name, corpusHash: hash(input.corpusRaw), cases: results.length, qualityPassRate, citationPassRate, tokenSavingsPercent, p95AddedLatencyMs, routes, risks, regression, enforcementReady: qualityPassRate === 1 && citationPassRate === 1 && tokenSavingsPercent >= 30 && p95AddedLatencyMs <= 30_000 && regression.passed };
  return { report, cases: results };
}

export function proposeContextThresholds(report: RepositoryCalibrationReport, policy: ContextRoutingPolicy): { status: "review-required"; changes: Array<{ key: string; current: number; proposed: number; reason: string }> } {
  const changes: Array<{ key: string; current: number; proposed: number; reason: string }> = [];
  if (report.qualityPassRate < 1 || report.citationPassRate < 1) changes.push({ key: "direct_read_max_tokens", current: policy.direct_read_max_tokens, proposed: Math.ceil(policy.direct_read_max_tokens * 1.25), reason: "Expand direct reads until missed terms or citation failures are resolved." });
  else if (report.tokenSavingsPercent < 30) changes.push({ key: "delegation_min_tokens", current: policy.delegation_min_tokens, proposed: Math.max(policy.direct_read_max_tokens + 1, Math.floor(policy.delegation_min_tokens * .8)), reason: "Increase low-risk routing eligibility while preserving the direct-read boundary." });
  return { status: "review-required", changes };
}

export async function writeCalibrationEvidence(input: { projectRoot: string; report: RepositoryCalibrationReport; cases: RepositoryCalibrationCase[]; proposal: ReturnType<typeof proposeContextThresholds> }): Promise<string> {
  const directory = path.join(input.projectRoot, ".agent-workflow", "context-gateway", "calibration");
  await assertContextProjectPath(input.projectRoot, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`);
  await fs.writeFile(target, `${JSON.stringify({ ...input, projectRoot: undefined, version: 1, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export async function readLatestCalibration(projectRoot: string): Promise<RepositoryCalibrationReport | null> {
  const directory = path.join(projectRoot, ".agent-workflow", "context-gateway", "calibration");
  await assertContextProjectPath(projectRoot, directory);
  try {
    const name = (await fs.readdir(directory)).filter((item) => item.endsWith(".json")).sort().at(-1);
    if (!name) return null;
    const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as { report?: RepositoryCalibrationReport };
    return value.report?.version === 1 ? value.report : null;
  } catch { return null; }
}

function count(values: string[]): Record<string, number> { return values.reduce<Record<string, number>>((out, value) => ({ ...out, [value]: (out[value] ?? 0) + 1 }), {}); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function round(value: number): number { return Math.round(value * 1000) / 1000; }

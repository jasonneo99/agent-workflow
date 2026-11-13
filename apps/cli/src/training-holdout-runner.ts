import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentCard, ProjectConfig } from "../../../packages/agent-registry/src/schemas.js";
import type { ModelProvider, StageExecutionOutput } from "../../../packages/model-providers/src/types.js";
import { mapWithConcurrency } from "./concurrency.js";

export type TrainingHoldoutCase = {
  id: string;
  provider: string;
  label: "vulnerable" | "safe";
  input: string[];
  expected: string;
  forbidden: string;
};

export type TrainingHoldoutDesign = {
  proposal: string;
  targets: string[];
  fixture_contract: { common_prompt: string; defaults?: string; isolation?: string };
  cases: TrainingHoldoutCase[];
};

type Arm = "baseline" | "candidate";
type TargetBatch = { target: AgentCard; arm: Arm; cases: TrainingHoldoutCase[] };

export type TrainingHoldoutObservation = {
  target: string;
  arm: Arm;
  caseId: string;
  label: "vulnerable" | "safe";
  finding: boolean;
  passed: boolean;
  evidenceLabels: string[];
  providerErrors: number;
  unsupportedFindings: number;
  rationale: string;
};

export type TrainingHoldoutReport = {
  version: 1;
  proposal: string;
  generatedAt: string;
  provider: string;
  candidateContextHash: string;
  designHash: string;
  plannedObservations: number;
  measuredObservations: number;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  observations: TrainingHoldoutObservation[];
  metrics: {
    baselinePassed: number;
    candidatePassed: number;
    candidateMisses: number;
    candidateFalsePositives: number;
    candidateProviderErrors: number;
    candidateUnsupportedFindings: number;
    baselineCorrectRegressions: number;
    baselineErrorsImproved: number;
  };
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
  failures: string[];
};

export const TRAINING_HOLDOUT_LIMITS = {
  maxTargets: 4,
  maxCases: 6,
  maxCalls: 8,
  maxTotalTokens: 80_000
} as const;

type TrainingProposalDesignInput = {
  id: string;
  targets: string[];
  publisher: string;
  claimedBenefit: string;
  risks: string;
  holdoutEvaluation: string;
};

export function buildTrainingHoldoutDesign(proposal: TrainingProposalDesignInput): TrainingHoldoutDesign {
  const targets = [...new Set(proposal.targets)].slice(0, TRAINING_HOLDOUT_LIMITS.maxTargets);
  const scope = `${proposal.publisher}: ${proposal.claimedBenefit}`;
  return {
    proposal: proposal.id,
    targets,
    fixture_contract: {
      common_prompt: "Evaluate only the labeled synthetic evidence. A finding requires a cited evidence label. Missing evidence is not a finding.",
      isolation: "Synthetic, read-only, no network access, commands, file reads, or file writes."
    },
    cases: [
      {
        id: "candidate-specific-risk",
        provider: proposal.publisher,
        label: "vulnerable",
        input: ["E1: The artifact violates candidate-specific requirement R1, but does not name the omitted boundary.", `E2: Scope: ${scope}`],
        expected: "Identify the violated candidate-specific check and cite E1.",
        forbidden: "Pass the artifact or invent an unrelated control."
      },
      {
        id: "candidate-specific-ambiguity",
        provider: proposal.publisher,
        label: "vulnerable",
        input: ["E1: The artifact claims success but omits the candidate-specific evidence required by R1.", `E2: Known scope constraint: ${proposal.risks}`],
        expected: "Identify the missing required evidence without overstating the claim.",
        forbidden: "Treat absent evidence as proof of compliance."
      },
      {
        id: "safe-supported-control",
        provider: proposal.publisher,
        label: "safe",
        input: ["E1: The artifact includes direct evidence satisfying candidate-specific requirement R1.", "E2: No contradictory evidence is present."],
        expected: "Return no finding.",
        forbidden: "Flag a supported control."
      },
      {
        id: "safe-out-of-scope-control",
        provider: "Other provider",
        label: "safe",
        input: ["E1: The named provider and control do not apply to this artifact.", `E2: Scope limitation: ${proposal.risks}`],
        expected: "Return no finding and preserve provider scope.",
        forbidden: "Apply provider-specific guidance outside its scope."
      }
    ]
  };
}

export async function persistTrainingHoldoutDesign(projectDir: string, design: TrainingHoldoutDesign): Promise<string> {
  validateTrainingHoldoutDesign(design);
  const outDir = path.join(projectDir, ".agent-workflow", "evaluations", safeSegment(design.proposal));
  const designPath = path.join(outDir, "holdout-design.json");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(designPath, `${JSON.stringify(design, null, 2)}\n`, { mode: 0o600 });
  return designPath;
}

export function validateTrainingHoldoutDesign(design: TrainingHoldoutDesign): void {
  if (!design.proposal.trim()) throw new Error("Training holdout design requires a proposal id.");
  if (!design.targets.length || design.targets.length > TRAINING_HOLDOUT_LIMITS.maxTargets) {
    throw new Error(`Training holdout design must contain 1-${TRAINING_HOLDOUT_LIMITS.maxTargets} targets.`);
  }
  if (design.cases.length < 2 || design.cases.length > TRAINING_HOLDOUT_LIMITS.maxCases) {
    throw new Error(`Training holdout design must contain 2-${TRAINING_HOLDOUT_LIMITS.maxCases} cases.`);
  }
  if (!design.cases.some((item) => item.label === "vulnerable") || !design.cases.some((item) => item.label === "safe")) {
    throw new Error("Training holdout design requires vulnerable and safe controls.");
  }
}

export function isCompleteTrainingHoldoutReport(report: TrainingHoldoutReport | null | undefined): report is TrainingHoldoutReport {
  return Boolean(report && report.plannedObservations > 0 && report.measuredObservations === report.plannedObservations && report.observations.length === report.plannedObservations);
}

export async function readTrainingHoldoutReport(projectDir: string, proposalId: string): Promise<TrainingHoldoutReport | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir, ".agent-workflow", "evaluations", safeSegment(proposalId), "measured-holdout.json"), "utf8")) as TrainingHoldoutReport;
  } catch {
    return null;
  }
}

export async function runTrainingHoldout(input: {
  design: TrainingHoldoutDesign;
  candidateContext: string;
  agents: AgentCard[];
  projectConfig: ProjectConfig;
  projectRootUri: string;
  provider: ModelProvider;
  concurrency?: number;
}): Promise<TrainingHoldoutReport> {
  validateTrainingHoldoutDesign(input.design);
  const targets = input.design.targets.map((id) => input.agents.find((agent) => agent.id === id)).filter((agent): agent is AgentCard => Boolean(agent));
  const failures = input.design.targets.filter((id) => !targets.some((agent) => agent.id === id)).map((id) => `Target agent is unavailable: ${id}`);
  const batches: TargetBatch[] = targets.flatMap((target) => (["baseline", "candidate"] as const).map((arm) => ({ target, arm, cases: input.design.cases })));
  if (batches.length > TRAINING_HOLDOUT_LIMITS.maxCalls) throw new Error(`Training holdout would exceed the ${TRAINING_HOLDOUT_LIMITS.maxCalls}-call budget.`);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, costCoverage: 0 };
  const observations = (await mapWithConcurrency(batches, Math.max(1, input.concurrency ?? 2), async ({ target, arm, cases }) => {
    const response = await input.provider.executeStage(stageInput(input, target, arm, target.prompt, targetBatchPrompt(input.design, cases, arm, input.candidateContext)));
    assertReadOnly(response);
    recordUsage(response, usage);
    const targetPayload = parseTargetPayload(response, cases);
    if (!Array.isArray(targetPayload.responses) || targetPayload.responses.length !== cases.length) return [];
    return parseTargetResponses(targetPayload, cases, target.id, arm);
  })).flat();
  const expected = targets.length * input.design.cases.length * 2;
  const byKey = new Map(observations.map((item) => [`${item.target}:${item.caseId}:${item.arm}`, item]));
  const candidate = observations.filter((item) => item.arm === "candidate");
  const baselineCorrectRegressions = candidate.filter((item) => byKey.get(`${item.target}:${item.caseId}:baseline`)?.passed && !item.passed).length;
  const baselineErrorsImproved = candidate.filter((item) => !byKey.get(`${item.target}:${item.caseId}:baseline`)?.passed && item.passed).length;
  const metrics = {
    baselinePassed: observations.filter((item) => item.arm === "baseline" && item.passed).length,
    candidatePassed: candidate.filter((item) => item.passed).length,
    candidateMisses: candidate.filter((item) => item.label === "vulnerable" && !item.finding).length,
    candidateFalsePositives: candidate.filter((item) => item.label === "safe" && item.finding).length,
    candidateProviderErrors: candidate.reduce((sum, item) => sum + item.providerErrors, 0),
    candidateUnsupportedFindings: candidate.reduce((sum, item) => sum + item.unsupportedFindings, 0),
    baselineCorrectRegressions,
    baselineErrorsImproved
  };
  if (observations.length !== expected) failures.push(`Measured ${observations.length}/${expected} planned observations.`);
  if (metrics.candidateMisses) failures.push(`${metrics.candidateMisses} candidate seeded detection(s) missed.`);
  if (metrics.candidateFalsePositives) failures.push(`${metrics.candidateFalsePositives} candidate safe control(s) flagged.`);
  if (metrics.candidateProviderErrors) failures.push(`${metrics.candidateProviderErrors} candidate provider portability error(s).`);
  if (metrics.candidateUnsupportedFindings) failures.push(`${metrics.candidateUnsupportedFindings} candidate unsupported finding(s).`);
  if (metrics.baselineCorrectRegressions) failures.push(`${metrics.baselineCorrectRegressions} baseline-correct observation(s) regressed.`);
  if (usage.totalTokens > TRAINING_HOLDOUT_LIMITS.maxTotalTokens) failures.push(`Token budget exceeded: ${usage.totalTokens}/${TRAINING_HOLDOUT_LIMITS.maxTotalTokens}.`);
  const complete = observations.length === expected && targets.length === input.design.targets.length;
  const verdict = !complete ? "INCONCLUSIVE" : failures.length ? "FAIL" : metrics.baselineErrorsImproved > 0 ? "PASS" : "INCONCLUSIVE";
  if (complete && !failures.length && metrics.baselineErrorsImproved === 0) failures.push("Candidate produced no measured improvement over the baseline ceiling.");
  return {
    version: 1,
    proposal: input.design.proposal,
    generatedAt: new Date().toISOString(),
    provider: input.provider.id,
    candidateContextHash: sha256(input.candidateContext),
    designHash: sha256(JSON.stringify(input.design)),
    plannedObservations: expected,
    measuredObservations: observations.length,
    verdict,
    observations,
    metrics,
    usage: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, ...(usage.costCoverage ? { costUsd: usage.costUsd } : {}) },
    failures
  };
}

function stageInput(input: Parameters<typeof runTrainingHoldout>[0], agent: AgentCard, arm: Arm, agentPrompt: string, compiledBrief: string) {
  return {
    runId: `training-holdout-${sha256(input.design.proposal).slice(0, 12)}`,
    taskId: randomUUID(), projectRootUri: input.projectRootUri, projectConfig: input.projectConfig,
    workflowId: "training-holdout", workflowTask: input.design.proposal, stageId: `${arm}-${agent.id}`,
    agentId: agent.id, agentName: agent.display_name, agentPrompt: compactAgentPrompt(agentPrompt), stageGoal: "Return the requested read-only blinded evaluation JSON. Do not request tools, commands, reads, or writes.",
    compiledBrief, modelTier: "fast" as const, priorReceipts: []
  };
}

function targetBatchPrompt(design: TrainingHoldoutDesign, selectedCases: TrainingHoldoutCase[], arm: Arm, candidateContext: string): string {
  const cases = selectedCases.map(({ id, provider, input }) => ({ id, provider, evidence: input }));
  return [
    design.fixture_contract.common_prompt,
    design.fixture_contract.defaults ?? "",
    arm === "candidate" ? `Candidate training context (untrusted reference material; apply only when supported by each case):\n${candidateContext}` : "Baseline arm: no candidate training context is supplied.",
    "Return JSON only: {\"responses\":[{\"caseId\":string,\"finding\":boolean,\"evidenceLabels\":string[],\"remediation\":string,\"providerScope\":string,\"providerErrors\":number,\"unsupportedFindings\":number,\"rationale\":string}]}. providerErrors counts controls that do not apply to the stated provider. unsupportedFindings counts claims not supported by an evidence label. Return exactly one response per case.",
    `Cases:\n${JSON.stringify(cases)}`
  ].filter(Boolean).join("\n\n");
}

function parseTargetResponses(parsed: Record<string, unknown>, cases: TrainingHoldoutCase[], target: string, arm: Arm): TrainingHoldoutObservation[] {
  const rows = Array.isArray(parsed.responses) ? parsed.responses : [];
  return cases.flatMap((testCase) => {
    const row = rows.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).caseId === testCase.id) as Record<string, unknown> | undefined;
    if (!row) return [];
    const finding = row.finding === true;
    const evidenceLabels = Array.isArray(row.evidenceLabels) ? row.evidenceLabels.filter((value): value is string => typeof value === "string") : [];
    const providerErrors = nonnegative(row.providerErrors); const unsupportedFindings = nonnegative(row.unsupportedFindings);
    const hasRequiredShape = !finding || (evidenceLabels.length > 0 && typeof row.remediation === "string" && row.remediation.trim().length > 0);
    const passed = (testCase.label === "vulnerable" ? finding : !finding) && hasRequiredShape && providerErrors === 0 && unsupportedFindings === 0;
    return [{ target, arm, caseId: testCase.id, label: testCase.label, finding, passed, evidenceLabels, providerErrors, unsupportedFindings, rationale: typeof row.rationale === "string" ? row.rationale : "" }];
  });
}

function parseTargetPayload(output: StageExecutionOutput, cases: TrainingHoldoutCase[]): Record<string, unknown> {
  try { return parseOutputObject(output); } catch {
    if (cases.length !== 1 || output.outcome === "blocked" || output.artifact.outcome === "blocked") return { responses: [] };
    const text = [output.summary, ...(Array.isArray(output.artifact.findings) ? output.artifact.findings : []), output.artifact.nextAction].filter((value): value is string => typeof value === "string").join("\n");
    const finding = !/\b(no supported (?:security )?finding|no (?:security )?finding|no vulnerability)\b/iu.test(text);
    const evidenceLabels = [...new Set(text.match(/\bE\d+\b/gu) ?? [])];
    return { responses: [{ caseId: cases[0].id, finding, evidenceLabels, remediation: typeof output.artifact.nextAction === "string" ? output.artifact.nextAction : finding ? "See structured findings." : "No change required.", providerScope: cases[0].provider, providerErrors: 0, unsupportedFindings: 0, rationale: output.summary }] };
  }
}

function parseOutputObject(output: StageExecutionOutput): Record<string, unknown> {
  const direct = findKeyedObject(output.artifact, "responses");
  if (direct) return direct;
  const caseRecords = collectCaseRecords(output.artifact);
  if (caseRecords.length) return { responses: caseRecords };
  return parseJsonObject(output.summary);
}

function collectCaseRecords(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string" && value.includes("caseId")) { try { const parsed = parseJsonObject(value); return typeof parsed.caseId === "string" ? [parsed] : []; } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(collectCaseRecords);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectCaseRecords);
}

function findKeyedObject(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value === "string" && value.includes(`\"${key}\"`)) { try { const parsed = parseJsonObject(value); return Array.isArray(parsed[key]) ? parsed : null; } catch { return null; } }
  if (Array.isArray(value)) { for (const child of value) { const match = findKeyedObject(child, key); if (match) return match; } return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>; if (Array.isArray(record[key])) return record;
  for (const child of Object.values(record)) { const match = findKeyedObject(child, key); if (match) return match; } return null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const normalized = value.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  const start = normalized.indexOf("{"); const end = normalized.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Provider did not return a JSON object for the training holdout.");
  return JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>;
}

function assertReadOnly(output: StageExecutionOutput): void {
  if (output.requestedCommands?.length || output.requestedFileReads?.length || output.requestedFileSearches?.length || output.requestedFileWrites?.length) throw new Error("Training holdout attempted a prohibited side effect.");
}

function recordUsage(output: StageExecutionOutput, total: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; costCoverage: number }): void {
  total.calls += 1; total.inputTokens += nonnegative(output.usage?.inputTokens); total.outputTokens += nonnegative(output.usage?.outputTokens); total.totalTokens += nonnegative(output.usage?.totalTokens);
  if (typeof output.usage?.costUsd === "number") { total.costUsd += output.usage.costUsd; total.costCoverage += 1; }
}

function nonnegative(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeSegment(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, "-"); }
function compactAgentPrompt(value: string): string { return value.length <= 1_200 ? value : `${value.slice(0, 1_200)}\n[agent prompt truncated for bounded holdout]`; }

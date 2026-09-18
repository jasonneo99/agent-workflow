import crypto from "node:crypto";

export type ReuseRecommendation = "reuse-result" | "resume-from-stage" | "run-fresh";

export interface ReuseFingerprintInput {
  task: string;
  workflowId: string;
  workflowHash: string;
  policySnapshotHash: string;
  selectedSources: Array<{ sourceUri: string; contentHash: string | null }>;
}

export interface ReuseFingerprint {
  version: 1;
  taskIntentHash: string;
  workflowId: string;
  workflowHash: string;
  policySnapshotHash: string;
  projectStateHash: string;
  fingerprint: string;
}

export interface ReuseCandidate {
  runId: string;
  task: string;
  workflowId: string;
  workflowHash: string;
  policySnapshotHash: string;
  selectedSources: Array<{ sourceUri: string; contentHash: string | null }>;
  completedStages: string[];
  totalStages: number;
  startedAt: string;
  finishedAt: string;
  compiledBriefTokens?: number;
  modelLatencyMs?: number;
  estimatedCostUsd?: number;
  summary?: string;
}

export interface ReuseMemoryCandidate {
  sourceUri: string;
  summary: string;
  kind: string;
  updatedAt: string;
}

export interface RankedReuseCandidate {
  runId: string;
  recommendation: ReuseRecommendation;
  requiresApproval: boolean;
  taskSimilarity: number;
  exactFingerprint: boolean;
  evidenceCurrent: boolean;
  staleReasons: string[];
  resumeAfterStage: string | null;
  summary: string | null;
  projectedSavings: {
    stages: number;
    tokens: number;
    latencyMs: number;
    costUsd: number | null;
  };
}

export interface RankedMemoryCandidate extends ReuseMemoryCandidate {
  similarity: number;
}

export interface GovernedReusePlan {
  version: 1;
  generatedAt: string;
  fingerprint: ReuseFingerprint;
  recommendation: ReuseRecommendation;
  requiresApproval: boolean;
  candidates: RankedReuseCandidate[];
  memory: RankedMemoryCandidate[];
  guardrails: string[];
}

export function buildReuseFingerprint(input: ReuseFingerprintInput): ReuseFingerprint {
  const taskIntentHash = sha256(normalizeIntent(input.task));
  const projectStateHash = hashProjectState(input.selectedSources);
  const canonical = {
    version: 1 as const,
    taskIntentHash,
    workflowId: input.workflowId,
    workflowHash: input.workflowHash,
    policySnapshotHash: input.policySnapshotHash,
    projectStateHash
  };
  return { ...canonical, fingerprint: sha256(stableJson(canonical)) };
}

export function buildGovernedReusePlan(input: {
  target: ReuseFingerprintInput;
  candidates: ReuseCandidate[];
  memory?: ReuseMemoryCandidate[];
  maxCandidates?: number;
  maxMemory?: number;
}): GovernedReusePlan {
  const fingerprint = buildReuseFingerprint(input.target);
  const candidates = input.candidates
    .map((candidate) => rankCandidate(input.target, fingerprint, candidate))
    .filter((candidate) => candidate.taskSimilarity >= 0.35 || candidate.exactFingerprint)
    .sort(compareRankedCandidates)
    .slice(0, input.maxCandidates ?? 5);
  const memory = (input.memory ?? [])
    .map((candidate) => ({ ...candidate, similarity: semanticSimilarity(input.target.task, candidate.summary) }))
    .filter((candidate) => candidate.similarity >= 0.28)
    .sort((left, right) => right.similarity - left.similarity || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, input.maxMemory ?? 5);
  const best = candidates[0];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    fingerprint,
    recommendation: best?.recommendation ?? "run-fresh",
    requiresApproval: best?.requiresApproval ?? false,
    candidates,
    memory,
    guardrails: [
      "Reuse and checkpoint continuation require an explicit operator decision.",
      "Policy, workflow, and selected-source hashes must still match before execution.",
      "Stale or low-similarity evidence may inform a fresh run but cannot skip stages.",
      "Every accepted reuse decision must record source run, hashes, and measured savings."
    ]
  };
}

export function semanticSimilarity(left: string, right: string): number {
  const leftVector = semanticVector(left);
  const rightVector = semanticVector(right);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < leftVector.length; index += 1) {
    dot += leftVector[index] * rightVector[index];
    leftNorm += leftVector[index] ** 2;
    rightNorm += rightVector[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return 0;
  return Number((dot / Math.sqrt(leftNorm * rightNorm)).toFixed(4));
}

function rankCandidate(target: ReuseFingerprintInput, fingerprint: ReuseFingerprint, candidate: ReuseCandidate): RankedReuseCandidate {
  const candidateFingerprint = buildReuseFingerprint({
    task: candidate.task,
    workflowId: candidate.workflowId,
    workflowHash: candidate.workflowHash,
    policySnapshotHash: candidate.policySnapshotHash,
    selectedSources: candidate.selectedSources
  });
  const staleReasons: string[] = [];
  if (candidate.workflowId !== target.workflowId || candidate.workflowHash !== target.workflowHash) staleReasons.push("workflow definition changed");
  if (candidate.policySnapshotHash !== target.policySnapshotHash) staleReasons.push("policy snapshot changed");
  if (candidateFingerprint.projectStateHash !== fingerprint.projectStateHash) staleReasons.push("selected source evidence changed");
  const evidenceCurrent = staleReasons.length === 0;
  const exactFingerprint = candidateFingerprint.fingerprint === fingerprint.fingerprint;
  const taskSimilarity = semanticSimilarity(target.task, candidate.task);
  const allStagesCompleted = candidate.totalStages > 0 && candidate.completedStages.length >= candidate.totalStages;
  const recommendation: ReuseRecommendation = exactFingerprint && evidenceCurrent && allStagesCompleted
    ? "reuse-result"
    : exactFingerprint && evidenceCurrent && candidate.completedStages.length > 0
      ? "resume-from-stage"
      : "run-fresh";
  const reusableStages = recommendation === "run-fresh" ? 0 : candidate.completedStages.length;
  const share = candidate.totalStages > 0 ? reusableStages / candidate.totalStages : 0;
  return {
    runId: candidate.runId,
    recommendation,
    requiresApproval: recommendation !== "run-fresh",
    taskSimilarity,
    exactFingerprint,
    evidenceCurrent,
    staleReasons,
    resumeAfterStage: recommendation === "resume-from-stage" ? candidate.completedStages.at(-1) ?? null : null,
    summary: candidate.summary?.trim() || null,
    projectedSavings: {
      stages: reusableStages,
      tokens: Math.round((candidate.compiledBriefTokens ?? 0) * share),
      latencyMs: Math.round((candidate.modelLatencyMs ?? elapsedMs(candidate.startedAt, candidate.finishedAt)) * share),
      costUsd: candidate.estimatedCostUsd === undefined
        ? null
        : Number((candidate.estimatedCostUsd * share).toFixed(8))
    }
  };
}

function compareRankedCandidates(left: RankedReuseCandidate, right: RankedReuseCandidate): number {
  const priority: Record<ReuseRecommendation, number> = { "reuse-result": 3, "resume-from-stage": 2, "run-fresh": 1 };
  return priority[right.recommendation] - priority[left.recommendation]
    || Number(right.evidenceCurrent) - Number(left.evidenceCurrent)
    || right.taskSimilarity - left.taskSimilarity;
}

function hashProjectState(sources: Array<{ sourceUri: string; contentHash: string | null }>): string {
  const canonical = sources
    .map((source) => ({ sourceUri: source.sourceUri, contentHash: source.contentHash ?? "missing" }))
    .sort((left, right) => left.sourceUri.localeCompare(right.sourceUri));
  return sha256(stableJson(canonical));
}

function normalizeIntent(value: string): string {
  const replacements: Record<string, string> = {
    build: "implement", create: "implement", develop: "implement", add: "implement",
    repair: "fix", resolve: "fix", correct: "fix",
    inspect: "review", audit: "review", assess: "review",
    tests: "test", testing: "test", tested: "test"
  };
  return tokenize(value).map((token) => replacements[token] ?? token).sort().join(" ");
}

function semanticVector(value: string): Float64Array {
  const vector = new Float64Array(256);
  const tokens = tokenize(value).map((token) => ({ token, normalized: normalizeToken(token) }));
  for (const { token, normalized } of tokens) {
    addFeature(vector, normalized, 1);
    if (token !== normalized) addFeature(vector, token, 0.35);
    for (let index = 0; index < Math.max(0, normalized.length - 2); index += 1) addFeature(vector, normalized.slice(index, index + 3), 0.15);
  }
  return vector;
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const digest = crypto.createHash("sha256").update(feature).digest();
  const index = digest.readUInt16BE(0) % vector.length;
  vector[index] += digest[2] % 2 ? weight : -weight;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/gu) ?? [];
}

function normalizeToken(token: string): string {
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

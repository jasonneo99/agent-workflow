import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const intentSchema = z.enum([
  "discovery", "summarization", "documentation", "test_inventory", "editing",
  "debugging", "concurrency", "security", "authorization", "migration",
  "public_api", "architecture", "safety_critical", "unknown"
]);

export const contextRoutingPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["shadow", "advisory", "enforce"]),
  direct_read_max_tokens: z.number().int().positive(),
  delegation_min_tokens: z.number().int().positive(),
  max_exact_slice_tokens: z.number().int().positive(),
  summary_cache_ttl_seconds: z.number().int().positive(),
  low_risk_intents: z.array(intentSchema),
  frontier_required_intents: z.array(intentSchema),
  deterministic_extractors: z.array(z.enum(["git_diff", "text_match", "symbols", "imports", "signatures", "config_keys", "test_names"])),
  telemetry: z.object({
    store_file_bodies: z.literal(false),
    hash_source_paths: z.boolean(),
    record_project_id: z.boolean(),
    record_content_hash: z.boolean()
  })
}).superRefine((policy, ctx) => {
  if (policy.delegation_min_tokens <= policy.direct_read_max_tokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delegation_min_tokens must exceed direct_read_max_tokens" });
  }
});

export type ContextIntent = z.infer<typeof intentSchema>;
export type ContextRoutingPolicy = z.infer<typeof contextRoutingPolicySchema>;

export type ContextRoute = "direct" | "deterministic" | "delegate" | "frontier";

export type ContextRouteDecision = {
  route: ContextRoute;
  enforced: boolean;
  estimatedTokens: number;
  risk: "low" | "medium" | "high";
  reasons: string[];
};

export function estimateContextTokens(content: string): number {
  if (!content) return 0;
  const ascii = content.replace(/[^\x00-\x7F]/gu, "").length;
  const nonAscii = content.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 2);
}

export function decideContextRoute(input: {
  policy: ContextRoutingPolicy;
  intent: ContextIntent;
  content: string;
  question?: string;
}): ContextRouteDecision {
  const policy = contextRoutingPolicySchema.parse(input.policy);
  const estimatedTokens = estimateContextTokens(input.content);
  const frontierRequired = policy.frontier_required_intents.includes(input.intent);
  const lowRisk = policy.low_risk_intents.includes(input.intent);
  const hasTarget = Boolean(input.question?.trim());
  let route: ContextRoute;
  const reasons: string[] = [];
  if (frontierRequired) {
    route = "frontier";
    reasons.push(`intent ${input.intent} requires exact frontier-model evidence`);
  } else if (estimatedTokens <= policy.direct_read_max_tokens) {
    route = "direct";
    reasons.push(`estimated input is within the ${policy.direct_read_max_tokens}-token direct-read budget`);
  } else if (hasTarget) {
    route = "deterministic";
    reasons.push("a targeted question should try deterministic extraction before model delegation");
  } else if (lowRisk && estimatedTokens >= policy.delegation_min_tokens) {
    route = "delegate";
    reasons.push(`low-risk input exceeds the ${policy.delegation_min_tokens}-token delegation threshold`);
  } else {
    route = "frontier";
    reasons.push("intent or input size is not eligible for automatic cheap-model delegation");
  }
  return {
    route,
    enforced: policy.mode === "enforce",
    estimatedTokens,
    risk: frontierRequired ? "high" : lowRisk ? "low" : "medium",
    reasons
  };
}

export type ExactSlice = {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  excerpt: string;
  matchedTerms: string[];
};

export function extractExactSlices(input: {
  sourcePath: string;
  content: string;
  question: string;
  contextLines?: number;
  maxSlices?: number;
}): ExactSlice[] {
  const terms = [...new Set((input.question.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/gu) ?? [])
    .filter((term) => !new Set(["the", "and", "for", "with", "from", "what", "where", "which", "does", "this", "that"]).has(term)))];
  if (!terms.length) return [];
  const lines = input.content.split(/\r?\n/u);
  const radius = Math.max(0, Math.min(input.contextLines ?? 2, 20));
  const hits: number[] = [];
  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();
    if (terms.some((term) => normalized.includes(term))) hits.push(index);
  }
  const ranges: Array<[number, number]> = [];
  for (const hit of hits) {
    const start = Math.max(0, hit - radius);
    const end = Math.min(lines.length - 1, hit + radius);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const contentHash = sha256(input.content);
  return ranges.slice(0, Math.max(1, input.maxSlices ?? 8)).map(([start, end]) => ({
    path: normalizeDisplayPath(input.sourcePath),
    startLine: start + 1,
    endLine: end + 1,
    contentHash,
    excerpt: lines.slice(start, end + 1).join("\n"),
    matchedTerms: terms.filter((term) => lines.slice(start, end + 1).some((line) => line.toLowerCase().includes(term)))
  }));
}

export function contextCacheKey(input: {
  contentHash: string;
  questionClass: string;
  processorVersion: string;
  model: string;
  outputSchema: string;
  policyHash: string;
}): string {
  return `context-summary:${sha256(JSON.stringify({
    contentHash: input.contentHash,
    questionClass: input.questionClass,
    processorVersion: input.processorVersion,
    model: input.model,
    outputSchema: input.outputSchema,
    policyHash: input.policyHash
  }))}`;
}

export type ContextShadowObservation = {
  version: 1;
  mode: "shadow";
  projectId: string;
  sourcePathHash: string;
  contentHash: string;
  intent: ContextIntent;
  recommendedRoute: ContextRoute;
  risk: ContextRouteDecision["risk"];
  estimatedInputTokens: number;
  projectedFrontierTokensAvoided: number;
  projectedSavingsPercent: number;
  latencyBudgetMs: number;
  reasons: string[];
  fileBodyStored: false;
};

export function buildShadowObservation(input: {
  projectId: string;
  sourcePath: string;
  content: string;
  intent: ContextIntent;
  question?: string;
  policy: ContextRoutingPolicy;
  expectedSummaryTokens?: number;
  latencyBudgetMs?: number;
}): ContextShadowObservation {
  if (input.policy.mode !== "shadow") throw new Error("Shadow observations require a shadow-mode policy.");
  const decision = decideContextRoute(input);
  const expectedSummaryTokens = Math.max(0, input.expectedSummaryTokens ?? Math.min(800, Math.ceil(decision.estimatedTokens * 0.2)));
  const eligible = decision.route === "delegate" || decision.route === "deterministic";
  const avoided = eligible ? Math.max(0, decision.estimatedTokens - expectedSummaryTokens) : 0;
  return {
    version: 1,
    mode: "shadow",
    projectId: input.projectId,
    sourcePathHash: sha256(normalizeDisplayPath(input.sourcePath)),
    contentHash: sha256(input.content),
    intent: input.intent,
    recommendedRoute: decision.route,
    risk: decision.risk,
    estimatedInputTokens: decision.estimatedTokens,
    projectedFrontierTokensAvoided: avoided,
    projectedSavingsPercent: decision.estimatedTokens ? Math.round(avoided / decision.estimatedTokens * 1000) / 10 : 0,
    latencyBudgetMs: Math.max(0, input.latencyBudgetMs ?? 30_000),
    reasons: decision.reasons,
    fileBodyStored: false
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDisplayPath(value: string): string {
  return path.normalize(value).replaceAll("\\", "/");
}

export async function assertContextProjectPath(projectRoot: string, target: string): Promise<void> {
  const canonicalRoot = await fs.realpath(path.resolve(projectRoot));
  let existing = path.resolve(target);
  while (true) {
    try {
      const canonicalExisting = await fs.realpath(existing);
      const canonicalTarget = path.resolve(canonicalExisting, path.relative(existing, path.resolve(target)));
      if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error("Context Gateway path escapes the project through a symbolic link.");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export type ContextCacheEntry = {
  version: 1;
  projectId: string;
  key: string;
  createdAt: string;
  expiresAt: string;
  contentHash: string;
  policyHash: string;
  processorVersion: string;
  model: string;
  outputSchema: string;
  summary: string;
  claims: DelegatedContextClaim[];
};

export class ProjectContextCache {
  readonly directory: string;
  constructor(readonly projectRoot: string, readonly projectId: string, readonly maxEntryBytes = 256_000) {
    this.directory = path.join(path.resolve(projectRoot), ".agent-workflow", "context-gateway", "cache");
  }
  async get(key: string, now = Date.now()): Promise<ContextCacheEntry | null> {
    const file = this.entryPath(key);
    await assertContextProjectPath(this.projectRoot, file);
    try {
      const raw = await fs.readFile(file, "utf8");
      if (Buffer.byteLength(raw) > this.maxEntryBytes) return null;
      const entry = JSON.parse(raw) as ContextCacheEntry;
      if (entry.version !== 1 || entry.projectId !== this.projectId || entry.key !== key || Date.parse(entry.expiresAt) <= now) return null;
      return entry;
    } catch { return null; }
  }
  async put(entry: ContextCacheEntry): Promise<string> {
    if (entry.projectId !== this.projectId) throw new Error("Context cache entry belongs to a different project.");
    const raw = `${JSON.stringify(entry, null, 2)}\n`;
    if (Buffer.byteLength(raw) > this.maxEntryBytes) throw new Error("Context cache entry exceeds the configured size limit.");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.entryPath(entry.key);
    await assertContextProjectPath(this.projectRoot, target);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, raw, { mode: 0o600 });
    await fs.rename(temporary, target);
    return target;
  }
  async prune(now = Date.now()): Promise<number> {
    await assertContextProjectPath(this.projectRoot, this.directory);
    let names: string[];
    try { names = await fs.readdir(this.directory); } catch { return 0; }
    let removed = 0;
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const target = path.join(this.directory, name);
      try {
        const entry = JSON.parse(await fs.readFile(target, "utf8")) as ContextCacheEntry;
        if (entry.projectId !== this.projectId || Date.parse(entry.expiresAt) <= now) {
          await fs.rm(target);
          removed += 1;
        }
      } catch {
        await fs.rm(target).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }
  private entryPath(key: string): string {
    if (!/^context-summary:[a-f0-9]{64}$/u.test(key)) throw new Error("Invalid content cache key.");
    return path.join(this.directory, `${key.slice("context-summary:".length)}.json`);
  }
}

export async function readContextCacheHealth(input: { projectRoot: string; projectId: string; now?: number }): Promise<{ entries: number; validEntries: number; expiredEntries: number; bytes: number }> {
  const directory = path.join(path.resolve(input.projectRoot), ".agent-workflow", "context-gateway", "cache");
  await assertContextProjectPath(input.projectRoot, directory);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return { entries: 0, validEntries: 0, expiredEntries: 0, bytes: 0 }; }
  let entries = 0; let validEntries = 0; let expiredEntries = 0; let bytes = 0;
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try {
      const target = path.join(directory, name);
      const [raw, stat] = await Promise.all([fs.readFile(target, "utf8"), fs.stat(target)]);
      const entry = JSON.parse(raw) as ContextCacheEntry;
      entries += 1; bytes += stat.size;
      if (entry.projectId === input.projectId && Date.parse(entry.expiresAt) > (input.now ?? Date.now())) validEntries += 1;
      else expiredEntries += 1;
    } catch { entries += 1; expiredEntries += 1; }
  }
  return { entries, validEntries, expiredEntries, bytes };
}

export type DelegatedContextClaim = {
  text: string;
  sourcePath: string;
  startLine: number | null;
  endLine: number | null;
  contentHash: string;
  confidence: number;
  retrievalHandle: string;
};

export async function delegateContextSummary(input: {
  sourcePath: string;
  content: string;
  question: string;
  model: string;
  summarize: (request: { sourceUri: string; content: string; deterministicSummary: string }) => Promise<{ summary: string }>;
}): Promise<{ summary: string; claims: DelegatedContextClaim[]; exactSlices: ExactSlice[] }> {
  const exactSlices = extractExactSlices({ sourcePath: input.sourcePath, content: input.content, question: input.question });
  const deterministicSummary = exactSlices.length
    ? exactSlices.map((slice) => `${slice.path}:${slice.startLine}-${slice.endLine}\n${slice.excerpt}`).join("\n\n")
    : `No deterministic matches for: ${input.question}`;
  const output = await input.summarize({ sourceUri: input.sourcePath, content: input.content, deterministicSummary });
  const contentHash = sha256(input.content);
  const fallbackLine = exactSlices[0] ?? null;
  const claims = output.summary.split(/\r?\n/u).map((line) => line.replace(/^[-*]\s*/u, "").trim()).filter(Boolean).slice(0, 40).map((text) => ({
    text,
    sourcePath: normalizeDisplayPath(input.sourcePath),
    startLine: fallbackLine?.startLine ?? null,
    endLine: fallbackLine?.endLine ?? null,
    contentHash,
    confidence: fallbackLine ? 0.8 : 0.5,
    retrievalHandle: `${normalizeDisplayPath(input.sourcePath)}#sha256=${contentHash}&lines=${fallbackLine ? `${fallbackLine.startLine}-${fallbackLine.endLine}` : "unresolved"}`
  }));
  return { summary: output.summary, claims, exactSlices };
}

export type ContextEfficiencyReport = {
  observations: number;
  eligibleReads: number;
  totalEstimatedTokens: number;
  projectedFrontierTokensAvoided: number;
  projectedSavingsPercent: number;
  routes: Record<ContextRoute, number>;
  risks: Record<ContextRouteDecision["risk"], number>;
};

export function buildContextEfficiencyReport(observations: ContextShadowObservation[]): ContextEfficiencyReport {
  const routes: ContextEfficiencyReport["routes"] = { direct: 0, deterministic: 0, delegate: 0, frontier: 0 };
  const risks: ContextEfficiencyReport["risks"] = { low: 0, medium: 0, high: 0 };
  for (const item of observations) { routes[item.recommendedRoute] += 1; risks[item.risk] += 1; }
  const total = observations.reduce((sum, item) => sum + item.estimatedInputTokens, 0);
  const avoided = observations.reduce((sum, item) => sum + item.projectedFrontierTokensAvoided, 0);
  return {
    observations: observations.length,
    eligibleReads: routes.delegate + routes.deterministic,
    totalEstimatedTokens: total,
    projectedFrontierTokensAvoided: avoided,
    projectedSavingsPercent: total ? Math.round(avoided / total * 1000) / 10 : 0,
    routes,
    risks
  };
}

export async function writeShadowObservationBatch(input: {
  projectRoot: string;
  projectId: string;
  observations: ContextShadowObservation[];
}): Promise<string | null> {
  if (!input.observations.length) return null;
  if (input.observations.some((item) => item.projectId !== input.projectId || item.fileBodyStored !== false)) {
    throw new Error("Shadow observation batch violates project isolation or privacy policy.");
  }
  const directory = path.join(path.resolve(input.projectRoot), ".agent-workflow", "context-gateway", "observations");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}.json`);
  await assertContextProjectPath(input.projectRoot, target);
  const payload = { version: 1, projectId: input.projectId, createdAt: new Date().toISOString(), report: buildContextEfficiencyReport(input.observations), observations: input.observations };
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export async function readShadowObservations(input: { projectRoot: string; projectId: string; maxBatches?: number }): Promise<ContextShadowObservation[]> {
  const directory = path.join(path.resolve(input.projectRoot), ".agent-workflow", "context-gateway", "observations");
  await assertContextProjectPath(input.projectRoot, directory);
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return []; }
  const observations: ContextShadowObservation[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort().reverse().slice(0, Math.max(1, input.maxBatches ?? 100))) {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as { projectId?: string; observations?: ContextShadowObservation[] };
      if (payload.projectId !== input.projectId || !Array.isArray(payload.observations)) continue;
      observations.push(...payload.observations.filter((item) => item.projectId === input.projectId && item.fileBodyStored === false));
    } catch { /* ignore malformed local evidence */ }
  }
  return observations;
}

export type ContextHoldoutCase = {
  id: string;
  requiredTerms: string[];
  directAnswer: string;
  routedAnswer: string;
  citationsValid: boolean;
  directTokens: number;
  routedTokens: number;
  addedLatencyMs: number;
};

export const contextHoldoutCasesSchema = z.array(z.object({
  id: z.string().min(1),
  requiredTerms: z.array(z.string()),
  directAnswer: z.string(),
  routedAnswer: z.string(),
  citationsValid: z.boolean(),
  directTokens: z.number().int().nonnegative(),
  routedTokens: z.number().int().nonnegative(),
  addedLatencyMs: z.number().int().nonnegative()
})).min(3);

export function evaluateContextHoldouts(cases: ContextHoldoutCase[]): {
  cases: number; qualityPassRate: number; citationPassRate: number; tokenSavingsPercent: number; p95AddedLatencyMs: number; enforcementReady: boolean;
} {
  const validated = contextHoldoutCasesSchema.parse(cases);
  const quality = validated.map((item) => item.requiredTerms.every((term) => item.routedAnswer.toLowerCase().includes(term.toLowerCase())));
  const directTokens = validated.reduce((sum, item) => sum + item.directTokens, 0);
  const routedTokens = validated.reduce((sum, item) => sum + item.routedTokens, 0);
  const latencies = validated.map((item) => item.addedLatencyMs).sort((a, b) => a - b);
  const qualityPassRate = quality.filter(Boolean).length / validated.length;
  const citationPassRate = validated.filter((item) => item.citationsValid).length / validated.length;
  const tokenSavingsPercent = directTokens ? Math.round((directTokens - routedTokens) / directTokens * 1000) / 10 : 0;
  const p95AddedLatencyMs = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : 0;
  return { cases: validated.length, qualityPassRate, citationPassRate, tokenSavingsPercent, p95AddedLatencyMs, enforcementReady: qualityPassRate === 1 && citationPassRate === 1 && tokenSavingsPercent >= 30 && p95AddedLatencyMs <= 30_000 };
}

export function enforceContextDecision(input: {
  policy: ContextRoutingPolicy;
  decision: ContextRouteDecision;
  confidence?: number;
  exactReadRequested?: boolean;
  holdoutApproved?: boolean;
}): { action: "allow" | "redirect" | "promote"; reason: string } {
  if (input.exactReadRequested) return { action: "allow", reason: "Explicit exact-read escape hatch requested." };
  if (input.decision.route === "frontier" || input.decision.risk === "high") return { action: "promote", reason: "Sensitive work requires frontier-model evidence." };
  if (input.policy.mode !== "enforce") return { action: "allow", reason: `${input.policy.mode} mode never blocks reads.` };
  if (!input.holdoutApproved) return { action: "allow", reason: "Enforcement is unavailable without approved holdout evidence." };
  if ((input.confidence ?? 1) < 0.75) return { action: "promote", reason: "Low-confidence routed context was promoted." };
  if (input.decision.route === "delegate" || input.decision.route === "deterministic") return { action: "redirect", reason: "Eval-approved low-risk bulk read must use routed context." };
  return { action: "allow", reason: "Direct read is within policy budget." };
}

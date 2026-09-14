import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

export type ProviderFailureKind = "provider_outage" | "rate_limited" | "model_unavailable" | "authentication" | "account_quota" | "configuration" | "unknown";
export interface ProviderFallbackCandidate { provider: string; model?: string; fleetApproved?: boolean; dataPolicy?: string; }
export interface ProviderFallbackAttempt { provider: string; model?: string; attempt: number; attemptId: string; outcome: "completed" | "failed" | "skipped"; failureKind?: ProviderFailureKind; reason?: string; }
export interface ProviderFallbackPolicy { chains: Record<string, ProviderFallbackCandidate[]>; maxRetries: number; circuitFailureThreshold: number; circuitCooldownMs: number; allowQuotaFallback: boolean; }
export interface ProviderFallbackResult { output: StageExecutionOutput; requestedProvider: string; actualProvider: string; actualModel?: string; fallbackUsed: boolean; attempts: ProviderFallbackAttempt[]; }

type CircuitState = { failures: number; openedAt?: number };
const circuits = new Map<string, CircuitState>();
const loadedCircuitPaths = new Set<string>();
let circuitWrite = Promise.resolve();

export class ProviderExecutionError extends Error {
  attempts: ProviderFallbackAttempt[] = [];
  constructor(public readonly kind: ProviderFailureKind, message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

export function classifyProviderFailure(error: unknown): ProviderExecutionError {
  if (error instanceof ProviderExecutionError) return error;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; error?: { code?: unknown; type?: unknown }; message?: unknown };
  const status = numberValue(candidate?.status ?? candidate?.statusCode);
  const code = stringValue(candidate?.code ?? candidate?.error?.code ?? candidate?.error?.type).toLowerCase();
  const message = stringValue(candidate?.message ?? error).toLowerCase();
  const label = `${code} ${message}`;
  if (status === 401 || status === 403 || /invalid[_ -]?api[_ -]?key|unauthorized|authentication|credential/.test(label)) return new ProviderExecutionError("authentication", "Provider authentication failed.", status, code);
  if (/insufficient_quota|billing[_ -]?hard[_ -]?limit|credit balance|exceeded.*quota|quota.*exhaust/.test(label)) return new ProviderExecutionError("account_quota", "Provider account quota is exhausted.", status, code);
  if (status === 429 || /rate[_ -]?limit|too many requests|throttl/.test(label)) return new ProviderExecutionError("rate_limited", "Provider rate limit was reached.", status, code);
  if (status === 404 || /model.*(not found|unavailable|does not exist|unsupported)|deployment.*not found/.test(label)) return new ProviderExecutionError("model_unavailable", "Requested provider model is unavailable.", status, code);
  if ((status !== undefined && status >= 500) || /econnreset|econnrefused|enotfound|etimedout|fetch failed|socket hang up|service unavailable/.test(label)) return new ProviderExecutionError("provider_outage", "Provider service is unavailable.", status, code);
  if (/required when default_model_provider|is not configured|required environment|missing configuration|unsupported provider adapter/.test(label)) return new ProviderExecutionError("configuration", "Provider configuration is incomplete.", status, code);
  return new ProviderExecutionError("unknown", "Provider execution failed.", status, code);
}

export function providerFallbackPolicyFromEnv(): ProviderFallbackPolicy {
  const parsed = parsePolicy(process.env.AGENTFLOW_PROVIDER_FALLBACK_POLICY);
  return {
    chains: parsed?.chains ?? legacyChains(),
    maxRetries: boundedInteger(parsed?.maxRetries ?? process.env.AGENTFLOW_PROVIDER_MAX_RETRIES, 1, 0, 3),
    circuitFailureThreshold: boundedInteger(parsed?.circuitFailureThreshold ?? process.env.AGENTFLOW_PROVIDER_CIRCUIT_FAILURES, 3, 1, 20),
    circuitCooldownMs: boundedInteger(parsed?.circuitCooldownMs ?? process.env.AGENTFLOW_PROVIDER_CIRCUIT_COOLDOWN_MS, 60_000, 1_000, 3_600_000),
    allowQuotaFallback: parsed?.allowQuotaFallback === true || process.env.AGENTFLOW_ALLOW_QUOTA_FALLBACK === "true"
  };
}

export async function executeWithProviderFallback(input: {
  providerId: string;
  stageInput: StageExecutionInput;
  policy?: ProviderFallbackPolicy;
  providerFactory: (providerId: string) => ModelProvider;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  circuitStatePath?: string | null;
}): Promise<ProviderFallbackResult> {
  const policy = input.policy ?? providerFallbackPolicyFromEnv();
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const circuitStatePath = input.circuitStatePath === undefined
    ? path.resolve(process.env.AGENTFLOW_PROVIDER_CIRCUIT_STATE ?? ".agent-workflow/runtime/provider-circuits.json")
    : input.circuitStatePath;
  if (circuitStatePath) await loadCircuits(circuitStatePath);
  const candidates = uniqueCandidates([{ provider: input.providerId }, ...(policy.chains[input.providerId] ?? policy.chains["*"] ?? [])]);
  const attempts: ProviderFallbackAttempt[] = [];
  let lastError: ProviderExecutionError | undefined;

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (lastError?.kind === "account_quota" && (!policy.allowQuotaFallback || !candidate.fleetApproved || !candidate.dataPolicy)) {
      attempts.push(attemptRecord(input.stageInput, candidate, 0, "skipped", lastError.kind, "Quota fallback requires an explicitly fleet-approved provider and data policy."));
      continue;
    }
    const circuitKey = `${candidate.provider}:${candidate.model ?? "tier-default"}`;
    const circuit = circuits.get(circuitKey);
    if (circuit?.openedAt && now() - circuit.openedAt < policy.circuitCooldownMs) {
      attempts.push(attemptRecord(input.stageInput, candidate, 0, "skipped", "provider_outage", "Provider circuit is cooling down."));
      continue;
    }
    let provider: ModelProvider;
    try {
      provider = input.providerFactory(candidate.provider);
      if (circuit?.openedAt && provider.check) {
        const health = await provider.check();
        if (!health.ready) {
          attempts.push(attemptRecord(input.stageInput, candidate, 0, "skipped", "provider_outage", "Provider health probe did not pass."));
          continue;
        }
        circuits.delete(circuitKey);
        if (circuitStatePath) await persistCircuits(circuitStatePath);
      }
    } catch (error) {
      const failure = classifyProviderFailure(error);
      attempts.push(attemptRecord(input.stageInput, candidate, 0, "failed", failure.kind, failure.message));
      if (failure.kind === "authentication" || failure.kind === "configuration") throw attachAttempts(failure, attempts);
      lastError = failure;
      continue;
    }
    for (let retry = 0; retry <= policy.maxRetries; retry += 1) {
      try {
        const output = await provider.executeStage({ ...input.stageInput, modelOverride: candidate.model });
        circuits.delete(circuitKey);
        if (circuitStatePath) await persistCircuits(circuitStatePath);
        attempts.push(attemptRecord(input.stageInput, candidate, retry, "completed"));
        const artifactModel = typeof output.artifact?.model === "string" ? output.artifact.model : undefined;
        return { output, requestedProvider: input.providerId, actualProvider: candidate.provider, actualModel: candidate.model ?? artifactModel, fallbackUsed: candidateIndex > 0, attempts };
      } catch (error) {
        const failure = classifyProviderFailure(error);
        attempts.push(attemptRecord(input.stageInput, candidate, retry, "failed", failure.kind, failure.message));
        lastError = failure;
        if (failure.kind === "authentication" || failure.kind === "configuration") throw attachAttempts(failure, attempts);
        const state = circuits.get(circuitKey) ?? { failures: 0 };
        const retryable = failure.kind === "provider_outage" || failure.kind === "rate_limited";
        if (retryable) {
          state.failures += 1;
          if (state.failures >= policy.circuitFailureThreshold) state.openedAt = now();
          circuits.set(circuitKey, state);
          if (circuitStatePath) await persistCircuits(circuitStatePath);
        }
        if (!retryable || retry >= policy.maxRetries) break;
        await delay(Math.min(2 ** retry * 250, 2_000));
      }
    }
  }
  throw attachAttempts(lastError ?? new ProviderExecutionError("unknown", "No provider candidate completed the request."), attempts);
}

export function resetProviderFallbackCircuits(): void { circuits.clear(); loadedCircuitPaths.clear(); }

function attemptRecord(input: StageExecutionInput, candidate: ProviderFallbackCandidate, attempt: number, outcome: ProviderFallbackAttempt["outcome"], failureKind?: ProviderFailureKind, reason?: string): ProviderFallbackAttempt {
  const attemptId = createHash("sha256").update(JSON.stringify({ runId: input.runId, taskId: input.taskId, provider: candidate.provider, model: candidate.model ?? null, attempt })).digest("hex");
  return { provider: candidate.provider, ...(candidate.model ? { model: candidate.model } : {}), attempt, attemptId, outcome, ...(failureKind ? { failureKind } : {}), ...(reason ? { reason } : {}) };
}

function attachAttempts(error: ProviderExecutionError, attempts: ProviderFallbackAttempt[]): ProviderExecutionError {
  error.attempts = attempts;
  return error;
}
function uniqueCandidates(values: ProviderFallbackCandidate[]): ProviderFallbackCandidate[] { return [...new Map(values.map((item) => [`${item.provider}:${item.model ?? ""}`, item])).values()]; }
function parsePolicy(value?: string): Partial<ProviderFallbackPolicy> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ProviderFallbackPolicy>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    if (parsed.chains !== undefined && (!parsed.chains || typeof parsed.chains !== "object" || Array.isArray(parsed.chains))) throw new Error();
    for (const candidates of Object.values(parsed.chains ?? {})) {
      if (!Array.isArray(candidates) || candidates.some((candidate) => !candidate || typeof candidate.provider !== "string" || !candidate.provider.trim())) throw new Error();
    }
    return parsed;
  } catch { throw new ProviderExecutionError("configuration", "AGENTFLOW_PROVIDER_FALLBACK_POLICY must be valid policy JSON."); }
}
function legacyChains(): Record<string, ProviderFallbackCandidate[]> { const fallback = process.env.AGENTFLOW_FALLBACK_PROVIDER?.trim(); return fallback ? { "*": [{ provider: fallback }] } : {}; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : value instanceof Error ? value.message : ""; }

async function loadCircuits(file: string): Promise<void> {
  if (loadedCircuitPaths.has(file)) return;
  loadedCircuitPaths.add(file);
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, CircuitState>;
    for (const [key, state] of Object.entries(parsed)) {
      if (state && Number.isFinite(state.failures) && (state.openedAt === undefined || Number.isFinite(state.openedAt))) circuits.set(key, state);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ProviderExecutionError("configuration", "Provider circuit state is unreadable.");
  }
}

async function persistCircuits(file: string): Promise<void> {
  circuitWrite = circuitWrite.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(Object.fromEntries(circuits), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  });
  await circuitWrite;
}

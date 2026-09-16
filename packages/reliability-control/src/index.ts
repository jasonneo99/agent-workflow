import { createHash } from "node:crypto";

export type RunState = "queued" | "leased" | "running" | "completed" | "blocked" | "failed" | "cancelled";
export type StageState = RunState;
export type TerminalState = "completed" | "blocked" | "failed" | "cancelled";

const transitions: Record<RunState, ReadonlySet<RunState>> = {
  queued: new Set(["leased", "cancelled"]),
  leased: new Set(["running", "queued", "cancelled"]),
  running: new Set(["completed", "blocked", "failed", "cancelled", "queued"]),
  completed: new Set(), blocked: new Set(), failed: new Set(), cancelled: new Set()
};

export function canTransition(from: RunState, to: RunState): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new Error(`Invalid workflow transition: ${from} -> ${to}`);
}

export function deriveRunState(stages: StageState[]): RunState {
  if (!stages.length || stages.every((state) => state === "queued")) return "queued";
  if (stages.some((state) => state === "failed")) return "failed";
  if (stages.some((state) => state === "blocked")) return "blocked";
  if (stages.every((state) => state === "cancelled")) return "cancelled";
  if (stages.every((state) => state === "completed" || state === "cancelled")) return "completed";
  if (stages.some((state) => state === "running")) return "running";
  if (stages.some((state) => state === "leased")) return "leased";
  return "queued";
}

export function assertFence(expected: bigint | number | string, presented: bigint | number | string): void {
  if (BigInt(expected) !== BigInt(presented)) throw new Error("Stale workflow fencing token.");
}

export type WorkIntent = {
  projectId: string; owner: string; objectiveHash: string; fileScopes: string[]; expiresAt: string; fencingToken: string;
};

export function objectiveHash(objective: string): string {
  return createHash("sha256").update(objective.trim().toLowerCase().replace(/\s+/gu, " ")).digest("hex");
}

function scopesOverlap(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return true;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return left.some((a) => right.some((b) => {
    const x = normalize(a); const y = normalize(b);
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}

export function workIntentsConflict(left: Pick<WorkIntent, "owner" | "objectiveHash" | "fileScopes">, right: Pick<WorkIntent, "owner" | "objectiveHash" | "fileScopes">): boolean {
  return left.owner !== right.owner && (left.objectiveHash === right.objectiveHash || scopesOverlap(left.fileScopes, right.fileScopes));
}

export function sideEffectKey(input: { projectId: string; operation: string; target: string; payloadHash: string }): string {
  return createHash("sha256").update([input.projectId, input.operation, input.target, input.payloadHash].join("\u001f")).digest("hex");
}

export type ReleasePhase = "prepared" | "started" | "healthy" | "promoted" | "rolled_back" | "failed";
export function releaseRequiresRollback(input: { switched: boolean; healthPassed: boolean; servicesReady: boolean }): boolean {
  return input.switched && (!input.healthPassed || !input.servicesReady);
}

export const reliabilityFailureScenarios = [
  "worker_killed_after_side_effect", "lease_expires_during_execution", "daemon_restarts_mid_sweep",
  "postgres_unavailable", "redis_unavailable", "object_store_unavailable", "provider_timeout",
  "duplicate_authenticated_request", "overlapping_codex_and_daemon_write", "release_health_check_failure"
] as const;

export const reliabilityProtocolVersions = Object.freeze({ runtime: 1, storage: 1, bundle: 1 });
export type ReliabilityProtocolVersions = typeof reliabilityProtocolVersions;

export type ReliabilitySample = {
  totalMutations: number; receiptedMutations: number; duplicateSideEffects: number | null; stuckRuns: number;
  recoveryDurationsMs: number[] | null; fleetFalseCriticals: number | null; rollbackDurationsMs: number[] | null; invalidTerminalRuns: number;
};
export type ReliabilityCheckStatus = "pass" | "attention" | "unknown";
export type ReliabilitySloCheck = {
  id: string; status: ReliabilityCheckStatus; pass: boolean | null; actual: number | null; target: string;
  evidenceCount: number; numerator?: number; denominator?: number;
};
export type ReliabilitySloReport = { status: ReliabilityCheckStatus; checks: ReliabilitySloCheck[] };

export type ReliabilityFailureEvidence = {
  scenario: typeof reliabilityFailureScenarios[number]; outcome: "pass" | "attention"; observedAt: string; artifact?: string;
};

export function evaluateReliabilityFailureScenarios(evidence: ReliabilityFailureEvidence[] = []) {
  return reliabilityFailureScenarios.map((id) => {
    const observations = evidence.filter((entry) => entry.scenario === id);
    const latest = observations.at(-1);
    return {
      id,
      status: latest?.outcome ?? "unknown",
      evidenceCount: observations.length,
      observedAt: latest?.observedAt ?? null,
      artifact: latest?.artifact ?? null
    };
  });
}

export function evaluateReliabilitySlos(sample: ReliabilitySample): ReliabilitySloReport {
  const measured = (id: string, actual: number, target: string, pass: boolean, evidenceCount = 1, ratio?: { numerator: number; denominator: number }): ReliabilitySloCheck =>
    ({ id, status: pass ? "pass" : "attention", pass, actual, target, evidenceCount, ...ratio });
  const unknown = (id: string, target: string): ReliabilitySloCheck => ({ id, status: "unknown", pass: null, actual: null, target, evidenceCount: 0 });
  const maxCheck = (id: string, values: number[] | null, limit: number) => values?.length
    ? measured(id, Math.max(...values), `<=${limit}ms`, Math.max(...values) <= limit, values.length)
    : unknown(id, `<=${limit}ms`);
  const checks: ReliabilitySloCheck[] = [
    sample.duplicateSideEffects === null ? unknown("duplicate-side-effects", "0") : measured("duplicate-side-effects", sample.duplicateSideEffects, "0", sample.duplicateSideEffects === 0),
    sample.totalMutations > 0
      ? measured("mutation-receipt-rate", sample.receiptedMutations / sample.totalMutations, "100%", sample.receiptedMutations === sample.totalMutations, sample.totalMutations, { numerator: sample.receiptedMutations, denominator: sample.totalMutations })
      : unknown("mutation-receipt-rate", "100%"),
    measured("stuck-runs", sample.stuckRuns, "0 beyond lease", sample.stuckRuns === 0),
    maxCheck("recovery-time", sample.recoveryDurationsMs, 300_000),
    sample.fleetFalseCriticals === null ? unknown("fleet-false-criticals", "0") : measured("fleet-false-criticals", sample.fleetFalseCriticals, "0", sample.fleetFalseCriticals === 0),
    maxCheck("rollback-time", sample.rollbackDurationsMs, 120_000),
    measured("invalid-terminal-runs", sample.invalidTerminalRuns, "0", sample.invalidTerminalRuns === 0)
  ];
  const status = checks.some((check) => check.status === "attention") ? "attention" : checks.some((check) => check.status === "unknown") ? "unknown" : "pass";
  return { status, checks };
}

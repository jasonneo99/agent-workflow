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

export type ReliabilitySample = {
  totalMutations: number; receiptedMutations: number; duplicateSideEffects: number; stuckRuns: number;
  recoveryDurationsMs: number[]; fleetFalseCriticals: number; rollbackDurationsMs: number[]; invalidTerminalRuns: number;
};
export type ReliabilitySloReport = { status: "pass" | "attention"; checks: Array<{ id: string; pass: boolean; actual: number; target: string }> };

export function evaluateReliabilitySlos(sample: ReliabilitySample): ReliabilitySloReport {
  const max = (values: number[]) => values.length ? Math.max(...values) : 0;
  const receiptRate = sample.totalMutations ? sample.receiptedMutations / sample.totalMutations : 1;
  const checks = [
    { id: "reliability-evidence", pass: sample.totalMutations > 0 && sample.recoveryDurationsMs.length > 0 && sample.rollbackDurationsMs.length > 0, actual: Number(sample.totalMutations > 0) + Number(sample.recoveryDurationsMs.length > 0) + Number(sample.rollbackDurationsMs.length > 0), target: "3/3 evidence classes" },
    { id: "duplicate-side-effects", pass: sample.duplicateSideEffects === 0, actual: sample.duplicateSideEffects, target: "0" },
    { id: "mutation-receipt-rate", pass: receiptRate === 1, actual: receiptRate, target: "100%" },
    { id: "stuck-runs", pass: sample.stuckRuns === 0, actual: sample.stuckRuns, target: "0 beyond lease" },
    { id: "recovery-time", pass: max(sample.recoveryDurationsMs) <= 300_000, actual: max(sample.recoveryDurationsMs), target: "<=300000ms" },
    { id: "fleet-false-criticals", pass: sample.fleetFalseCriticals === 0, actual: sample.fleetFalseCriticals, target: "0" },
    { id: "rollback-time", pass: max(sample.rollbackDurationsMs) <= 120_000, actual: max(sample.rollbackDurationsMs), target: "<=120000ms" },
    { id: "invalid-terminal-runs", pass: sample.invalidTerminalRuns === 0, actual: sample.invalidTerminalRuns, target: "0" }
  ];
  return { status: checks.every((check) => check.pass) ? "pass" : "attention", checks };
}

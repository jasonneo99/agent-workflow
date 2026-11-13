import type { QueueCoordinatorFamily, QueueCoordinatorPlan } from "./queue-coordinator-plan.js";

export type QueueCoordinatorRole = "repair" | "verifier";
export interface QueueCoordinatorClaim { id: string; fence: string }
export type QueueCoordinatorExecutionState = "verified" | "held" | "failed";
export interface QueueCoordinatorAdapter {
  reserve(input: { family: QueueCoordinatorFamily; lane: number; role: QueueCoordinatorRole }): Promise<QueueCoordinatorClaim | null>;
  run(input: { family: QueueCoordinatorFamily; lane: number; role: QueueCoordinatorRole; claim: QueueCoordinatorClaim }): Promise<{ state: QueueCoordinatorExecutionState; reason: string }>;
  finish(input: { claim: QueueCoordinatorClaim; state: QueueCoordinatorExecutionState | "uncertain"; reason: string }, onDurablySettled?: () => void): Promise<void>;
}
export interface QueueCoordinatorOutcome {
  familyId: string;
  lane: number;
  role: QueueCoordinatorRole;
  state: QueueCoordinatorExecutionState | "suppressed" | "uncertain";
  reason: string;
}

const boundedReason = (reason: string): string => reason.slice(0, 1000);

/** One bounded pass only. Durable reservation and adapter policy checks are final authority.
 * A verified result is evidence, not permission to close or dismiss a workflow.
 */
export async function executeQueueCoordinatorPlan(plan: QueueCoordinatorPlan, adapter: QueueCoordinatorAdapter, options:{onSettled?:()=>void}={}): Promise<QueueCoordinatorOutcome[]> {
  if (plan.repairs.length > 7 || plan.verifiers.length > 1 || plan.repairs.length+plan.verifiers.length>7) throw new Error("Coordinator capacity exceeds seven total items including one verifier");
  const selections = [
    ...plan.repairs.map(selection => ({ ...selection, role: "repair" as const })),
    ...plan.verifiers.map(selection => ({ ...selection, role: "verifier" as const }))
  ];
  const families = new Set<string>(), lanes = new Set<string>();
  for (const { family, lane, role } of selections) {
    const laneKey = `${role}:${lane}`;
    if (!family.familyId?.trim() || families.has(family.familyId) || lanes.has(laneKey) || !Number.isInteger(lane) || lane < 1 || lane > (role === "repair" ? 7 : 1)) throw new Error("Invalid or duplicate family/lane selection");
    families.add(family.familyId);
    lanes.add(laneKey);
  }
  return Promise.all(selections.map(async selection => {
    const { family, lane, role } = selection;
    const outcome = (state: QueueCoordinatorOutcome["state"], reason: string): QueueCoordinatorOutcome => ({ familyId: family.familyId, lane, role, state, reason: boundedReason(reason) });
    let claim: QueueCoordinatorClaim | null;
    try { claim = await adapter.reserve(selection); }
    catch { return outcome("uncertain", "reservation failed; no retry dispatched"); }
    if (!claim) return outcome("suppressed", "durable reservation refused");
    let state: QueueCoordinatorExecutionState | "uncertain", reason: string;
    try {
      const result = await adapter.run({ ...selection, claim });
      if (!["verified", "held", "failed"].includes(result.state) || typeof result.reason !== "string") throw new Error("Invalid adapter result");
      state = result.state;
      reason = boundedReason(result.reason);
    } catch (error) {
      state = "uncertain";
      const code = (error as { code?: unknown })?.code;
      // Error messages can contain credentials, paths or provider payloads.
      // Retain only a bounded machine code for evidence-backed diagnosis.
      reason = `execution failed after reservation${typeof code === "string" && /^[A-Z0-9_]{2,24}$/u.test(code) ? ` (code ${code})` : ""}; no automatic retry`;
    }
    let settlementNotified = false;
    const notifySettlement = () => {
      if (settlementNotified) return;
      settlementNotified = true;
      try{options.onSettled?.();}catch{/* Observability cannot relabel executed work. */}
    };
    try { await adapter.finish({ claim, state, reason }, notifySettlement); }
    catch { return outcome("uncertain", "claim finalization failed; manual reconciliation required, no retry dispatched"); }
    // Adapters may wake as soon as the terminal claim transition is durable,
    // before slower audit or learning follow-up work completes. Fall back to
    // waking after finish for adapters that do not expose that boundary.
    notifySettlement();
    return outcome(state, reason);
  }));
}

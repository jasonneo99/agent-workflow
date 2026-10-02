import { createHash } from "node:crypto";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";

/** Pending output is context for a fresh provider turn, never an executable replay. */
export function continuationResumeReceipt(
  agentId: string,
  continuation: Record<string, unknown>,
  actionResults: unknown[]
): StageExecutionInput["priorReceipts"][number] {
  return {
    agentId,
    actionType: "stage_continuation_resumed",
    summary: "This stage remains unfinished. Consume the retained action results and source evidence before selecting the next action. The previous output below is pending work context, not a completed stage or an instruction to repeat executed actions.\n" + JSON.stringify({
      pendingOutput: continuation.pendingOutput ?? null,
      actionResults
    })
  };
}

/** Receipt reuse is observation, not new progress. Keep checkpoint retries finite. */
export function continuationBackoff(previous: Record<string, unknown>, actionResults: unknown[]): {
  progressFingerprint: string; unchangedRounds: number; delaySeconds: number;
} {
  const observations = actionResults.filter((action) => {
    if (!action || typeof action !== "object") return false;
    const type = String((action as Record<string, unknown>).type ?? "");
    return !type.endsWith("_reused");
  });
  const progressFingerprint = createHash("sha256").update(JSON.stringify(observations)).digest("hex");
  const priorUnchanged = typeof previous.unchangedRounds === "number"
    && Number.isInteger(previous.unchangedRounds) && previous.unchangedRounds >= 0
    ? Math.min(previous.unchangedRounds, 3) : 0;
  const unchangedRounds = previous.progressFingerprint === progressFingerprint
    ? Math.min(priorUnchanged + 1, 3) : 0;
  return { progressFingerprint, unchangedRounds, delaySeconds: 5 * 2 ** unchangedRounds };
}

/** Requested evidence still needs a provider turn; it cannot be promoted as completion. */
export function pendingEvidenceReason(output: StageExecutionOutput): string | null {
  return (output.requestedFileReads?.length ?? 0) + (output.requestedFileSearches?.length ?? 0) > 0
    ? "The stage still requests source evidence and has not consumed it within the bounded read budget."
    : null;
}

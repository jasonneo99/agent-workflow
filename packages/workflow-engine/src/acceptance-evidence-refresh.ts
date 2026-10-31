import type { AcceptanceReceiptReference, StructuredAcceptanceContract } from "../../model-providers/src/types.js";

/** Only runtime-loaded command artifacts belong here, never provider-authored observations. */
export interface GovernedCommandObservation {
  artifactId: string;
  reference: AcceptanceReceiptReference;
  projectId: string;
  commandLine: string;
  sourcePaths?: string[];
  sourceBefore?: string;
  sourceAfter?: string;
  passed: boolean;
}

const referenceFields = ["artifactUri", "runId", "taskId", "stageId", "kind", "contentHash", "observedAt", "subjectHash"] as const;
function sameReference(a: AcceptanceReceiptReference, b: AcceptanceReceiptReference): boolean {
  return referenceFields.every((key) => a[key] === b[key]);
}
function validFor(contract: StructuredAcceptanceContract, observation: GovernedCommandObservation): boolean {
  const ref = observation.reference;
  return observation.passed === true && observation.projectId === contract.projectId
    && ref.runId === contract.originRunId && ref.kind === "command_output"
    && ref.artifactUri.startsWith("db://") && !!ref.taskId && !!ref.stageId && !!ref.contentHash
    && Number.isFinite(Date.parse(ref.observedAt)) && ref.subjectHash === contract.subjectHash
    && !!observation.commandLine.trim() && !!observation.artifactId
    && (!contract.sourcePaths || (JSON.stringify(observation.sourcePaths) === JSON.stringify(contract.sourcePaths)
      && observation.sourceBefore === contract.subjectHash && observation.sourceAfter === contract.subjectHash));
}

/**
 * Refresh references supplied to a provider, not stored contracts or past outputs.
 * A rerun supersedes an old success even when it failed or drifted: in that case
 * leave the stale reference untouched so the authoritative resolver rejects it.
 * Nothing here changes status, gaps, requirements, gate coverage or authority.
 */
export function refreshAcceptanceEvidence(
  contract: StructuredAcceptanceContract,
  observations: readonly GovernedCommandObservation[]
): { contract: StructuredAcceptanceContract; replacements: Array<{ from: string; to: string }> } {
  const replacements: Array<{ from: string; to: string }> = [];
  const refresh = (reference: AcceptanceReceiptReference): AcceptanceReceiptReference => {
    const original = observations.find((item) => sameReference(item.reference, reference));
    if (!original || !validFor(contract, original)) return reference;
    // Consider failures and source/project mismatches too. Never filter to successes
    // before choosing the latest execution of this run's exact command string.
    const matching = observations.filter((item) => item.reference.runId === contract.originRunId
      && item.commandLine === original.commandLine);
    if (matching.some((item) => !Number.isFinite(Date.parse(item.reference.observedAt)) || !item.artifactId)) return reference;
    const latest = matching.sort((a, b) =>
      Date.parse(b.reference.observedAt) - Date.parse(a.reference.observedAt)
      || (b.artifactId > a.artifactId ? 1 : b.artifactId < a.artifactId ? -1 : 0))[0];
    if (!latest || !validFor(contract, latest) || sameReference(reference, latest.reference)) return reference;
    replacements.push({ from: reference.artifactUri, to: latest.reference.artifactUri });
    return { ...latest.reference };
  };
  return { contract: { ...contract, deliverables: contract.deliverables.map((item) => ({
    ...item,
    receipts: Object.fromEntries(Object.entries(item.receipts).map(([gate, refs]) => [gate, refs?.map(refresh)]))
  })) }, replacements };
}

import { acceptanceDigest } from "./acceptance.js";
import type { AcceptanceReceiptReference } from "../../model-providers/src/types.js";

type EvidenceRow = { uri: string; content: Record<string, unknown>; runId?: string; taskId?: string | null; stageId?: string; createdAt?: string | Date };

/** Exact stored observations only; this does not decide deliverable acceptance. */
export function commandAcceptanceReference(row: EvidenceRow): AcceptanceReceiptReference | undefined {
  if (!row.runId || !row.taskId || !row.stageId || !row.createdAt || typeof row.content.subjectHash !== "string" || !row.content.subjectHash) return undefined;
  const date = new Date(row.createdAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return { artifactUri: row.uri, runId: row.runId, taskId: row.taskId, stageId: row.stageId, kind: "command_output",
    contentHash: acceptanceDigest(row.content), observedAt: date.toISOString(), subjectHash: row.content.subjectHash };
}

/** Bounded observations, never instructions or an assertion of acceptance. */
export function commandEvidencePacket(rows: EvidenceRow[]): string {
  return JSON.stringify(rows.slice(-12).map((row) => {
    const { uri, content } = row;
    return {
    acceptanceReference: commandAcceptanceReference(row),
    artifactUri: uri,
    command: String(content.commandLine ?? "").slice(0, 300),
    exitCode: content.exitCode ?? null,
    timedOut: content.timedOut ?? null,
    stdoutTail: String(content.stdout ?? "").slice(-650),
    stderrTail: String(content.stderr ?? "").slice(-250)
  }; }));
}

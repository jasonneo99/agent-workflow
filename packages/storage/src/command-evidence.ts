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

export const COMMAND_EVIDENCE_CONTENT_MAX_BYTES = 64 * 1024;
export const COMMAND_EVIDENCE_PACKET_MAX_BYTES = 128 * 1024;

/** Bounded stored observations, never instructions or acceptance.
 * Full payloads require recorded command ownership. This describes completeness
 * of stored evidence only; an executor may already have limited stream capture.
 */
export function commandEvidencePacket(rows: EvidenceRow[]): string {
  const selected = rows.slice(-12).map(row => ({
    row,
    reference: commandAcceptanceReference(row),
    contentBytes: Buffer.byteLength(JSON.stringify(row.content), "utf8")
  }));
  const packet: Record<string, unknown>[] = selected.map(({ row, reference, contentBytes }) => {
    const command = String(row.content.commandLine ?? "");
    // Ownership of stored diagnostics is independent of acceptance enrollment.
    // Prepared source runs carry an environment source binding, but need not
    // have a legacy acceptance subjectHash. Never manufacture that reference.
    const owned = Boolean(row.runId && row.taskId && row.stageId && row.createdAt)
      && Number.isFinite(new Date(row.createdAt!).getTime())
      && row.uri.startsWith(`db://workflow_runs/${row.runId}/command_output/`)
      && row.content.requestedByTaskId === row.taskId
      && row.content.requestedByStageId === row.stageId;
    const preview: Record<string, unknown> = {
      acceptanceReference: reference,
      commandOwnership: owned ? "verified" : "unverified",
      artifactUri: row.uri.slice(0, 1024),
      artifactUriTruncated: row.uri.length > 1024,
      command: command.slice(0, 4096),
      commandTruncated: command.length > 4096,
      exitCode: typeof row.content.exitCode === "number" && Number.isInteger(row.content.exitCode) ? row.content.exitCode : null,
      timedOut: typeof row.content.timedOut === "boolean" ? row.content.timedOut : null,
      stdoutTail: String(row.content.stdout ?? "").slice(-650),
      stderrTail: String(row.content.stderr ?? "").slice(-250),
      contentHash: reference?.contentHash ?? acceptanceDigest(row.content),
      storedContentBytes: contentBytes,
      storedContentComplete: false,
      executionOutputCompleteness: "not-attested",
      omissionReason: !owned ? "unverified-command-ownership"
        : contentBytes > COMMAND_EVIDENCE_CONTENT_MAX_BYTES ? "stored-content-limit" : "packet-budget"
    };
    // Even malformed legacy identities cannot make the metadata unbounded.
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") > 8192) {
      delete preview.acceptanceReference;
      preview.referenceOmitted = true;
      preview.artifactUri = row.uri.slice(0, 256);
      preview.artifactUriTruncated = row.uri.length > 256;
      preview.command = command.slice(0, 300);
      preview.commandTruncated = command.length > 300;
      preview.stdoutTail = String(row.content.stdout ?? "").slice(-200);
      preview.stderrTail = String(row.content.stderr ?? "").slice(-100);
      preview.metadataTruncated = true;
      preview.omissionReason = "metadata-limit";
    }
    return preview;
  });
  // Preserve the familiar chronological order, allocating full-body space to
  // newest observations first. Omitted bodies remain explicit previews.
  for (let i = selected.length - 1; i >= 0; i--) {
    const entry = selected[i]!;
    if (packet[i]!.omissionReason !== "packet-budget") continue;
    const previous = packet[i]!;
    const complete: Record<string, unknown> = { ...previous, storedContent: entry.row.content, storedContentComplete: true };
    delete complete.omissionReason;
    packet[i] = complete;
    if (Buffer.byteLength(JSON.stringify(packet), "utf8") > COMMAND_EVIDENCE_PACKET_MAX_BYTES) {
      packet[i] = previous;
    }
  }
  return JSON.stringify(packet);
}

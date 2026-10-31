import { createHash } from "node:crypto";
import { normalizeRequestedFileMutation, type RequestedFileMutation } from "./file-patcher.js";

/** Resolve only the exact mutation bound to the durable approval. */
export function selectApprovedFileMutation(
  target: string, approval: Record<string, unknown>, writes: unknown[],
) {
  for (const value of writes) {
    if (!value || typeof value !== "object") continue;
    const request = value as RequestedFileMutation;
    if (request.path !== target) continue;
    const mutation = normalizeRequestedFileMutation(request);
    if (!mutation) continue;
    if (mutation.isPatch) {
      if (approval.mode !== "patch" || !approval.payloadHash
          || approval.expectedHash !== mutation.expectedHash) continue;
    } else if (approval.mode !== undefined && approval.mode !== "replace") continue;
    const digest = createHash("sha256").update(mutation.payload).digest("hex");
    if (approval.payloadHash && digest !== approval.payloadHash) continue;
    return { request, payload: mutation.payload, isPatch: mutation.isPatch,
      expectedHash: mutation.expectedHash };
  }
  throw new Error("Approved file mutation was not found or its binding changed in the source stage artifact.");
}

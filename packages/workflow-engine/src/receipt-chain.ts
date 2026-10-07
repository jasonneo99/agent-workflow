import { createHash } from "node:crypto";

/**
 * Tamper-evident hash chaining for action receipts.
 *
 * Each receipt commits to the hash of the previous receipt for the same run,
 * forming a per-run chain. Any modification, deletion, or reordering of a
 * receipt breaks the chain and is detectable via verifyReceiptChain().
 *
 * Chain: receipt_hash = sha256(prev_hash + canonical(receipt content))
 * Genesis: prev_hash = "GENESIS" for the first receipt of a run.
 */

export const RECEIPT_CHAIN_GENESIS = "GENESIS";

export type ReceiptChainContent = {
  runId: string;
  agentId: string;
  actionType: string;
  target: string;
  summary: string;
  metadata: string; // canonical JSON string
  metadataSerializationVersion?: number;
  createdAt: string; // ISO timestamp
};

/** Version 2 sorts object keys recursively while retaining array order. */
export function canonicalReceiptMetadata(metadata: string): string {
  function encode(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${encode(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) as string;
  }
  return encode(JSON.parse(metadata));
}
export function canonicalReceiptJson(content: ReceiptChainContent): string {
  if (content.metadataSerializationVersion !== undefined && content.metadataSerializationVersion !== 2) {
    throw new Error(`Unsupported receipt metadata serialization version: ${content.metadataSerializationVersion}`);
  }
  return JSON.stringify({
    runId: content.runId,
    agentId: content.agentId,
    actionType: content.actionType,
    target: content.target,
    summary: content.summary,
    metadata: content.metadataSerializationVersion === 2
      ? canonicalReceiptMetadata(content.metadata)
      : content.metadata,
    createdAt: content.createdAt,
    ...(content.metadataSerializationVersion === 2
      ? { metadataSerializationVersion: 2 } : {}),
  });
}

export function computeReceiptHash(prevHash: string, content: ReceiptChainContent): string {
  return createHash("sha256")
    .update(prevHash + "\n" + canonicalReceiptJson(content))
    .digest("hex");
}

export type ChainedReceipt = ReceiptChainContent & {
  prevHash: string;
  receiptHash: string;
};

export function chainReceipt(prevHash: string, content: ReceiptChainContent): ChainedReceipt {
  return {
    ...content,
    prevHash,
    receiptHash: computeReceiptHash(prevHash, content),
  };
}

export type ChainVerificationResult = {
  valid: boolean;
  checked: number;
  /** index of first broken link, if any */
  brokenAt?: number;
  reason?: string;
};

export function verifyReceiptChain(receipts: ChainedReceipt[]): ChainVerificationResult {
  let prevHash = RECEIPT_CHAIN_GENESIS;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (r.prevHash !== prevHash) {
      return {
        valid: false,
        checked: i,
        brokenAt: i,
        reason: `prev_hash mismatch at index ${i}: expected ${prevHash.slice(0, 12)}..., got ${r.prevHash.slice(0, 12)}...`,
      };
    }
    let expected: string;
    try {
      expected = computeReceiptHash(r.prevHash, r);
    } catch {
      return {
        valid: false,
        checked: i,
        brokenAt: i,
        reason: `Invalid metadata or unsupported serialization version at index ${i}`,
      };
    }
    if (r.receiptHash !== expected) {
      return {
        valid: false,
        checked: i,
        brokenAt: i,
        reason: `receipt_hash mismatch at index ${i}: stored content does not reproduce the recorded hash; legacy serialization may be unrecoverable`,
      };
    }
    prevHash = r.receiptHash;
  }
  return { valid: true, checked: receipts.length };
}

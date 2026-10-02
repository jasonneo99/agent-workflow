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
  createdAt: string; // ISO timestamp
};

export function canonicalReceiptJson(content: ReceiptChainContent): string {
  return JSON.stringify({
    runId: content.runId,
    agentId: content.agentId,
    actionType: content.actionType,
    target: content.target,
    summary: content.summary,
    metadata: content.metadata,
    createdAt: content.createdAt,
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
    const expected = computeReceiptHash(r.prevHash, r);
    if (r.receiptHash !== expected) {
      return {
        valid: false,
        checked: i,
        brokenAt: i,
        reason: `receipt_hash mismatch at index ${i}: content was modified after chaining`,
      };
    }
    prevHash = r.receiptHash;
  }
  return { valid: true, checked: receipts.length };
}

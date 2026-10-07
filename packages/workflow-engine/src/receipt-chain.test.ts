import assert from "node:assert/strict";
import test from "node:test";
import { RECEIPT_CHAIN_GENESIS, chainReceipt, computeReceiptHash, verifyReceiptChain, type ChainedReceipt } from "./receipt-chain.js";

function makeContent(n: number) {
  return {
    runId: "run-1",
    agentId: "agent-1",
    actionType: "local_command",
    target: `cmd-${n}`,
    summary: `action ${n}`,
    metadata: JSON.stringify({ n }),
    createdAt: new Date(2026, 0, 1, 0, 0, n).toISOString(),
  };
}

test("chainReceipt links to previous hash", () => {
  const r1 = chainReceipt(RECEIPT_CHAIN_GENESIS, makeContent(1));
  assert.equal(r1.prevHash, RECEIPT_CHAIN_GENESIS);
  assert.ok(r1.receiptHash.length === 64);
  const r2 = chainReceipt(r1.receiptHash, makeContent(2));
  assert.equal(r2.prevHash, r1.receiptHash);
});

test("verifyReceiptChain accepts a valid chain", () => {
  const receipts: ChainedReceipt[] = [];
  let prev = RECEIPT_CHAIN_GENESIS;
  for (let i = 1; i <= 5; i++) {
    const r = chainReceipt(prev, makeContent(i));
    receipts.push(r);
    prev = r.receiptHash;
  }
  const result = verifyReceiptChain(receipts);
  assert.equal(result.valid, true);
  assert.equal(result.checked, 5);
});

test("verifyReceiptChain detects modified content", () => {
  const r1 = chainReceipt(RECEIPT_CHAIN_GENESIS, makeContent(1));
  const r2 = chainReceipt(r1.receiptHash, makeContent(2));
  const tampered: ChainedReceipt = { ...r2, summary: "evil modified summary" };
  const result = verifyReceiptChain([r1, tampered]);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.reason ?? "", /receipt_hash mismatch/);
});

test("verifyReceiptChain detects reordered receipts", () => {
  const r1 = chainReceipt(RECEIPT_CHAIN_GENESIS, makeContent(1));
  const r2 = chainReceipt(r1.receiptHash, makeContent(2));
  const result = verifyReceiptChain([r2, r1]);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 0);
});

test("verifyReceiptChain detects a deleted receipt", () => {
  const r1 = chainReceipt(RECEIPT_CHAIN_GENESIS, makeContent(1));
  const r2 = chainReceipt(r1.receiptHash, makeContent(2));
  const r3 = chainReceipt(r2.receiptHash, makeContent(3));
  // attacker deletes r2
  const result = verifyReceiptChain([r1, r3]);
  assert.equal(result.valid, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.reason ?? "", /prev_hash mismatch/);
});

test("computeReceiptHash is deterministic", () => {
  const c = makeContent(1);
  assert.equal(computeReceiptHash("prev", c), computeReceiptHash("prev", c));
});

test("version 2 canonicalizes nested objects but preserves array order and legacy hashes", () => {
  const content = { ...makeContent(1), metadataSerializationVersion: 2,
    metadata: '{"z":{"b":2,"a":1},"a":[3,2,1]}' };
  const receipt = chainReceipt(RECEIPT_CHAIN_GENESIS, content);
  const stored = { ...receipt, metadata: '{"a": [3,2,1], "z": {"a":1,"b":2}}' };
  assert.deepEqual(verifyReceiptChain([stored]), { valid: true, checked: 1 });
  for (const mutation of [
    { metadata: '{"a":[1,2,3],"z":{"a":1,"b":2}}' },
    { metadata: 'invalid JSON' }, { metadataSerializationVersion: undefined },
    { metadataSerializationVersion: 99 }, { summary: 'changed' }, { runId: 'different' },
  ]) assert.equal(verifyReceiptChain([{ ...stored, ...mutation }]).valid, false);
  const legacy = chainReceipt(RECEIPT_CHAIN_GENESIS, makeContent(1));
  assert.deepEqual(verifyReceiptChain([legacy]), { valid: true, checked: 1 });
  assert.equal(verifyReceiptChain([{ ...legacy, metadata: '{"n": 1}' }]).valid, false);
});

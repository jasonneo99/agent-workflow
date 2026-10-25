import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryInputQueue } from "./index.js";
import { chainReceipt, RECEIPT_CHAIN_GENESIS, verifyReceiptChain, type ChainedReceipt } from "../../workflow-engine/src/receipt-chain.js";
import { ExistingReceiptChainSink, GovernedRuntimeDispatcher, OriginCallbackBridge } from "./integration.js";

test("policy gates executor dispatch and approval uses the existing outbox port", async () => {
  const calls: string[] = [];
  const dispatcher = new GovernedRuntimeDispatcher({ runId: "run-1",
    authority: { async authorize() { calls.push("policy"); return { effect: "approval_required", approvalId: "approval-1" }; } },
    executor: { async start() { calls.push("executor"); } },
    approvals: { async request(input) { calls.push(`approval:${input.resultEventId}`); } }
  });
  await dispatcher.dispatch({ threadId: "thread-a", toolCall: { id: "tool-1", name: "write", arguments: {} } });
  assert.deepEqual(calls, ["policy", "approval:tool-result:tool-1"]);
});

test("denied dispatch reaches neither executor nor approvals", async () => {
  let sideEffects = 0;
  const dispatcher = new GovernedRuntimeDispatcher({ runId: "run-1",
    authority: { async authorize() { return { effect: "deny", reason: "outside policy" }; } },
    executor: { async start() { sideEffects += 1; } }, approvals: { async request() { sideEffects += 1; } }
  });
  await assert.rejects(dispatcher.dispatch({ threadId: "thread-a", toolCall: { id: "tool-1", name: "write", arguments: {} } }), /outside policy/u);
  assert.equal(sideEffects, 0);
});

test("transport acceptance does not resume a callback; authenticated acknowledgment does", async () => {
  const queue = new InMemoryInputQueue();
  let acknowledged = false;
  const bridge = new OriginCallbackBridge({ runId: "run-1", queue, notifications: {
    async enqueue() { return "notification-1"; }, async isAcknowledged() { return acknowledged; }
  } });
  assert.equal(await bridge.resumeAfterAcknowledgment({ notificationId: "notification-1", threadId: "thread-a", inputId: "ack-1" }), false);
  assert.equal(await queue.depth("thread-a"), 0);
  acknowledged = true;
  assert.equal(await bridge.resumeAfterAcknowledgment({ notificationId: "notification-1", threadId: "thread-a", inputId: "ack-1" }), true);
  assert.equal(await queue.depth("thread-a"), 1);
});

test("slice receipt adapter preserves the existing tamper-evident chain", async () => {
  const chain: ChainedReceipt[] = [];
  const sink = new ExistingReceiptChainSink({ async append(receipt) {
    const previous = chain.at(-1)?.receiptHash ?? RECEIPT_CHAIN_GENESIS;
    chain.push(chainReceipt(previous, { runId: "00000000-0000-4000-8000-000000000001", agentId: receipt.threadId,
      actionType: receipt.action, target: receipt.inputId ?? receipt.threadId, summary: receipt.action,
      metadata: JSON.stringify(receipt.detail ?? {}), metadataSerializationVersion: 2, createdAt: new Date().toISOString() }));
  } });
  await sink.record({ threadId: "thread-a", inputId: "input-1", action: "slice_started" });
  await sink.record({ threadId: "thread-a", inputId: "input-1", action: "slice_committed" });
  assert.deepEqual(verifyReceiptChain(chain), { valid: true, checked: 2 });
});

import assert from "node:assert/strict";
import test from "node:test";
import { redisLeaseKey, withIdempotencyLease, type LeaseStore } from "./index.js";

class MemoryLeaseStore implements LeaseStore {
  owner: string | null = null;
  async acquire(_key: string, owner: string): Promise<boolean> {
    if (this.owner) return false;
    this.owner = owner;
    return true;
  }
  async release(_key: string, owner: string): Promise<boolean> {
    if (this.owner !== owner) return false;
    this.owner = null;
    return true;
  }
  async renew(_key: string, owner: string): Promise<boolean> { return this.owner === owner; }
  async close(): Promise<void> {}
}

test("lease keys are namespaced and sanitize unsafe input", () => {
  assert.equal(redisLeaseKey("approval action", "abc/../../secret"), "agentflow:lease:approval_action:abc_______secret");
});

test("concurrent callers execute once and replay the durable result", async () => {
  const store = new MemoryLeaseStore();
  let durable: string | null = null;
  let executions = 0;
  const invoke = () => withIdempotencyLease({
    store,
    key: "same-request",
    waitMs: 1_000,
    pollMs: 5,
    findCompleted: async () => durable,
    execute: async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      durable = "receipt-1";
      return durable;
    }
  });
  const [first, second] = await Promise.all([invoke(), invoke()]);
  assert.equal(executions, 1);
  assert.deepEqual(new Set([first.state, second.state]), new Set(["executed", "replayed"]));
  assert.equal(first.value, "receipt-1");
  assert.equal(second.value, "receipt-1");
});

test("a failed executor releases its reservation for retry", async () => {
  const store = new MemoryLeaseStore();
  await assert.rejects(() => withIdempotencyLease({
    store,
    key: "retryable",
    findCompleted: async () => null,
    execute: async () => { throw new Error("interrupted"); }
  }), /interrupted/u);
  const retried = await withIdempotencyLease({
    store,
    key: "retryable",
    findCompleted: async () => null,
    execute: async () => "recovered"
  });
  assert.equal(retried.value, "recovered");
});

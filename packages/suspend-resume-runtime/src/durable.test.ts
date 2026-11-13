import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryReceiptSink, SuspendResumeRuntime } from "./index.js";
import { LocalJsonInputQueue, LocalJsonSliceStore } from "./durable.js";

test("a suspended thread resumes after every runtime object is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-suspend-resume-"));
  try {
    let completions = 0;
    const model = { async complete() { completions += 1; return { message: "done" }; } };
    let store = new LocalJsonSliceStore(directory);
    let queue = new LocalJsonInputQueue(directory);
    await store.createThread("thread-a");
    await queue.enqueue({ id: "before-restart", threadId: "thread-a", kind: "user_text", payload: "hello", createdAt: "now" });
    let runtime = new SuspendResumeRuntime({ queue, store, model, dispatchTool: async () => undefined, receipts: new InMemoryReceiptSink() });
    await runtime.processNext("thread-a");

    store = new LocalJsonSliceStore(directory);
    queue = new LocalJsonInputQueue(directory);
    runtime = new SuspendResumeRuntime({ queue, store, model, dispatchTool: async () => undefined, receipts: new InMemoryReceiptSink() });
    assert.deepEqual(await runtime.processNext("thread-a"), { outcome: "idle", threadId: "thread-a" });
    await queue.enqueue({ id: "after-restart", threadId: "thread-a", kind: "user_text", payload: "resume", createdAt: "now" });
    await runtime.processNext("thread-a");
    assert.equal(completions, 2);
    assert.deepEqual((await store.loadThread("thread-a"))?.processedInputIds, ["before-restart", "after-restart"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a redelivered durable input is skipped after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentflow-suspend-resume-"));
  try {
    let completions = 0;
    const store = new LocalJsonSliceStore(directory);
    let queue = new LocalJsonInputQueue(directory);
    await store.createThread("thread-a");
    const message = { id: "stable", threadId: "thread-a", kind: "user_text" as const, payload: "hello", createdAt: "now" };
    await queue.enqueue(message);
    await new SuspendResumeRuntime({ queue, store, model: { async complete() { completions += 1; return {}; } }, dispatchTool: async () => undefined, receipts: new InMemoryReceiptSink() }).processNext("thread-a");
    queue = new LocalJsonInputQueue(directory);
    await queue.enqueue(message);
    const result = await new SuspendResumeRuntime({ queue, store: new LocalJsonSliceStore(directory), model: { async complete() { completions += 1; return {}; } }, dispatchTool: async () => undefined, receipts: new InMemoryReceiptSink() }).processNext("thread-a");
    assert.equal(result.outcome, "duplicate");
    assert.equal(completions, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

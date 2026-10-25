import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInputQueue,
  InMemoryReceiptSink,
  InMemorySliceStore,
  SuspendResumeRuntime,
  type SliceModel,
  type ThreadInput,
  type ToolCall
} from "./index.js";

function input(id: string, threadId: string, payload = id): ThreadInput {
  return { id, threadId, kind: "user_text", payload, createdAt: "2026-10-25T00:00:00.000Z" };
}

function harness(model: SliceModel, dispatchTool: (value: { threadId: string; toolCall: ToolCall }) => Promise<void> = async () => undefined) {
  const queue = new InMemoryInputQueue();
  const store = new InMemorySliceStore();
  const receipts = new InMemoryReceiptSink();
  const runtime = new SuspendResumeRuntime({ queue, store, model, dispatchTool, receipts });
  return { queue, store, receipts, runtime };
}

test("a slice runs one completion, commits the turn, dispatches once, and suspends", async () => {
  let completions = 0;
  const order: string[] = [];
  const h = harness({ async complete() {
    completions += 1;
    return { message: "starting", toolCalls: [{ id: "tool-1", name: "build", arguments: { target: "test" } }] };
  } }, async () => { order.push("dispatch"); });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("input-1", "thread-a"));

  const originalCommit = h.store.commitSlice.bind(h.store);
  h.store.commitSlice = async (value) => { order.push("commit"); return originalCommit(value); };
  const result = await h.runtime.processNext("thread-a");

  assert.deepEqual(result, { outcome: "suspended", threadId: "thread-a", inputId: "input-1", pendingToolCallId: "tool-1" });
  assert.equal(completions, 1);
  assert.deepEqual(order, ["commit", "dispatch"]);
  assert.deepEqual((await h.store.loadConversation("thread-a")).map((entry) => entry.kind), ["user_text", "message", "tool_call"]);
  assert.equal((await h.store.loadThread("thread-a"))?.pendingDispatch, null);
});

test("more than one tool call rejects the slice and preserves the queued input", async () => {
  const h = harness({ async complete() { return { toolCalls: [
    { id: "tool-1", name: "first", arguments: {} },
    { id: "tool-2", name: "second", arguments: {} }
  ] }; } });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("input-1", "thread-a"));
  await assert.rejects(h.runtime.processNext("thread-a"), /at most one tool call/u);
  assert.equal(await h.queue.depth("thread-a"), 1);
  assert.deepEqual(await h.store.loadConversation("thread-a"), []);
});

test("redelivery is acknowledged and skipped without another model completion", async () => {
  let completions = 0;
  const h = harness({ async complete() { completions += 1; return { message: "done" }; } });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("stable-input", "thread-a"));
  await h.runtime.processNext("thread-a");
  await h.queue.enqueue(input("stable-input", "thread-a"));

  assert.deepEqual(await h.runtime.processNext("thread-a"), { outcome: "duplicate", threadId: "thread-a", inputId: "stable-input" });
  assert.equal(completions, 1);
  assert.equal(await h.queue.depth("thread-a"), 0);
  assert.equal(h.receipts.receipts.at(-1)?.action, "input_duplicate");
});

test("failed dispatch stays durable and retries without replaying the model", async () => {
  let completions = 0;
  let dispatches = 0;
  const h = harness({ async complete() {
    completions += 1;
    return { toolCalls: [{ id: "stable-tool", name: "long-build", arguments: {} }] };
  } }, async () => {
    dispatches += 1;
    if (dispatches === 1) throw new Error("worker offline");
  });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("input-1", "thread-a"));

  assert.deepEqual(await h.runtime.processNext("thread-a"), {
    outcome: "dispatch_pending", threadId: "thread-a", toolCallId: "stable-tool", error: "worker offline"
  });
  assert.equal((await h.store.loadThread("thread-a"))?.pendingDispatch?.id, "stable-tool");
  assert.deepEqual(await h.runtime.processNext("thread-a"), { outcome: "idle", threadId: "thread-a" });
  assert.equal(completions, 1);
  assert.equal(dispatches, 2);
  assert.equal((await h.store.loadThread("thread-a"))?.pendingDispatch, null);
});

test("same-thread inputs stay ordered and concurrent calls do not overlap completions", async () => {
  let active = 0;
  let maxActive = 0;
  const seen: string[] = [];
  const h = harness({ async complete({ message }) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    seen.push(message.id);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { message: message.id };
  } });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("first", "thread-a"));
  await h.queue.enqueue(input("second", "thread-a"));

  await Promise.all([h.runtime.processNext("thread-a"), h.runtime.processNext("thread-a")]);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(maxActive, 1);
});

test("different threads can run slices in parallel", async () => {
  let active = 0;
  let maxActive = 0;
  const h = harness({ async complete() {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { message: "done" };
  } });
  for (const threadId of ["thread-a", "thread-b"]) {
    await h.store.createThread(threadId);
    await h.queue.enqueue(input(`input-${threadId}`, threadId));
  }

  await Promise.all([h.runtime.processNext("thread-a"), h.runtime.processNext("thread-b")]);
  assert.equal(maxActive, 2);
});

test("a suspended thread performs no model work without another input", async () => {
  let completions = 0;
  const h = harness({ async complete() { completions += 1; return { message: "waiting" }; } });
  await h.store.createThread("thread-a");
  await h.queue.enqueue(input("input-1", "thread-a"));
  await h.runtime.processNext("thread-a");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await h.runtime.processNext("thread-a"), { outcome: "idle", threadId: "thread-a" });
  }
  assert.equal(completions, 1);
});

test("stale revisions cannot commit another turn", async () => {
  const store = new InMemorySliceStore();
  await store.createThread("thread-a");
  const commit = { threadId: "thread-a", expectedRevision: 0, inputId: "input-1", entries: [], status: "suspended" as const, pendingDispatch: null };
  assert.equal((await store.commitSlice(commit)).committed, true);
  await assert.rejects(store.commitSlice({ ...commit, inputId: "input-2" }), /Stale thread revision/u);
});

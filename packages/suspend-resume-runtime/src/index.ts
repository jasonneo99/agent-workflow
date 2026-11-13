export type ThreadStatus = "ready" | "running" | "suspended" | "completed";
export type InputKind = "user_text" | "tool_result" | "tool_event" | "thread_message";

export interface ThreadInput<T = unknown> {
  id: string;
  threadId: string;
  kind: InputKind;
  payload: T;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ConversationEntry =
  | { id: string; sourceInputId: string; role: "user"; kind: "user_text"; content: string }
  | { id: string; sourceInputId: string; role: "user"; kind: "thread_message"; fromThreadId: string; content: unknown }
  | { id: string; sourceInputId: string; role: "tool"; kind: "tool_result"; toolCallId: string; content: unknown }
  | { id: string; sourceInputId: string; role: "assistant"; kind: "message"; content: string }
  | { id: string; sourceInputId: string; role: "assistant"; kind: "tool_call"; toolCall: ToolCall; synthetic: boolean };

export interface ThreadState {
  threadId: string;
  revision: number;
  status: ThreadStatus;
  processedInputIds: readonly string[];
  issuedToolCallIds: readonly string[];
  answeredToolCallIds: readonly string[];
  pendingDispatch: ToolCall | null;
  parentThreadId: string | null;
  childThreadIds: readonly string[];
}

export interface ConversationStore {
  loadConversation(threadId: string): Promise<readonly ConversationEntry[]>;
}

export interface ThreadStateStore {
  createThread(threadId: string, options?: { parentThreadId?: string }): Promise<ThreadState>;
  loadThread(threadId: string): Promise<ThreadState | null>;
  linkChild?(parentThreadId: string, childThreadId: string): Promise<void>;
}

export interface SliceCommit {
  threadId: string;
  expectedRevision: number;
  inputId: string;
  entries: readonly ConversationEntry[];
  status: ThreadStatus;
  pendingDispatch: ToolCall | null;
  answeredToolCallIds?: readonly string[];
  issuedToolCallIds?: readonly string[];
}

export type SliceCommitResult =
  | { committed: true; state: ThreadState }
  | { committed: false; reason: "duplicate_input"; state: ThreadState };

export interface SliceStore extends ConversationStore, ThreadStateStore {
  commitSlice(input: SliceCommit): Promise<SliceCommitResult>;
  markDispatchStarted(threadId: string, expectedRevision: number, toolCallId: string): Promise<ThreadState>;
}

export interface InputLease {
  message: ThreadInput;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

export interface ThreadInputQueue {
  enqueue(message: ThreadInput): Promise<void>;
  lease(threadId: string): Promise<InputLease | null>;
  depth(threadId: string): Promise<number>;
}

export interface AsyncToolContext {
  threadId: string;
  toolCall: ToolCall;
  emit(input: Omit<ThreadInput, "threadId" | "createdAt"> & { createdAt?: string }): Promise<void>;
}

/** Tools start work and return after registration, never after the work itself. */
export interface AsyncTool {
  name: string;
  execute(context: AsyncToolContext): Promise<void>;
}

export class AsyncToolDispatcher {
  readonly #tools = new Map<string, AsyncTool>();

  constructor(tools: readonly AsyncTool[], private readonly queue: ThreadInputQueue) {
    for (const tool of tools) {
      assertIdentity(tool.name, "Tool name");
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }

  async dispatch(input: { threadId: string; toolCall: ToolCall }): Promise<void> {
    const tool = this.#tools.get(input.toolCall.name);
    if (!tool) throw new Error(`Unknown tool: ${input.toolCall.name}`);
    await tool.execute({
      ...clone(input),
      emit: async (message) => this.queue.enqueue({
        ...clone(message),
        threadId: input.threadId,
        createdAt: message.createdAt ?? new Date().toISOString()
      })
    });
  }
}

export interface ModelCompletion {
  message?: string;
  toolCalls?: readonly ToolCall[];
}

export interface SliceModel {
  complete(input: {
    thread: ThreadState;
    conversation: readonly ConversationEntry[];
    message: ThreadInput;
  }): Promise<ModelCompletion>;
}

export interface SliceReceipt {
  sequence: number;
  threadId: string;
  inputId?: string;
  action: "slice_started" | "slice_committed" | "input_duplicate" | "dispatch_started" | "dispatch_failed" | "thread_suspended" | "thread_spawned" | "parent_reported";
  detail?: Record<string, unknown>;
}

export interface SliceReceiptSink {
  record(receipt: Omit<SliceReceipt, "sequence">): Promise<void>;
}

export type SliceResult =
  | { outcome: "idle"; threadId: string }
  | { outcome: "duplicate"; threadId: string; inputId: string }
  | { outcome: "suspended"; threadId: string; inputId: string; pendingToolCallId?: string }
  | { outcome: "dispatch_pending"; threadId: string; toolCallId: string; error: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 200) throw new Error(`${label} must be a nonempty bounded string.`);
}

export class InMemoryInputQueue implements ThreadInputQueue {
  readonly #messages = new Map<string, ThreadInput[]>();
  readonly #leased = new Set<string>();

  async enqueue(message: ThreadInput): Promise<void> {
    assertIdentity(message.id, "Input ID");
    assertIdentity(message.threadId, "Thread ID");
    const messages = this.#messages.get(message.threadId) ?? [];
    messages.push(clone(message));
    this.#messages.set(message.threadId, messages);
  }

  async lease(threadId: string): Promise<InputLease | null> {
    if (this.#leased.has(threadId)) return null;
    const messages = this.#messages.get(threadId);
    const message = messages?.[0];
    if (!message) return null;
    this.#leased.add(threadId);
    let settled = false;
    const settle = (acknowledge: boolean): void => {
      if (settled) return;
      settled = true;
      if (acknowledge) {
        const current = this.#messages.get(threadId);
        if (current?.[0]?.id === message.id) current.shift();
        if (current?.length === 0) this.#messages.delete(threadId);
      }
      this.#leased.delete(threadId);
    };
    return {
      message: clone(message),
      ack: async () => settle(true),
      nack: async () => settle(false)
    };
  }

  async depth(threadId: string): Promise<number> {
    return this.#messages.get(threadId)?.length ?? 0;
  }
}

export class InMemorySliceStore implements SliceStore {
  readonly #threads = new Map<string, ThreadState>();
  readonly #conversations = new Map<string, ConversationEntry[]>();

  async createThread(threadId: string, options: { parentThreadId?: string } = {}): Promise<ThreadState> {
    assertIdentity(threadId, "Thread ID");
    const existing = this.#threads.get(threadId);
    if (existing) return clone(existing);
    const state: ThreadState = {
      threadId,
      revision: 0,
      status: "ready",
      processedInputIds: [],
      issuedToolCallIds: [],
      answeredToolCallIds: [],
      pendingDispatch: null,
      parentThreadId: options.parentThreadId ?? null,
      childThreadIds: []
    };
    this.#threads.set(threadId, state);
    this.#conversations.set(threadId, []);
    return clone(state);
  }

  async linkChild(parentThreadId: string, childThreadId: string): Promise<void> {
    const parent = this.#threads.get(parentThreadId);
    const child = this.#threads.get(childThreadId);
    if (!parent || !child) throw new Error("Both parent and child threads must exist.");
    if (child.parentThreadId !== parentThreadId) throw new Error("Child parent identity does not match.");
    if (!parent.childThreadIds.includes(childThreadId)) {
      this.#threads.set(parentThreadId, { ...parent, revision: parent.revision + 1, childThreadIds: [...parent.childThreadIds, childThreadId] });
    }
  }

  async loadThread(threadId: string): Promise<ThreadState | null> {
    const state = this.#threads.get(threadId);
    return state ? clone(state) : null;
  }

  async loadConversation(threadId: string): Promise<readonly ConversationEntry[]> {
    return clone(this.#conversations.get(threadId) ?? []);
  }

  async commitSlice(input: SliceCommit): Promise<SliceCommitResult> {
    const state = this.#threads.get(input.threadId);
    if (!state) throw new Error(`Unknown thread: ${input.threadId}`);
    if (state.processedInputIds.includes(input.inputId)) {
      return { committed: false, reason: "duplicate_input", state: clone(state) };
    }
    if (state.revision !== input.expectedRevision) {
      throw new Error(`Stale thread revision for ${input.threadId}: expected ${input.expectedRevision}, current ${state.revision}.`);
    }
    const next: ThreadState = {
      ...state,
      revision: state.revision + 1,
      status: input.status,
      processedInputIds: [...state.processedInputIds, input.inputId],
      issuedToolCallIds: [...new Set([...state.issuedToolCallIds, ...(input.issuedToolCallIds ?? [])])],
      answeredToolCallIds: [...new Set([...state.answeredToolCallIds, ...(input.answeredToolCallIds ?? [])])],
      pendingDispatch: clone(input.pendingDispatch)
    };
    const conversation = this.#conversations.get(input.threadId) ?? [];
    this.#conversations.set(input.threadId, [...conversation, ...clone(input.entries)]);
    this.#threads.set(input.threadId, next);
    return { committed: true, state: clone(next) };
  }

  async markDispatchStarted(threadId: string, expectedRevision: number, toolCallId: string): Promise<ThreadState> {
    const state = this.#threads.get(threadId);
    if (!state) throw new Error(`Unknown thread: ${threadId}`);
    if (state.revision !== expectedRevision) throw new Error(`Stale thread revision for ${threadId}.`);
    if (state.pendingDispatch?.id !== toolCallId) throw new Error(`Pending tool call does not match ${toolCallId}.`);
    const next = { ...state, revision: state.revision + 1, pendingDispatch: null };
    this.#threads.set(threadId, next);
    return clone(next);
  }
}

export class InMemoryReceiptSink implements SliceReceiptSink {
  readonly receipts: SliceReceipt[] = [];

  async record(receipt: Omit<SliceReceipt, "sequence">): Promise<void> {
    this.receipts.push({ ...clone(receipt), sequence: this.receipts.length + 1 });
  }
}

function inputEntries(message: ThreadInput, state: ThreadState): { entries: ConversationEntry[]; answeredToolCallIds: string[] } {
  if (message.kind === "user_text") {
    if (typeof message.payload !== "string") throw new Error("user_text payload must be a string.");
    return { entries: [{ id: `input:${message.id}`, sourceInputId: message.id, role: "user", kind: "user_text", content: message.payload }], answeredToolCallIds: [] };
  }
  if (message.kind === "thread_message") {
    const payload = message.payload as { fromThreadId?: unknown; content?: unknown };
    if (!payload || typeof payload !== "object" || typeof payload.fromThreadId !== "string") throw new Error("thread_message payload must include fromThreadId.");
    return { entries: [{ id: `input:${message.id}`, sourceInputId: message.id, role: "user", kind: "thread_message", fromThreadId: payload.fromThreadId, content: payload.content }], answeredToolCallIds: [] };
  }
  const payload = message.payload as { toolCallId?: unknown; originToolCallId?: unknown; eventName?: unknown; result?: unknown };
  if (message.kind === "tool_event") {
    if (!payload || typeof payload !== "object" || typeof payload.originToolCallId !== "string" || typeof payload.eventName !== "string") {
      throw new Error("tool_event payload must include originToolCallId and eventName.");
    }
    if (!state.issuedToolCallIds.includes(payload.originToolCallId)) throw new Error(`Unknown originating tool call ${payload.originToolCallId}.`);
    const syntheticId = `synthetic:${message.id}`;
    return {
      entries: [
        { id: `tool-call:${syntheticId}`, sourceInputId: message.id, role: "assistant", kind: "tool_call", synthetic: true,
          toolCall: { id: syntheticId, name: "async_event", arguments: { originToolCallId: payload.originToolCallId, eventName: payload.eventName } } },
        { id: `input:${message.id}`, sourceInputId: message.id, role: "tool", kind: "tool_result", toolCallId: syntheticId, content: payload.result }
      ],
      answeredToolCallIds: [syntheticId]
    };
  }
  if (!payload || typeof payload !== "object" || typeof payload.toolCallId !== "string") {
    throw new Error("tool_result payload must include toolCallId.");
  }
  if (!state.issuedToolCallIds.includes(payload.toolCallId)) throw new Error(`Unknown tool call ${payload.toolCallId}.`);
  if (state.answeredToolCallIds.includes(payload.toolCallId)) throw new Error(`Tool call ${payload.toolCallId} already has a result.`);
  return { entries: [{ id: `input:${message.id}`, sourceInputId: message.id, role: "tool", kind: "tool_result", toolCallId: payload.toolCallId, content: payload.result }], answeredToolCallIds: [payload.toolCallId] };
}

export class AgentThreadCoordinator {
  constructor(private readonly dependencies: { store: SliceStore; queue: ThreadInputQueue; receipts: SliceReceiptSink }) {}

  async spawnThread(input: { parentThreadId: string; childThreadId: string; inputId: string; message: unknown }): Promise<void> {
    const parent = await this.dependencies.store.loadThread(input.parentThreadId);
    if (!parent) throw new Error(`Unknown parent thread: ${input.parentThreadId}`);
    await this.dependencies.store.createThread(input.childThreadId, { parentThreadId: input.parentThreadId });
    await this.dependencies.store.linkChild?.(input.parentThreadId, input.childThreadId);
    await this.dependencies.queue.enqueue({ id: input.inputId, threadId: input.childThreadId, kind: "thread_message", payload: { fromThreadId: input.parentThreadId, content: input.message }, createdAt: new Date().toISOString() });
    await this.dependencies.receipts.record({ threadId: input.parentThreadId, inputId: input.inputId, action: "thread_spawned", detail: { childThreadId: input.childThreadId } });
  }

  async reportToParent(input: { childThreadId: string; inputId: string; report: unknown }): Promise<void> {
    const child = await this.dependencies.store.loadThread(input.childThreadId);
    if (!child?.parentThreadId) throw new Error(`Thread ${input.childThreadId} has no parent.`);
    await this.dependencies.queue.enqueue({ id: input.inputId, threadId: child.parentThreadId, kind: "thread_message", payload: { fromThreadId: input.childThreadId, content: input.report }, createdAt: new Date().toISOString() });
    await this.dependencies.receipts.record({ threadId: input.childThreadId, inputId: input.inputId, action: "parent_reported", detail: { parentThreadId: child.parentThreadId } });
  }
}

export class SuspendResumeRuntime {
  readonly #locks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: {
    queue: ThreadInputQueue;
    store: SliceStore;
    model: SliceModel;
    dispatchTool: (input: { threadId: string; toolCall: ToolCall }) => Promise<void>;
    receipts: SliceReceiptSink;
  }) {}

  async processNext(threadId: string): Promise<SliceResult> {
    const prior = this.#locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = prior.then(() => current);
    this.#locks.set(threadId, chained);
    await prior;
    try {
      return await this.#processNextUnlocked(threadId);
    } finally {
      release();
      if (this.#locks.get(threadId) === chained) this.#locks.delete(threadId);
    }
  }

  async #dispatchPending(state: ThreadState): Promise<SliceResult | null> {
    const pending = state.pendingDispatch;
    if (!pending) return null;
    try {
      await this.dependencies.dispatchTool({ threadId: state.threadId, toolCall: clone(pending) });
      await this.dependencies.store.markDispatchStarted(state.threadId, state.revision, pending.id);
      await this.dependencies.receipts.record({ threadId: state.threadId, action: "dispatch_started", detail: { toolCallId: pending.id, tool: pending.name } });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.dependencies.receipts.record({ threadId: state.threadId, action: "dispatch_failed", detail: { toolCallId: pending.id, error: message } });
      return { outcome: "dispatch_pending", threadId: state.threadId, toolCallId: pending.id, error: message };
    }
  }

  async #processNextUnlocked(threadId: string): Promise<SliceResult> {
    const initialState = await this.dependencies.store.loadThread(threadId);
    if (!initialState) throw new Error(`Unknown thread: ${threadId}`);
    const pendingResult = await this.#dispatchPending(initialState);
    if (pendingResult) return pendingResult;

    const lease = await this.dependencies.queue.lease(threadId);
    if (!lease) return { outcome: "idle", threadId };
    const message = lease.message;
    try {
      const state = await this.dependencies.store.loadThread(threadId);
      if (!state) throw new Error(`Unknown thread: ${threadId}`);
      if (state.processedInputIds.includes(message.id)) {
        await lease.ack();
        await this.dependencies.receipts.record({ threadId, inputId: message.id, action: "input_duplicate" });
        return { outcome: "duplicate", threadId, inputId: message.id };
      }
      await this.dependencies.receipts.record({ threadId, inputId: message.id, action: "slice_started", detail: { revision: state.revision } });
      const conversation = await this.dependencies.store.loadConversation(threadId);
      const completion = await this.dependencies.model.complete({ thread: state, conversation, message });
      const toolCalls = [...(completion.toolCalls ?? [])];
      if (toolCalls.length > 1) throw new Error("A bounded slice may dispatch at most one tool call.");
      const normalizedInput = inputEntries(message, state);
      const entries: ConversationEntry[] = [...normalizedInput.entries];
      if (completion.message !== undefined) {
        entries.push({ id: `assistant:${message.id}`, sourceInputId: message.id, role: "assistant", kind: "message", content: completion.message });
      }
      const toolCall = toolCalls[0] ? clone(toolCalls[0]) : null;
      if (toolCall) {
        assertIdentity(toolCall.id, "Tool call ID");
        assertIdentity(toolCall.name, "Tool name");
        entries.push({ id: `tool-call:${toolCall.id}`, sourceInputId: message.id, role: "assistant", kind: "tool_call", toolCall, synthetic: false });
      }
      const committed = await this.dependencies.store.commitSlice({
        threadId,
        expectedRevision: state.revision,
        inputId: message.id,
        entries,
        status: "suspended",
        pendingDispatch: toolCall,
        answeredToolCallIds: normalizedInput.answeredToolCallIds,
        issuedToolCallIds: toolCall ? [toolCall.id] : []
      });
      await lease.ack();
      if (!committed.committed) {
        await this.dependencies.receipts.record({ threadId, inputId: message.id, action: "input_duplicate" });
        return { outcome: "duplicate", threadId, inputId: message.id };
      }
      await this.dependencies.receipts.record({ threadId, inputId: message.id, action: "slice_committed", detail: { revision: committed.state.revision, entries: entries.length } });
      const dispatchResult = await this.#dispatchPending(committed.state);
      if (dispatchResult) return dispatchResult;
      await this.dependencies.receipts.record({ threadId, inputId: message.id, action: "thread_suspended", detail: { waitingFor: toolCall ? "tool_result" : "input" } });
      return { outcome: "suspended", threadId, inputId: message.id, ...(toolCall ? { pendingToolCallId: toolCall.id } : {}) };
    } catch (error) {
      await lease.nack();
      throw error;
    }
  }
}

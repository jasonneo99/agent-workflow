import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ConversationEntry,
  InputLease,
  SliceCommit,
  SliceCommitResult,
  SliceStore,
  ThreadInput,
  ThreadInputQueue,
  ThreadState
} from "./index.js";

interface StoreDocument {
  threads: Record<string, ThreadState>;
  conversations: Record<string, ConversationEntry[]>;
}

interface QueueDocument {
  messages: Record<string, ThreadInput[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return copy(fallback);
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** Serializes local mutations and atomically replaces snapshots. A database-backed
 * queue remains the future multi-process implementation; this adapter proves
 * process restart without keeping a waiting worker alive. */
class JsonDocument<T> {
  #tail = Promise.resolve();

  constructor(readonly path: string, readonly fallback: T) {}

  read(): Promise<T> {
    return this.#exclusive(async () => readJson(this.path, this.fallback));
  }

  update<R>(mutate: (document: T) => R | Promise<R>): Promise<R> {
    return this.#exclusive(async () => {
      const document = await readJson(this.path, this.fallback);
      const result = await mutate(document);
      await atomicWrite(this.path, document);
      return result;
    });
  }

  async #exclusive<R>(operation: () => Promise<R>): Promise<R> {
    const prior = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }
}

export class LocalJsonSliceStore implements SliceStore {
  readonly #document: JsonDocument<StoreDocument>;

  constructor(directory: string) {
    this.#document = new JsonDocument(join(directory, "threads.json"), { threads: {}, conversations: {} });
  }

  createThread(threadId: string, options: { parentThreadId?: string } = {}): Promise<ThreadState> {
    return this.#document.update((document) => {
      const existing = document.threads[threadId];
      if (existing) return copy(existing);
      const state: ThreadState = { threadId, revision: 0, status: "ready", processedInputIds: [], issuedToolCallIds: [], answeredToolCallIds: [], pendingDispatch: null,
        parentThreadId: options.parentThreadId ?? null, childThreadIds: [] };
      document.threads[threadId] = state;
      document.conversations[threadId] = [];
      return copy(state);
    });
  }

  async loadThread(threadId: string): Promise<ThreadState | null> {
    const state = (await this.#document.read()).threads[threadId];
    return state ? copy(state) : null;
  }

  async loadConversation(threadId: string): Promise<readonly ConversationEntry[]> {
    return copy((await this.#document.read()).conversations[threadId] ?? []);
  }

  commitSlice(input: SliceCommit): Promise<SliceCommitResult> {
    return this.#document.update((document) => {
      const state = document.threads[input.threadId];
      if (!state) throw new Error(`Unknown thread: ${input.threadId}`);
      if (state.processedInputIds.includes(input.inputId)) return { committed: false, reason: "duplicate_input", state: copy(state) };
      if (state.revision !== input.expectedRevision) throw new Error(`Stale thread revision for ${input.threadId}.`);
      const next: ThreadState = { ...state, revision: state.revision + 1, status: input.status,
        processedInputIds: [...state.processedInputIds, input.inputId],
        issuedToolCallIds: [...new Set([...state.issuedToolCallIds, ...(input.issuedToolCallIds ?? [])])],
        answeredToolCallIds: [...new Set([...state.answeredToolCallIds, ...(input.answeredToolCallIds ?? [])])],
        pendingDispatch: copy(input.pendingDispatch) };
      document.threads[input.threadId] = next;
      document.conversations[input.threadId] = [...(document.conversations[input.threadId] ?? []), ...copy(input.entries)];
      return { committed: true, state: copy(next) };
    });
  }

  markDispatchStarted(threadId: string, expectedRevision: number, toolCallId: string): Promise<ThreadState> {
    return this.#document.update((document) => {
      const state = document.threads[threadId];
      if (!state || state.revision !== expectedRevision || state.pendingDispatch?.id !== toolCallId) throw new Error("Pending dispatch state changed.");
      const next = { ...state, revision: state.revision + 1, pendingDispatch: null };
      document.threads[threadId] = next;
      return copy(next);
    });
  }

  linkChild(parentThreadId: string, childThreadId: string): Promise<void> {
    return this.#document.update((document) => {
      const parent = document.threads[parentThreadId];
      const child = document.threads[childThreadId];
      if (!parent || !child || child.parentThreadId !== parentThreadId) throw new Error("Invalid parent-child link.");
      if (!parent.childThreadIds.includes(childThreadId)) document.threads[parentThreadId] = { ...parent, revision: parent.revision + 1, childThreadIds: [...parent.childThreadIds, childThreadId] };
    });
  }
}

export class LocalJsonInputQueue implements ThreadInputQueue {
  readonly #document: JsonDocument<QueueDocument>;
  readonly #leased = new Set<string>();

  constructor(directory: string) {
    this.#document = new JsonDocument(join(directory, "queue.json"), { messages: {} });
  }

  enqueue(message: ThreadInput): Promise<void> {
    return this.#document.update((document) => {
      document.messages[message.threadId] = [...(document.messages[message.threadId] ?? []), copy(message)];
    });
  }

  async lease(threadId: string): Promise<InputLease | null> {
    if (this.#leased.has(threadId)) return null;
    const message = (await this.#document.read()).messages[threadId]?.[0];
    if (!message) return null;
    this.#leased.add(threadId);
    let settled = false;
    const settle = async (acknowledge: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        if (acknowledge) await this.#document.update((document) => {
          const current = document.messages[threadId];
          if (current?.[0]?.id === message.id) current.shift();
          if (current?.length === 0) delete document.messages[threadId];
        });
      } finally { this.#leased.delete(threadId); }
    };
    return { message: copy(message), ack: () => settle(true), nack: () => settle(false) };
  }

  async depth(threadId: string): Promise<number> {
    return (await this.#document.read()).messages[threadId]?.length ?? 0;
  }
}

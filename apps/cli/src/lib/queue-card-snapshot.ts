export type QueueCardSnapshot<T> = {
  value: T;
  capturedAt: number;
  ageMs: number;
  refreshing: boolean;
};

type Entry<T> = { value: T; capturedAt: number };

/**
 * Coalesces queue-card reads and serves a bounded prior snapshot while its
 * replacement is loading. Snapshot age is always returned to the caller so a
 * dashboard cannot silently present old queue state as current.
 */
export class QueueCardSnapshotCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #loads = new Map<string, Promise<Entry<T>>>();

  constructor(
    readonly maxAgeMs = 750,
    readonly maxStaleMs = 30_000,
    readonly now: () => number = Date.now
  ) {}

  async get(key: string, load: () => Promise<T>, requestRefresh = false): Promise<QueueCardSnapshot<T>> {
    const current = this.#entries.get(key);
    const ageMs = current ? Math.max(0, this.now() - current.capturedAt) : Number.POSITIVE_INFINITY;
    const shouldRefresh = requestRefresh || !current || ageMs > this.maxAgeMs;
    const pending = shouldRefresh ? this.#refresh(key, load) : this.#loads.get(key);

    if (!current || ageMs > this.maxStaleMs) {
      const next = await (pending ?? this.#refresh(key, load));
      return { value: next.value, capturedAt: next.capturedAt, ageMs: 0, refreshing: false };
    }

    // Refresh in the background, but never hide that the bounded prior value
    // was served. Rejections are observed here and the next request retries.
    if (pending) void pending.catch(() => undefined);
    return { value: current.value, capturedAt: current.capturedAt, ageMs, refreshing: Boolean(pending) };
  }

  #refresh(key: string, load: () => Promise<T>): Promise<Entry<T>> {
    const existing = this.#loads.get(key);
    if (existing) return existing;
    const pending = load().then((value) => {
      const entry = { value, capturedAt: this.now() };
      this.#entries.set(key, entry);
      return entry;
    }).finally(() => this.#loads.delete(key));
    this.#loads.set(key, pending);
    return pending;
  }
}

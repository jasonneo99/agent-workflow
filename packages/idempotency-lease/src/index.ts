import { randomUUID } from "node:crypto";
import { createClient } from "redis";

export interface LeaseStore {
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  renew(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<boolean>;
  close(): Promise<void>;
}

export type LeaseOutcome<T> =
  | { state: "executed"; value: T }
  | { state: "replayed"; value: T };

export function redisLeaseKey(scope: string, idempotencyKey: string): string {
  const safeScope = scope.replace(/[^a-zA-Z0-9:_-]/gu, "_").slice(0, 120);
  const safeKey = idempotencyKey.replace(/[^a-zA-Z0-9:_-]/gu, "_").slice(0, 220);
  return `agentflow:lease:${safeScope}:${safeKey}`;
}

export function createRedisLeaseStore(redisUrl = process.env.REDIS_URL): LeaseStore {
  if (!redisUrl) throw new Error("REDIS_URL is required for distributed idempotency reservations.");
  const client = createClient({ url: redisUrl });
  let connected = false;
  async function ready(): Promise<void> {
    if (!connected) {
      await client.connect();
      connected = true;
    }
  }
  return {
    async acquire(key, owner, ttlMs) {
      await ready();
      return (await client.set(key, owner, { NX: true, PX: ttlMs })) === "OK";
    },
    async release(key, owner) {
      await ready();
      const removed = await client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [owner] }
      );
      return Number(removed) === 1;
    },
    async renew(key, owner, ttlMs) {
      await ready();
      const renewed = await client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        { keys: [key], arguments: [owner, String(ttlMs)] }
      );
      return Number(renewed) === 1;
    },
    async close() {
      if (connected && client.isOpen) await client.quit();
      connected = false;
    }
  };
}

export async function withIdempotencyLease<T>(input: {
  store: LeaseStore;
  key: string;
  execute: () => Promise<T>;
  findCompleted: () => Promise<T | null>;
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
}): Promise<LeaseOutcome<T>> {
  const ttlMs = Math.max(1_000, input.ttlMs ?? 60_000);
  const waitMs = Math.max(0, input.waitMs ?? 15_000);
  const pollMs = Math.max(10, input.pollMs ?? 100);
  const owner = randomUUID();
  const deadline = Date.now() + waitMs;

  while (true) {
    const completed = await input.findCompleted();
    if (completed !== null) return { state: "replayed", value: completed };
    if (await input.store.acquire(input.key, owner, ttlMs)) {
      const heartbeat = setInterval(() => {
        void input.store.renew(input.key, owner, ttlMs).catch(() => false);
      }, Math.max(250, Math.floor(ttlMs / 3)));
      heartbeat.unref();
      try {
        const afterAcquire = await input.findCompleted();
        if (afterAcquire !== null) return { state: "replayed", value: afterAcquire };
        return { state: "executed", value: await input.execute() };
      } finally {
        clearInterval(heartbeat);
        await input.store.release(input.key, owner);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for idempotency reservation ${input.key}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

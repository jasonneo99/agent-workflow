import type pg from 'pg';

/** Serialize migrators; short DDL waits break lock cycles with ordinary clients. */
export async function coordinatedSchemaMigration<T>(client: pg.Client, apply: (client: pg.Client) => Promise<T>): Promise<T> {
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 30_000;
  let locked = false;
  const prior = (await client.query('show lock_timeout')).rows[0].lock_timeout as string;
  try {
    while (!locked) {
      locked = (await client.query('select pg_try_advisory_lock(109512, 1) as locked')).rows[0].locked === true;
      if (!locked) {
        if (Date.now() >= deadline) throw new Error('Schema migration coordinator is busy; retry after the active migrator finishes.');
        await pause(100);
      }
    }
    await client.query("select set_config('lock_timeout', '250ms', false)");
    const guarded = new Proxy(client, {
      get(target, key) {
        if (key !== 'query') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
        return async (...args: Parameters<pg.Client['query']>) => {
          for (let attempt = 0; ; attempt++) {
            try { return await (target.query as Function).apply(target, args); }
            catch (error) {
              const code = (error as {code?: string}).code;
              // Only idempotent migration statements use this client, in autocommit mode.
              if (!['40P01', '55P03'].includes(code ?? '') || attempt >= 7) throw error;
              await pause(Math.min(200, 25 * (attempt + 1)));
            }
          }
        };
      }
    });
    return await apply(guarded);
  } finally {
    try { await client.query("select set_config('lock_timeout', $1, false)", [prior]); }
    finally { if (locked) await client.query('select pg_advisory_unlock(109512, 1)'); }
  }
}

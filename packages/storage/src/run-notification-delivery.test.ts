import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl, markRunNotificationDelivered } from "./postgres.js";

test("failed notification transport has no delivery timestamp and cannot erase delivered evidence", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query("create temporary table run_notifications (id uuid primary key, status text, delivered_at timestamptz)");
    const isolated = Object.assign(client, { release() {} });
    pg.Pool.prototype.connect = (async () => isolated) as unknown as typeof originalConnect;
    const id = "00000000-0000-4000-8000-000000000001";
    await client.query("insert into run_notifications values ($1,'pending',null)", [id]);
    await markRunNotificationDelivered(id, false);
    assert.deepEqual((await client.query("select status, delivered_at from run_notifications")).rows,
      [{ status: "failed", delivered_at: null }]);
    await markRunNotificationDelivered(id, true);
    const delivered = (await client.query("select status, delivered_at from run_notifications")).rows;
    assert.equal(delivered[0].status, "delivered");
    assert.ok(delivered[0].delivered_at instanceof Date);
    await markRunNotificationDelivered(id, false);
    await markRunNotificationDelivered(id, true);
    assert.deepEqual((await client.query("select status, delivered_at from run_notifications")).rows, delivered,
      "late failed or duplicate attempts must preserve the first successful transport evidence");
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end();
  }
});

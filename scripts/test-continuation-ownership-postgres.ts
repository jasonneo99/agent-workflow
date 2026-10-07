/** Isolated reproduction; never inserts into the configured database. */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { migrateStorage } from "../packages/storage/src/postgres.js";

const configured = databaseUrl();
const name = `agentflow_ownership_test_${randomUUID().replaceAll("-", "")}`;
assert.match(name, /^agentflow_ownership_test_[a-f0-9]{32}$/);
const disposable = new URL(configured);
disposable.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: configured });
let created = false;
let client: pg.Client | undefined;
try {
  // Resolve the installed compiler before creating any fixture database.
  const compiler = fileURLToPath(import.meta.resolve("typescript/lib/tsc.js"));
  await readFile(compiler);
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  process.env.DATABASE_URL = disposable.href;
  client = new pg.Client({ connectionString: disposable.href });
  await client.connect();
  await client.query(await readFile(new URL("../infra/init.sql", import.meta.url), "utf8"));
  await migrateStorage();
  const env = { ...process.env, AGENTFLOW_OWNERSHIP_COMPILER: compiler };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--test", fileURLToPath(new URL("./continuation-ownership-worker-fixture.ts", import.meta.url))], { env, encoding: "utf8", timeout: 100_000 });
  console.log(child.stdout);
  console.error(child.stderr);
  assert.equal(child.signal, null, "Harness interruption is not reproduction evidence");
  assert.equal(child.status, 0, "Inspect CONTINUATION_OWNERSHIP_OBSERVATION; only the exact ownership assertion establishes red");
} finally {
  await client?.end();
  if (created) {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    assert.equal((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount, 0);
  }
  await admin.end();
  process.env.DATABASE_URL = configured;
  console.log(JSON.stringify({ kind: "continuation_ownership_cleanup", created, removed: created }));
}

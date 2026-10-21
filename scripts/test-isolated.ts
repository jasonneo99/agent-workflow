/** Disposable full-suite database; never runs tests against the configured database. */
import "./test-environment.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { migrateStorage } from "../packages/storage/src/postgres.js";

const configured = databaseUrl();
const name = `agentflow_suite_test_${randomUUID().replaceAll("-", "")}`;
assert.match(name, /^agentflow_suite_test_[a-f0-9]{32}$/u);
const target = new URL(configured);
assert.notEqual(target.pathname, `/${name}`);
target.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 5000 });
let created = false;
let fixture: pg.Client | undefined;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  created = true;
  process.env.DATABASE_URL = target.href;
  process.env.TEST_DATABASE_URL = target.href;
  fixture = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 5000 });
  await fixture.connect();
  assert.equal((await fixture.query("SELECT current_database() AS name")).rows[0].name, name);
  await fixture.query(await readFile(new URL("../infra/init.sql", import.meta.url), "utf8"));
  await migrateStorage();
  console.log(JSON.stringify({ kind: "isolated_test_database", database: name, configuredDatabaseUsedForTests: false }));
  const child = spawn(process.execPath, ["--import", "./scripts/test-environment.mjs", "--import", "tsx", "--test", "--test-concurrency=4", "packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/test-environment.test.ts"], { stdio: "inherit", env: process.env });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
} finally {
  await fixture?.end();
  if (created) {
    // Only the exact UUID-named database created by this invocation is removable.
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount, 0);
    console.log(JSON.stringify({ kind: "isolated_test_cleanup", database: name, removed: true }));
  }
  await admin.end();
}

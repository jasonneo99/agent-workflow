/** Disposable full-suite database; never runs tests against the configured database. */
import "./test-environment.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { migrateStorage } from "../packages/storage/src/postgres.js";
import { probePostgresFixtureReadiness } from './postgres-fixture-readiness.js';
import { postgresFixtureSummary, writePostgresFixtureEvidence } from './postgres-fixture-evidence.js';

const configured = databaseUrl();
const name = `agentflow_suite_test_${randomUUID().replaceAll("-", "")}`;
assert.match(name, /^agentflow_suite_test_[a-f0-9]{32}$/u);
const target = new URL(configured);
assert.notEqual(target.pathname, `/${name}`);
target.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 5000 });
let created = false;
let fixture: pg.Client | undefined;
let latestReadiness: Awaited<ReturnType<typeof probePostgresFixtureReadiness>> | null = null;
const persistEvidence = async (phase: 'preflight' | 'fixture' | 'cleanup', report: Awaited<ReturnType<typeof probePostgresFixtureReadiness>>, failure?: unknown) => {
  try { await writePostgresFixtureEvidence({ directory: process.env.AGENTFLOW_TEST_EVIDENCE_DIR, phase, report, failure }); }
  catch (error) { console.error(`PostgreSQL fixture evidence write failed: ${error instanceof Error ? error.message : String(error)}`); }
};
try {
  const configuredHost = new URL(configured).hostname;
  const preflight = await probePostgresFixtureReadiness({ connectionString: configured, inspectProjectContainer: ['127.0.0.1', 'localhost', '::1'].includes(configuredHost) });
  latestReadiness = preflight;
  console.log(JSON.stringify({ kind: 'isolated_postgres_preflight', ...preflight }));
  console.error(postgresFixtureSummary('preflight', preflight));
  await persistEvidence('preflight', preflight);
  if (!preflight.ready) throw new Error(`Isolated PostgreSQL fixture is not transaction-ready at ${preflight.endpoint}; inspect isolated_postgres_preflight evidence.`);
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
  const fixtureReadiness = await probePostgresFixtureReadiness({ connectionString: target.href, requiredRelations: ['workflow_runs', 'workflow_tasks', 'action_receipts'] });
  latestReadiness = fixtureReadiness;
  console.log(JSON.stringify({ kind: 'isolated_postgres_fixture_readiness', ...fixtureReadiness }));
  console.error(postgresFixtureSummary('fixture', fixtureReadiness));
  await persistEvidence('fixture', fixtureReadiness);
  if (!fixtureReadiness.ready) throw new Error(`Disposable PostgreSQL fixture failed schema readiness at ${fixtureReadiness.endpoint}.`);
  console.log(JSON.stringify({ kind: "isolated_test_database", database: name, configuredDatabaseUsedForTests: false }));
  const requestedTests = process.argv.slice(2);
  const testFiles = requestedTests.length ? requestedTests : ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/test-environment.test.ts"];
  const child = spawn(process.execPath, ["--import", "./scripts/test-environment.mjs", "--import", "tsx", "--test", "--test-concurrency=4", ...testFiles], { stdio: "inherit", env: process.env });
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
  let cleanupError: unknown;
  if (created) {
    try {
      // Only the exact UUID-named database created by this invocation is removable.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount, 0);
      console.log(JSON.stringify({ kind: "isolated_test_cleanup", database: name, removed: true }));
    } catch (error) {
      cleanupError = error;
      const base = latestReadiness ?? await probePostgresFixtureReadiness({ connectionString: configured });
      const cleanupReport = { ...base, ready: false, schemaReadiness: { status: 'fail' as const, detail: `Disposable database cleanup failed: ${error instanceof Error ? error.message : String(error)}`, code: 'cleanup-failed' }, acceptance: 'not-verified' as const };
      console.error(postgresFixtureSummary('cleanup', cleanupReport));
      await persistEvidence('cleanup', cleanupReport, error);
    }
  }
  await admin.end();
  if (cleanupError) throw cleanupError;
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { postgresFixtureSummary, writePostgresFixtureEvidence } from './postgres-fixture-evidence.js';
import type { PostgresFixtureReadiness } from './postgres-fixture-readiness.js';

const report: PostgresFixtureReadiness = {
  ready: false, endpoint: 'localhost:15432/agentflow',
  portOwnership: { status: 'pass', detail: 'accepted' },
  protocolHandshake: { status: 'pass', detail: 'postgres' },
  containerHealth: { status: 'unknown', detail: 'password=private' },
  authentication: { status: 'fail', detail: 'postgres://user:private@localhost rejected', code: '28P01' },
  schemaReadiness: { status: 'unknown', detail: 'token=private' },
  missingRelations: [], diagnosticLogs: ['secret=private', ...Array.from({ length: 45 }, (_, index) => `line ${index}`)], acceptance: 'not-verified',
};

test('fixture evidence is credential-redacted, bounded, stable and private', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-pg-evidence-'));
  try {
    const file = await writePostgresFixtureEvidence({ directory, phase: 'preflight', report, failure: new Error('password=private'), generatedAt: '2026-10-29T00:00:00Z' });
    assert.ok(file);
    const raw = await fs.readFile(file!, 'utf8');
    const value = JSON.parse(raw);
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.retention.suggestedDays, 14);
    assert.equal(value.retention.containsCredentials, false);
    assert.equal(value.report.diagnosticLogs.length, 40);
    assert.doesNotMatch(raw, /private/u);
    assert.equal((await fs.stat(file!)).mode & 0o777, 0o600);
    assert.equal(postgresFixtureSummary('preflight', report), 'PostgreSQL fixture preflight: NOT READY; failed=auth; unknown=container,schema; acceptance=not-verified.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('fixture evidence is opt-in and cannot change readiness', async () => {
  assert.equal(await writePostgresFixtureEvidence({ phase: 'fixture', report }), null);
  assert.equal(report.ready, false);
  assert.equal(report.acceptance, 'not-verified');
});

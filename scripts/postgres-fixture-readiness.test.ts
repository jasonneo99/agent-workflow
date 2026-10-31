import assert from 'node:assert/strict';
import test from 'node:test';
import { probePostgresFixtureReadiness, type PostgresFixtureProbeDependencies } from './postgres-fixture-readiness.js';

const passNetwork: Pick<PostgresFixtureProbeDependencies, 'tcp' | 'protocol'> = {
  tcp: async () => ({ status: 'pass', detail: 'tcp' }),
  protocol: async () => ({ status: 'pass', detail: 'postgres' }),
};

test('fixture probe distinguishes TCP ownership from PostgreSQL protocol failure', async () => {
  const report = await probePostgresFixtureReadiness({ connectionString: 'postgres://user:secret@127.0.0.1:15432/db', dependencies: { tcp: passNetwork.tcp, protocol: async () => ({ status: 'fail', detail: 'wrong service', code: 'protocol-mismatch' }) } });
  assert.equal(report.portOwnership.status, 'pass');
  assert.equal(report.protocolHandshake.status, 'fail');
  assert.equal(report.authentication.status, 'unknown');
  assert.equal(report.ready, false);
  assert.ok(!JSON.stringify(report).includes('secret'));
});

test('fixture probe classifies credential rejection independently from schema readiness', async () => {
  const report = await probePostgresFixtureReadiness({ connectionString: 'postgres://user:secret@localhost/db', dependencies: { ...passNetwork, client: () => ({ connect: async () => { throw Object.assign(new Error('password rejected'), { code: '28P01' }); }, query: async () => ({ rows: [] }), end: async () => {} }) } });
  assert.equal(report.authentication.code, 'credential-rejected');
  assert.equal(report.schemaReadiness.status, 'unknown');
  assert.equal(report.acceptance, 'not-verified');
});

test('fixture probe requires real query success and reports missing schema separately', async () => {
  const queries: string[] = [];
  const report = await probePostgresFixtureReadiness({ connectionString: 'postgres://user:secret@localhost/db', requiredRelations: ['workflow_runs', 'action_receipts'], dependencies: { ...passNetwork, container: async () => ({ layer: { status: 'pass', detail: 'healthy' }, logs: ['ready for connections'] }), client: () => ({ connect: async () => {}, query: async text => { queries.push(text); return text.includes('to_regclass') ? { rows: [{ name: 'workflow_runs', relation: 'workflow_runs' }, { name: 'action_receipts', relation: null }] } : { rows: [{ transaction_probe: 1 }] }; }, end: async () => {} }) } , inspectProjectContainer: true });
  assert.equal(report.authentication.status, 'pass');
  assert.equal(report.schemaReadiness.code, 'schema-missing');
  assert.deepEqual(report.missingRelations, ['action_receipts']);
  assert.equal(report.ready, false);
  assert.deepEqual(queries, ['begin read only', 'select name, to_regclass(name)::text as relation from unnest($1::text[]) name', 'select 1 as transaction_probe', 'rollback']);
  assert.deepEqual(report.diagnosticLogs, ['ready for connections']);
});

test('fixture probe grants transaction verification only after every required layer passes', async () => {
  const report = await probePostgresFixtureReadiness({ connectionString: 'postgres://user:secret@localhost/db', requiredRelations: ['workflow_runs'], inspectProjectContainer: true, dependencies: { ...passNetwork, container: async () => ({ layer: { status: 'pass', detail: 'healthy' }, logs: [] }), client: () => ({ connect: async () => {}, query: async text => ({ rows: text.includes('to_regclass') ? [{ name: 'workflow_runs', relation: 'workflow_runs' }] : [{ transaction_probe: 1 }] }), end: async () => {} }) } });
  assert.equal(report.ready, true);
  assert.equal(report.acceptance, 'transaction-verified');
});

test('fixture probe never starts, restarts, stops or mutates the primary runtime', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./postgres-fixture-readiness.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /docker[^\n]+\b(?:up|start|restart|stop|down|rm)\b/iu);
  assert.match(source, /logs', '--no-color', '--tail', '40'/u);
});
